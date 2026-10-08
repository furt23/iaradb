//! Remote footers: one suffix request per file (a second one only for
//! footers larger than the guess), all files concurrently.

use futures::{StreamExt, TryStreamExt, stream};
use parquet::file::metadata::{ParquetMetaData, ParquetMetaDataReader};

use crate::error::{Result, WhError};
use crate::io::object::{ObjectFile, block_on};

/// Bytes read from the end of a file in the first request.
const FOOTER_GUESS: u64 = 64 << 10;
const CONCURRENT: usize = 32;

pub fn fetch_all(files: &[ObjectFile]) -> Result<Vec<ParquetMetaData>> {
    block_on(stream::iter(files).map(fetch_metadata).buffered(CONCURRENT).try_collect())
}

pub async fn fetch_metadata(file: &ObjectFile) -> Result<ParquetMetaData> {
    let corrupt = |why: &str| WhError::Execution(format!("{}: not a Parquet file ({why})", file.url));
    let size = file.size;
    if size < 12 {
        return Err(corrupt("too small"));
    }
    let guess = FOOTER_GUESS.min(size);
    let suffix = file.get_range(size - guess..size).await?;
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
    ParquetMetaDataReader::decode_metadata(&meta).map_err(|e| WhError::Execution(format!("{}: {e}", file.url)))
}
