//! File names of `_delta_log/`: commits, checkpoints (single and multi-part)
//! and the `_last_checkpoint` pointer.

use serde::{Deserialize, Serialize};

pub const LOG_DIR: &str = "_delta_log";
pub const LAST_CHECKPOINT: &str = "_last_checkpoint";

/// `00000000000000000007.json`
pub fn commit_file_name(version: u64) -> String {
    format!("{version:020}.json")
}

/// `00000000000000000010.checkpoint.parquet`
pub fn checkpoint_file_name(version: u64) -> String {
    format!("{version:020}.checkpoint.parquet")
}

/// `00000000000000000010.checkpoint.0000000001.0000000003.parquet` (`part` counts from 1).
pub fn multipart_checkpoint_file_name(version: u64, part: u32, parts: u32) -> String {
    format!("{version:020}.checkpoint.{part:010}.{parts:010}.parquet")
}

/// The names of all `parts` files of a multi-part checkpoint.
pub fn multipart_checkpoint_file_names(version: u64, parts: u32) -> Vec<String> {
    (1..=parts).map(|p| multipart_checkpoint_file_name(version, p, parts)).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LogFileKind {
    /// `_last_checkpoint` (version 0 in listings)
    LastCheckpoint,
    Commit,
    Checkpoint,
    /// `part` of `parts`, counting from 1
    MultiPartCheckpoint { part: u32, parts: u32 },
}

impl LogFileKind {
    pub fn is_checkpoint(&self) -> bool {
        matches!(self, LogFileKind::Checkpoint | LogFileKind::MultiPartCheckpoint { .. })
    }
}

/// What a file name in the log directory is; `None` for anything else
/// (checksums, compacted commits, v2 checkpoints, staged commits, ...).
pub fn parse_file_name(name: &str) -> Option<(u64, LogFileKind)> {
    if name == LAST_CHECKPOINT {
        return Some((0, LogFileKind::LastCheckpoint));
    }
    let (version, rest) = name.split_once('.')?;
    let version = digits(version)?;
    match rest {
        "json" => Some((version, LogFileKind::Commit)),
        "checkpoint.parquet" => Some((version, LogFileKind::Checkpoint)),
        _ => {
            let mut it = rest.strip_prefix("checkpoint.")?.strip_suffix(".parquet")?.split('.');
            let (part, parts) = (digits(it.next()?)?, digits(it.next()?)?);
            if it.next().is_some() || part == 0 || part > parts || parts > u32::MAX as u64 {
                return None;
            }
            Some((version, LogFileKind::MultiPartCheckpoint { part: part as u32, parts: parts as u32 }))
        }
    }
}

fn digits(s: &str) -> Option<u64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// The content of `_last_checkpoint`: where readers may start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCheckpoint {
    pub version: u64,
    /// number of actions in the checkpoint
    pub size: i64,
    /// number of parts, for a multi-part checkpoint
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_in_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_of_add_files: Option<i64>,
}

impl LastCheckpoint {
    pub fn parse(bytes: &[u8]) -> Option<LastCheckpoint> {
        serde_json::from_slice(bytes).ok()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("LastCheckpoint serializes to JSON")
    }

    /// The file names of the checkpoint it points to.
    pub fn file_names(&self) -> Vec<String> {
        match self.parts {
            Some(n) if n > 0 => multipart_checkpoint_file_names(self.version, n),
            _ => vec![checkpoint_file_name(self.version)],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_parses_names() {
        assert_eq!(commit_file_name(7), "00000000000000000007.json");
        assert_eq!(checkpoint_file_name(10), "00000000000000000010.checkpoint.parquet");
        let names = multipart_checkpoint_file_names(10, 2);
        assert_eq!(names[1], "00000000000000000010.checkpoint.0000000002.0000000002.parquet");
        assert_eq!(parse_file_name(&commit_file_name(7)), Some((7, LogFileKind::Commit)));
        assert_eq!(parse_file_name(&checkpoint_file_name(10)), Some((10, LogFileKind::Checkpoint)));
        assert_eq!(parse_file_name(&names[0]), Some((10, LogFileKind::MultiPartCheckpoint { part: 1, parts: 2 })));
        assert_eq!(parse_file_name("_last_checkpoint"), Some((0, LogFileKind::LastCheckpoint)));
        for other in ["00000000000000000007.crc", "x.json", "0000000000000000001.checkpoint.abc.parquet", "7.00000000000000000008.compacted.json", ".json", "1.checkpoint.0000000003.0000000002.parquet"] {
            assert_eq!(parse_file_name(other), None, "{other}");
        }
        assert!(LogFileKind::Checkpoint.is_checkpoint() && !LogFileKind::Commit.is_checkpoint());
    }

    #[test]
    fn last_checkpoint_round_trips() {
        let lc = LastCheckpoint::parse(br#"{"version":20,"size":15,"parts":2,"sizeInBytes":900,"unknown":1}"#).unwrap();
        assert_eq!((lc.version, lc.parts, lc.size_in_bytes), (20, Some(2), Some(900)));
        assert_eq!(lc.file_names().len(), 2);
        assert_eq!(LastCheckpoint::parse(&lc.to_bytes()), Some(lc));
        assert_eq!(LastCheckpoint::parse(b"{").map(|_| ()), None);
        let single = LastCheckpoint { version: 5, size: 1, parts: None, size_in_bytes: None, num_of_add_files: None };
        assert_eq!(single.file_names(), vec![checkpoint_file_name(5)]);
    }
}
