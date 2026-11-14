//! Capture search for "linear" patterns: anchored at the start (`^`) and
//! made of literals, character classes, greedy repetitions of one
//! character, optional groups, capture groups and `$`, like
//! `^https?://(?:www\.)?([^/]+)/`. Such a pattern runs as a short program
//! over the text, backtracking in the order the `regex` crate prefers
//! matches (greedy first), so it finds the same match and groups, at a
//! fraction of the cost of the crate's capture engines.
//!
//! A search that backtracks more than a few steps per byte gives up
//! ([`Overrun`]): the caller then asks the `regex` crate.

use regex_syntax::hir::{Class, Hir, HirKind, Look};

const NONE: usize = usize::MAX;

/// A set of characters: a bitmap for ASCII, ranges for the rest.
#[derive(Debug)]
struct CharSet {
    ascii: [u64; 2],
    wide: Vec<(char, char)>,
}

impl CharSet {
    fn new() -> Self {
        Self { ascii: [0; 2], wide: vec![] }
    }

    fn of(class: &Class) -> Option<Self> {
        let mut s = Self::new();
        match class {
            Class::Unicode(c) => c.ranges().iter().for_each(|r| s.add(r.start(), r.end())),
            // bytes past ASCII are not characters
            Class::Bytes(c) if c.is_ascii() => c.ranges().iter().for_each(|r| s.add(r.start() as char, r.end() as char)),
            Class::Bytes(_) => return None,
        }
        Some(s)
    }

    fn add(&mut self, lo: char, hi: char) {
        for b in lo as u32..=(hi as u32).min(127) {
            self.ascii[(b >> 6) as usize] |= 1 << (b & 63);
        }
        if hi as u32 > 127 {
            self.wide.push((lo.max('\u{80}'), hi));
        }
    }

    /// The bytes of the character at `at` (a character boundary) when it is in the set.
    #[inline]
    fn eat(&self, text: &str, at: usize) -> Option<usize> {
        let b = *text.as_bytes().get(at)?;
        if b < 128 {
            return (self.ascii[(b >> 6) as usize] >> (b & 63) & 1 == 1).then_some(1);
        }
        let c = text[at..].chars().next()?;
        use std::cmp::Ordering::*;
        // sorted, as the class's ranges are
        let found = self.wide.binary_search_by(|&(lo, hi)| if c < lo { Greater } else if c > hi { Less } else { Equal });
        found.is_ok().then_some(c.len_utf8())
    }
}

/// How an unbounded repetition finds where its run of characters ends.
#[derive(Debug)]
enum Scan {
    /// character by character (bounded repetitions, sets that split the
    /// characters past ASCII)
    Chars,
    /// at the first byte equal to this one, the only one not in the set (`[^/]*`)
    Until(u8),
    /// at the first byte whose entry is false: the bytes of the characters
    /// past ASCII are all in the set, or none is
    Bytes(Box<[bool; 256]>),
}

impl Scan {
    fn of(set: &CharSet, min: u32, max: u32) -> Self {
        // the set holds every character past ASCII, or none
        let all = {
            let mut next = 0x80;
            for &(lo, hi) in &set.wide {
                // the surrogates are not characters
                if lo as u32 > next && !(next == 0xD800 && lo as u32 == 0xE000) {
                    next = u32::MAX;
                    break;
                }
                next = hi as u32 + 1;
            }
            next == 0x110000
        };
        if min > 1 || max != u32::MAX || !(all || set.wide.is_empty()) {
            return Scan::Chars;
        }
        let mut table = Box::new([all; 256]);
        for b in 0..128 {
            table[b] = set.ascii[b >> 6] >> (b & 63) & 1 == 1;
        }
        let mut out = (0..=255u8).filter(|&b| !table[b as usize]);
        match (out.next(), out.next()) {
            (Some(b), None) => Scan::Until(b),
            _ => Scan::Bytes(table),
        }
    }
}

#[derive(Debug)]
enum Op {
    Lit(Box<[u8]>),
    /// `min` to `max` characters of the set, as many as possible first
    Loop { set: CharSet, min: u32, max: u32, scan: Scan },
    /// what follows first, then the program from `alt` on (an optional group)
    Split(usize),
    /// the position goes to a capture slot
    Save(usize),
    End,
}

#[derive(Debug)]
pub struct Linear {
    ops: Vec<Op>,
    slots: usize,
}

/// The search backtracked too much for this matcher.
#[derive(Debug)]
pub struct Overrun;

enum Frame {
    /// an optional group to skip
    Alt { pc: usize, at: usize },
    /// a repetition that ended at `cur` and may give characters back down to `lo`
    Give { pc: usize, lo: usize, cur: usize },
    /// a capture slot to restore
    Slot { slot: usize, old: usize },
}

