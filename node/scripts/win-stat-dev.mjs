// @napi-rs/cli 3.10.12 locks the repo while it writes its outputs and compares files by
// (dev, ino). Node 22.15 on Windows reports dev 0 from lstat but the volume serial from a
// handle, so the check never matches and the CLI loops, filling the repo root with .swp
// files. Make lstat report the handle's dev.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

if (process.platform === 'win32') {
  const lstat = fsp.lstat;
  fsp.lstat = async (path, options) => {
    const stats = await lstat(path, options);
    if (!stats.isSymbolicLink() && (stats.dev === 0n || stats.dev === 0)) {
      try {
        const handle = await fsp.open(path, 'r');
        try {
          stats.dev = (await handle.stat(options)).dev;
        } finally {
          await handle.close();
        }
      } catch {
        // directories cannot be opened: their dev stays 0 on both sides
      }
    }
    return stats;
  };
  fs.promises.lstat = fsp.lstat;
  syncBuiltinESMExports();
}
