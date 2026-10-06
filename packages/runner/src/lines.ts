// A growing line file (journal.jsonl, deployers.jsonl, samples) read in fixed chunks, never whole: a 30-day journal
// read with readFileSync and split('\n') would hold the text and every line at once, past the worker's MemoryMax.
// The decoder keeps a multi-byte character cut by a chunk boundary whole.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** The file's lines in order, read `chunkBytes` at a time. A last line without a final newline is yielded too. */
export function* fileLines(path: string, chunkBytes = 1 << 20): Generator<string> {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(chunkBytes);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) break;
      const lines = (rest + decoder.write(buf.subarray(0, n))).split('\n');
      rest = lines.pop()!;
      yield* lines;
    }
    rest += decoder.end();
    if (rest !== '') yield rest;
  } finally {
    closeSync(fd);
  }
}

/** A file's size and sha256, read `chunkBytes` at a time (a recorded day file is never held whole). */
export const fileHash = (path: string, chunkBytes = 1 << 20): { readonly bytes: number; readonly sha256: string } => {
  const hash = createHash('sha256');
  let bytes = 0;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(chunkBytes);
    for (let n = readSync(fd, buf, 0, chunkBytes, null); n > 0; n = readSync(fd, buf, 0, chunkBytes, null)) {
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: hash.digest('hex') };
};