/// The state of a search, reused from text to text.
#[derive(Default)]
pub struct Run {
    slots: Vec<usize>,
    stack: Vec<Frame>,
}

impl Run {
    /// A group's span in the last match.
    pub fn group(&self, g: usize) -> Option<(usize, usize)> {
        match (self.slots.get(2 * g), self.slots.get(2 * g + 1)) {
            (Some(&a), Some(&b)) if a != NONE && b != NONE => Some((a, b)),
            _ => None,
        }
    }
}

/// The set of a pattern that matches exactly one character.
fn one_char(h: &Hir) -> Option<CharSet> {
    match h.kind() {
        HirKind::Class(c) => CharSet::of(c),
        HirKind::Literal(l) => {
            let mut chars = std::str::from_utf8(&l.0).ok()?.chars();
            let c = chars.next()?;
            chars.next().is_none().then(|| {
                let mut s = CharSet::new();
                s.add(c, c);
                s
            })
        }
        _ => None,
    }
}

fn emit(h: &Hir, ops: &mut Vec<Op>) -> Option<()> {
    match h.kind() {
        HirKind::Empty => {}
        HirKind::Literal(l) => {
            std::str::from_utf8(&l.0).ok()?;
            ops.push(Op::Lit(l.0.clone()));
        }
        HirKind::Class(c) => ops.push(Op::Loop { set: CharSet::of(c)?, min: 1, max: 1, scan: Scan::Chars }),
        HirKind::Look(Look::End) => ops.push(Op::End),
        HirKind::Capture(c) => {
            ops.push(Op::Save(2 * c.index as usize));
            emit(&c.sub, ops)?;
            ops.push(Op::Save(2 * c.index as usize + 1));
        }
        HirKind::Concat(parts) => {
            for p in parts {
                emit(p, ops)?;
            }
        }
        HirKind::Repetition(r) if r.greedy => {
            let max = r.max.unwrap_or(u32::MAX);
            match one_char(&r.sub) {
                Some(set) => ops.push(Op::Loop { scan: Scan::of(&set, r.min, max), set, min: r.min, max }),
                None if r.min == 0 && max == 1 => {
                    let split = ops.len();
                    ops.push(Op::Split(0));
                    emit(&r.sub, ops)?;
                    ops[split] = Op::Split(ops.len());
                }
                None => return None,
            }
        }
        // alternations, lazy repetitions, other anchors and word boundaries
        _ => return None,
    }
    Some(())
}

impl Linear {
    /// The program of a pattern with `groups` capture groups (the whole
    /// match included); None when the pattern is not linear.
    pub fn compile(hir: &Hir, groups: usize) -> Option<Self> {
        let HirKind::Concat(parts) = hir.kind() else { return None };
        if !matches!(parts.first()?.kind(), HirKind::Look(Look::Start)) {
            return None;
        }
        let mut ops = vec![];
        for p in &parts[1..] {
            emit(p, &mut ops)?;
        }
        Some(Self { ops, slots: 2 * groups })
    }

