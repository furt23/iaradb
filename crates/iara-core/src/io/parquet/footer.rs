//! Remote footers: one suffix request per file (a second one only for
//! footers larger than the guess), all files concurrently, and none for
//! files whose footer another table object already decoded.
//!
//! The suffix is `IARA_FOOTER_GUESS_KB` (512) long, so a file up to
//! that size arrives whole in the same request, and its data needs none.

use std::sync::Arc;

use bytes::Bytes;
use futures::{StreamExt, TryStreamExt, stream};
use parquet::file::metadata::{ParquetMetaData, ParquetMetaDataReader};

use super::meta_cache;
use crate::error::{Result, WhError};
use crate::io::object::{ObjectFile, block_on, config};

const CONCURRENT: usize = 32;

/// A file's decoded footer; its bytes too when the request read it whole.
pub struct Footer {
    pub meta: Arc<ParquetMetaData>,
    pub content: Option<Bytes>,
}

/// The footers of `files`, in order.
pub fn load_all(files: &[ObjectFile]) -> Result<Vec<Footer>> {
    block_on(stream::iter(files).map(load).buffered(CONCURRENT).try_collect())
}

/// The footer of one file: from the cache, else one request (two for a large footer).
pub async fn load(file: &ObjectFile) -> Result<Footer> {
    let key = file.version_key();
    if let Some(meta) = meta_cache::get(&key) {
        return Ok(Footer { meta, content: None });
    }
    let (meta, content) = fetch(file).await?;
    let meta = Arc::new(meta);
    meta_cache::put(key, meta.clone());
    Ok(Footer { meta, content })
}

async fn fetch(file: &ObjectFile) -> Result<(ParquetMetaData, Option<Bytes>)> {
    let corrupt = |why: &str| WhError::Execution(format!("{}: not a Parquet file ({why})", file.url));
    let size = file.size;
    if size < 12 {
        return Err(corrupt("too small"));
    }
    let guess = config::footer_guess().min(size);
    let suffix = file.get_range(size - guess..size).await?;
    if (suffix.len() as u64) < guess {
        return Err(corrupt("the file is shorter than listed"));
    }
    let tail = &suffix[suffix.len() - 8..];
    if &tail[4..] != b"PAR1" {
        return Err(corrupt("missing magic bytes"));
    }
    let meta_len = u32::from_le_bytes(tail[..4].try_into().expect("4 bytes")) as u64;
    if meta_len + 8 > size {
        return Err(corrupt("footer larger than the file"));
    }
    let meta = if meta_len + 8 <= guess {
        suffix.slice((guess - 8 - meta_len) as usize..(guess - 8) as usize)
    } else {
        file.get_range(size - 8 - meta_len..size - 8).await?
    };
    let decoded = ParquetMetaDataReader::decode_metadata(&meta).map_err(|e| WhError::Execution(format!("{}: {e}", file.url)))?;
    Ok((decoded, (guess == size).then_some(suffix)))
}
