//! Where written data goes: a local file or an object (multipart upload).

use std::fs::File;
use std::io::{BufWriter, Write};

use crate::error::Result;
use crate::io::blob::create_parent;
use crate::io::location::Location;
use crate::io::object::write::ObjectWriter;
use crate::io::options::StorageOptions;

pub enum Output {
    File(BufWriter<File>),
    Object(ObjectWriter),
}

impl Output {
    /// Create (or replace) `path`: a local path or an object store URL.
    pub fn create(path: &str, storage: &StorageOptions) -> Result<Self> {
        Ok(match Location::parse(path)? {
            Location::Local(p) => {
                create_parent(&p)?;
                Output::File(BufWriter::with_capacity(1 << 20, File::create(&p)?))
            }
            Location::Object(url) => Output::Object(ObjectWriter::create(&url, storage)?),
        })
    }

    /// Flush a file, complete an upload.
    pub fn finish(self) -> Result<()> {
        match self {
            Output::File(mut f) => Ok(f.flush()?),
            Output::Object(o) => o.finish(),
        }
    }
}

impl Write for Output {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Output::File(f) => f.write(buf),
            Output::Object(o) => o.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Output::File(f) => f.flush(),
            Output::Object(o) => o.flush(),
        }
    }
}
