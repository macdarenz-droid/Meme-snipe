// PATHS-FIX (docs/reviews/DISKBUDGET.md ruling 17): the receipts folder is the one place the pull account may write
// (`ENGINE_PATHS.receiptsDir`, 2770), so it could fill the disk. This sweep keeps it bounded: anything that is not a
// valid receipt is deleted, and the caller raises an alert whenever something was deleted, could not be, or valid
// receipts alone are over the cap. A valid receipt is never deleted here. Without one a segment is only kept longer
// (SPEC-A A-M07-03: nothing is deleted without a verified PullReceipt), so the sweep fails closed.
//
// What makes a receipt valid (its canonical JSON and Ed25519 signature with the research key) is B-M30-03's format, so
// the check is passed in: it returns the segment the receipt is for, or null. M07 (A-M07-03) runs the sweep before it
// reads receipts and logs its alert.
//
// Ruling 19: nothing here ever recurses or follows a link in a folder the pull account writes. A file or a link is
// removed with unlink (which removes the link, never its target); a folder only with rmdir, so only an empty one goes
// and a full one is reported as stuck; anything else is stuck. A swap between the check and the delete makes the delete
// fail (rmdir on a link or unlink on a folder), so it is reported, and nothing outside the folder is touched.
//
// Ruling 20: a receipt's file name is bound to its segment (`receiptFileName`), so there is at most one receipt per
// segment; a valid receipt under any other name is a duplicate or a stray copy and is deleted.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface ReceiptCaps {
  /** At most this many valid receipts are expected (default 30,000: the alert comes before receipts/'s own filesystem,
   *  32,768 inodes in 64 MiB (ops/host/files/usr/local/lib/zeroed/receipts-fs), is full). */
  maxCount: number;
  /** At most this many bytes of valid receipts (default 24 MiB; each receipt is a few hundred bytes in a 1 KiB block). */
  maxBytes: number;
  /** A larger file is not a receipt and is deleted unread (default 4 KiB). */
  maxFileBytes: number;
}

export const RECEIPT_CAPS: ReceiptCaps = { maxCount: 30_000, maxBytes: 24 * 1_024 * 1_024, maxFileBytes: 4 * 1_024 };

export type ReceiptDrop = 'not_a_file' | 'too_large' | 'invalid' | 'misnamed' | 'duplicate';

/** The one file name a receipt for `segment` (its path under the market-data folder) may have. */
export const receiptFileName = (segment: string): string => `${createHash('sha256').update(segment, 'utf8').digest('hex')}.receipt.json`;

export interface ReceiptSweep {
  /** Valid receipts left in the folder. */
  kept: number;
  keptBytes: number;
  deleted: Array<{ name: string; why: ReceiptDrop }>;
  /** Entries that should have gone but could not be deleted. */
  stuck: Array<{ name: string; why: ReceiptDrop; error: string }>;
  /** Valid receipts alone are over `maxCount` or `maxBytes`. */
  overCap: boolean;
  /** True when the caller must raise an alert. */
  alert: boolean;
}

/** Reads one entry without following a link and never more than `limit` bytes; null when it is not a regular file. */
function readBounded(path: string, limit: number): Buffer | 'too_large' | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > limit) return 'too_large';
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    for (let r = 1; r > 0 && n <= limit; n += r) r = readSync(fd, buf, n, limit + 1 - n, null);
    return n > limit ? 'too_large' : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** One pass over `dir`: deletes what is not a valid receipt and reports what the caller must alert on. */
export function sweepReceipts(dir: string, segmentOf: (bytes: Buffer) => string | null, caps: ReceiptCaps = RECEIPT_CAPS): ReceiptSweep {
  const out: ReceiptSweep = { kept: 0, keptBytes: 0, deleted: [], stuck: [], overCap: false, alert: false };
  const seen = new Set<string>();
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const got = readBounded(path, caps.maxFileBytes);
    let why: ReceiptDrop | null = null;
    if (got === null) why = 'not_a_file';
    else if (got === 'too_large') why = 'too_large';
    else {
      let segment: string | null = null;
      try {
        segment = segmentOf(got);
      } catch {
        segment = null;
      }
      if (segment === null) why = 'invalid';
      else if (name !== receiptFileName(segment)) why = 'misnamed';
      else if (seen.has(segment)) why = 'duplicate';
      else {
        seen.add(segment);
        out.kept += 1;
        out.keptBytes += got.length;
        continue;
      }
    }
    try {
      const st = lstatSync(path);
      if (st.isFile() || st.isSymbolicLink()) unlinkSync(path);
      else if (st.isDirectory()) rmdirSync(path);
      else throw new Error('not a file, a link or a folder');
      out.deleted.push({ name, why });
    } catch (e) {
      out.stuck.push({ name, why, error: e instanceof Error ? e.message : String(e) });
    }
  }
  out.overCap = out.kept > caps.maxCount || out.keptBytes > caps.maxBytes;
  out.alert = out.deleted.length > 0 || out.stuck.length > 0 || out.overCap;
  return out;
}
