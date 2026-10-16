//! Keys to dense ids: open addressing with linear probing over packed
//! `(key, id + 1)` slots (`0`: empty), at most three quarters full, so a
//! lookup is about one cache line. Callers probe large tables a batch at a
//! time, prefetching the slots of rows a few positions ahead so their cache
//! misses overlap.

/// Rows ahead of the probed one whose slot is prefetched.
pub const PREFETCH_AHEAD: usize = 16;
/// Tables beyond this size are probed with prefetching; smaller ones stay
/// in cache, where hashing a batch ahead and prefetching only cost time.
pub const LARGE_BYTES: usize = 256 << 10;

#[inline(always)]
pub fn prefetch<T>(p: *const T) {
    #[cfg(target_arch = "x86_64")]
    // SAFETY: a prefetch is a hint; it never faults
    unsafe {
        core::arch::x86_64::_mm_prefetch(p as *const i8, core::arch::x86_64::_MM_HINT_T0)
    }
    #[cfg(not(target_arch = "x86_64"))]
    let _ = p;
}

#[repr(C, packed)]
#[derive(Clone, Copy)]
struct Slot<K: Copy> {
    key: K,
    /// id + 1; 0: empty
    id: u32,
}

pub struct IdTable<K: Copy> {
    slots: Vec<Slot<K>>,
    mask: usize,
    len: usize,
}

impl<K: Copy + Default> IdTable<K> {
    pub fn new() -> Self {
        Self::with_slots(256)
    }

    fn with_slots(n: usize) -> Self {
        Self { slots: Self::empty(n), mask: n - 1, len: 0 }
    }

    fn empty(n: usize) -> Vec<Slot<K>> {
        vec![Slot { key: K::default(), id: 0 }; n]
    }

    /// Slots for `n` keys at most three quarters full.
    fn slots_for(n: usize) -> usize {
        (n * 4 / 3 + 1).next_power_of_two()
    }

    /// Pre-size for `n` keys in total.
    pub fn reserve(&mut self, n: usize, hash: impl Fn(&K) -> u64) {
        if Self::slots_for(n) > self.slots.len() {
            self.rehash(Self::slots_for(n), hash);
        }
    }

    fn rehash(&mut self, n: usize, hash: impl Fn(&K) -> u64) {
        let old = std::mem::replace(&mut self.slots, Self::empty(n));
        self.mask = n - 1;
        for s in old {
            if s.id != 0 {
                let key = s.key;
                let mut i = hash(&key) as usize & self.mask;
                while self.slots[i].id != 0 {
                    i = (i + 1) & self.mask;
                }
                self.slots[i] = s;
            }
        }
    }

    /// Large enough for prefetching to pay off.
    pub fn large(&self) -> bool {
        self.slots.len() * std::mem::size_of::<Slot<K>>() > LARGE_BYTES
    }

    #[inline(always)]
    pub fn prefetch(&self, h: u64) {
        prefetch(self.slots.as_ptr().wrapping_add(h as usize & self.mask));
    }

    /// The id of the key hashing to `h` for which `eq(key, id)` holds, or
    /// the empty slot where such a key belongs.
    #[inline(always)]
    pub fn find(&self, h: u64, eq: impl Fn(&K, u32) -> bool) -> Result<u32, usize> {
        let mut i = h as usize & self.mask;
        loop {
            // SAFETY: i is masked to the table size
            let s = unsafe { *self.slots.get_unchecked(i) };
            if s.id == 0 {
                return Err(i);
            }
            let key = s.key;
            if eq(&key, s.id - 1) {
                return Ok(s.id - 1);
            }
            i = (i + 1) & self.mask;
        }
    }

    /// Insert a key at the slot [`Self::find`] returned for it.
    #[inline(always)]
    pub fn insert(&mut self, mut slot: usize, h: u64, key: K, id: u32, hash: impl Fn(&K) -> u64) {
        if (self.len + 1) * 4 > self.slots.len() * 3 {
            self.rehash(self.slots.len() * 2, hash);
            slot = h as usize & self.mask;
            while self.slots[slot].id != 0 {
                slot = (slot + 1) & self.mask;
            }
        }
        self.slots[slot] = Slot { key, id: id + 1 };
        self.len += 1;
    }
}
