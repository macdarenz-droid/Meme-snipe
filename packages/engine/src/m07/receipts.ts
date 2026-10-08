// PATHS-FIX (docs/reviews/DISKBUDGET.md ruling 17): the receipts folder is the one place the pull account may write
// (`ENGINE_PATHS.receiptsDir`, 2770), so it could fill the disk. This sweep keeps it bounded: anything that is not a
// valid receipt is deleted, and the caller raises an alert whenever something was deleted, could not be, or valid
// receipts alone are over the cap. A valid receipt is never deleted here. Without one a segment is only kept longer
// (SPEC-A A-M07-03: nothing is deleted without a verified PullReceipt), so the sweep fails closed.
//
// What makes a receipt valid (its canonical JSON and Ed25519 signature with the research key) is B-M30-03's format, so
// the check is passed in. M07 (A-M07-03) runs the sweep before it reads receipts and logs its alert.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface ReceiptCaps {
  /** At most this many valid receipts are expected (default 100,000: one per segment, about 300 bytes each). */
  maxCount: number;
  /** At most this many bytes of valid receipts (default 64 MiB). */
  maxBytes: number;
  /** A larger file is not a receipt and is deleted unread (default 4 KiB). */
  maxFileBytes: number;
}

export const RECEIPT_CAPS: ReceiptCaps = { maxCount: 100_000, maxBytes: 64 * 1_024 * 1_024, maxFileBytes: 4 * 1_024 };

export type ReceiptDrop = 'not_a_file' | 'too_large' | 'invalid';

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
export function sweepReceipts(dir: string, isValid: (bytes: Buffer, name: string) => boolean, caps: ReceiptCaps = RECEIPT_CAPS): ReceiptSweep {
  const out: ReceiptSweep = { kept: 0, keptBytes: 0, deleted: [], stuck: [], overCap: false, alert: false };
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const got = readBounded(path, caps.maxFileBytes);
    let why: ReceiptDrop | null = null;
    if (got === null) why = 'not_a_file';
    else if (got === 'too_large') why = 'too_large';
    else {
      let ok = false;
      try {
        ok = isValid(got, name);
      } catch {
        ok = false;
      }
      if (ok) {
        out.kept += 1;
        out.keptBytes += got.length;
        continue;
      }
      why = 'invalid';
    }
    try {
      if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true });
      else unlinkSync(path);
      out.deleted.push({ name, why });
    } catch (e) {
      out.stuck.push({ name, why, error: e instanceof Error ? e.message : String(e) });
    }
  }
  out.overCap = out.kept > caps.maxCount || out.keptBytes > caps.maxBytes;
  out.alert = out.deleted.length > 0 || out.stuck.length > 0 || out.overCap;
  return out;
}
