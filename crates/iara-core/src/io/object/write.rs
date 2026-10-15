//! Writing an object as a stream of bytes: a multipart upload whose parts
//! go up in the background while the writer keeps producing.

use std::io::Write;

use object_store::{ObjectStoreExt, WriteMultipart};

use super::error::storage_err;
use super::list_cache;
use super::registry;
use super::runtime::{block_on, runtime};
use crate::error::Result;
use crate::io::location::ObjectUrl;
use crate::io::options::StorageOptions;

const PART_SIZE: usize = 16 << 20;
const PARTS_IN_FLIGHT: usize = 4;

/// A `std::io::Write` into an object. Call [`ObjectWriter::finish`] to
/// complete the upload; dropping it unfinished aborts it.
pub struct ObjectWriter {
    upload: Option<WriteMultipart>,
    url: String,
    /// the object, to drop cached listings of it when it appears
    written: ObjectUrl,
}

impl ObjectWriter {
    pub fn create(url: &ObjectUrl, options: &StorageOptions) -> Result<Self> {
        let store = registry::store(url, options)?;
        let path = super::object_path(&url.key);
        let upload = block_on(store.put_multipart(&path)).map_err(|e| storage_err(e, &url.to_string()))?;
        Ok(Self { upload: Some(WriteMultipart::new_with_chunk_size(upload, PART_SIZE)), url: url.to_string(), written: url.clone() })
    }

    pub fn finish(mut self) -> Result<()> {
        self.commit()
    }

    /// [`ObjectWriter::finish`] without consuming the writer.
    pub fn commit(&mut self) -> Result<()> {
        let upload = self.upload.take().expect("upload already finished");
        block_on(upload.finish()).map_err(|e| storage_err(e, &self.url))?;
        list_cache::invalidate(&self.written.root(), &self.written.key);
        Ok(())
    }
}

impl Write for ObjectWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let upload = self.upload.as_mut().ok_or_else(|| std::io::Error::other("upload finished"))?;
        block_on(upload.wait_for_capacity(PARTS_IN_FLIGHT)).map_err(std::io::Error::other)?;
        // full parts are spawned onto the I/O runtime
        let _ctx = runtime().enter();
        upload.write(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for ObjectWriter {
    fn drop(&mut self) {
        if let Some(upload) = self.upload.take() {
            let _ = block_on(upload.abort());
        }
    }
}