    /// Where the match of `text` ends (it starts at 0); its groups are in `run`.
    pub fn find(&self, text: &str, run: &mut Run) -> Result<Option<usize>, Overrun> {
        let bytes = text.as_bytes();
        run.slots.clear();
        run.slots.resize(self.slots, NONE);
        run.stack.clear();
        let mut budget = 64 + 16 * bytes.len();
        let (mut pc, mut at) = (0, 0);
        loop {
            // forward, until an operation fails
            loop {
                let Some(op) = self.ops.get(pc) else { return Ok(Some(at)) };
                if budget == 0 {
                    return Err(Overrun);
                }
                budget -= 1;
                match op {
                    Op::Lit(l) => {
                        if !bytes[at..].starts_with(l) {
                            break;
                        }
                        at += l.len();
                    }
                    Op::Loop { set, min, max, scan } => {
                        // `lo`: where the fewest characters it may keep end
                        let (mut n, mut end, mut lo) = (0, at, at);
                        if let Scan::Chars = scan {
                            while n < *max {
                                let Some(width) = set.eat(text, end) else { break };
                                end += width;
                                n += 1;
                                if n == *min {
                                    lo = end;
                                }
                            }
                        } else {
                            // at most one character is owed: the run's bytes say the rest
                            let rest = &bytes[at..];
                            let run = match scan {
                                Scan::Until(b) => memchr::memchr(*b, rest),
                                Scan::Bytes(table) => rest.iter().position(|&b| !table[b as usize]),
                                Scan::Chars => unreachable!(),
                            };
                            end = at + run.unwrap_or(rest.len());
                            n = (end > at) as u32;
                            if *min == 1 && n == 1 {
                                lo = at + text[at..].chars().next().map_or(1, char::len_utf8);
                            }
                        }
                        if n < *min {
                            break;
                        }
                        budget = budget.saturating_sub(end - at);
                        if end > lo {
                            run.stack.push(Frame::Give { pc: pc + 1, lo, cur: end });
                        }
                        at = end;
                    }
                    Op::Split(alt) => run.stack.push(Frame::Alt { pc: *alt, at }),
                    Op::Save(slot) => {
                        run.stack.push(Frame::Slot { slot: *slot, old: run.slots[*slot] });
                        run.slots[*slot] = at;
                    }
                    Op::End => {
                        if at != bytes.len() {
                            break;
                        }
                    }
                }
                pc += 1;
            }
            // back to the last choice
            loop {
                match run.stack.pop() {
                    None => return Ok(None),
                    Some(Frame::Slot { slot, old }) => run.slots[slot] = old,
                    Some(Frame::Alt { pc: p, at: a }) => {
                        (pc, at) = (p, a);
                        break;
                    }
                    Some(Frame::Give { pc: p, lo, cur }) => {
                        let mut c = cur - 1;
                        while !text.is_char_boundary(c) {
                            c -= 1;
                        }
                        if c > lo {
                            run.stack.push(Frame::Give { pc: p, lo, cur: c });
                        }
                        (pc, at) = (p, c);
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linear(pat: &str) -> Option<(Linear, regex::Regex)> {
        let re = regex::Regex::new(pat).unwrap();
        let hir = regex_syntax::parse(pat).unwrap();
        Linear::compile(&hir, re.captures_len()).map(|l| (l, re))
    }

    /// The same match and groups as the `regex` crate, on texts that take
    /// every path: optional groups taken and skipped, repetitions giving
    /// characters back, characters of several bytes.
    #[test]
    fn finds_what_the_regex_crate_finds() {
        let texts = [
            "",
            "http://a.com/",
            "https://www.a.com/x/y",
            "http://www./",
            "http://www.x",
            "https://wwwx.org/p",
            "ftp://a.com/",
            "http:/a.com/",
            "aaa",
            "aaab",
            "ab12-cd",
            "abc",
            "aé/b",
            "ééé/",
            "http://é.com/ü",
            "x=1;y=22;",
            "x=;y=22;",
            "   padded",
            "2024-01-31T10:00",
            "a\nb",
        ];
        let patterns = [
            r"^https?://(?:www\.)?([^/]+)/",
            r"^https?://(?:www\.)?([^/]+)",
            r"^(\w+)://([^/:]+)(:\d+)?/",
            r"^a*a*b",
            r"^(a+)(a*)",
            r"^(a*)(a+)$",
            r"^([a-z]+)(\d{1,2})?-?(\w*)$",
            r"^[^/]*/",
            r"^(é+)/",
            r"^.{2,3}",
            r"^x=(\d*);y=(\d+);$",
            r"^\s*(\S+)",
            r"^(\d{4})-(\d\d)-(\d\d)",
            r"^(?i)HTTP(s)?:",
            r"^(a)?(b)?(c)?$",
            r"^([^/]*)/([a-z0-9.]+)",
            r"^[^é]+(é*)",
            r"^\w+",
            r"^([^=]*)=(.*)",
            r"^a.b",
            r"^(?s)a.b",
        ];
        for pat in patterns {
            let (lin, re) = linear(pat).unwrap_or_else(|| panic!("{pat} is linear"));
            let mut run = Run::default();
            let mut locs = re.capture_locations();
            for t in texts {
                let want = re.captures_read(&mut locs, t).map(|m| (m.end(), (1..locs.len()).map(|g| locs.get(g)).collect::<Vec<_>>()));
                let got = lin.find(t, &mut run).unwrap().map(|end| (end, (1..locs.len()).map(|g| run.group(g)).collect::<Vec<_>>()));
                assert_eq!(got, want, "{pat:?} on {t:?}");
            }
        }
    }

    #[test]
    fn other_patterns_are_left_to_the_regex_crate() {
        for pat in [r"a+", r"^(ab|cd)e", r"^a+?b", r"^(ab)+", r"^a\b", r"(?m)^a", r"^a^b", r"^(?-u:\xFF)?a"] {
            assert!(regex::Regex::new(pat).is_err() || linear(pat).is_none(), "{pat}");
        }
    }

    #[test]
    fn a_search_that_backtracks_too_much_gives_up() {
        let (lin, _) = linear(r"^a*a*a*a*a*b").unwrap();
        let text = "a".repeat(200);
        assert!(lin.find(&text, &mut Run::default()).is_err());
    }
}
