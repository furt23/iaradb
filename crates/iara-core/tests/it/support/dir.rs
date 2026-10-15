//! A temporary folder for tests that write files, and a view of what is in it.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("wh-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }

    /// `name` inside the folder, with forward slashes.
    pub fn join(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().replace('\\', "/")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Every file below `root`, relative to it with forward slashes, sorted.
pub fn files_under(root: &str) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, root, out);
            } else {
                out.push(p.strip_prefix(root).unwrap().to_str().unwrap().replace('\\', "/"));
            }
        }
    }
    let mut out = vec![];
    walk(Path::new(root), Path::new(root), &mut out);
    out.sort();
    out
}

/// Every folder below `root`, relative to it, sorted.
pub fn dirs_under(root: &str) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries {
            let p = e.unwrap().path();
            if p.is_dir() {
                out.push(p.strip_prefix(root).unwrap().to_str().unwrap().replace('\\', "/"));
                walk(&p, root, out);
            }
        }
    }
    let mut out = vec![];
    walk(Path::new(root), Path::new(root), &mut out);
    out.sort();
    out
}
