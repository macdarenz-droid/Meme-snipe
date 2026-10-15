// Frame-by-frame reading of a segment (ruling Z08-23). A segment is a sequence of complete gzip members, one per flush.
// Crash recovery and md-pull walk it one member at a time: each member is decoded on its own (gzip's own CRC-32 and
// length check it), and its lines are split from the decoded bytes in bounded chunks, so no whole segment is ever held
// in one string (V8 strings stop at about 512 MiB, and an hour of a busy stream can decode to more). The walk stops at
// the first member that does not decode: only there may recovery cut. Pure: bytes in, lines out.
import { gunzipSync } from 'node:zlib';
import { frameStarts } from './manifest.ts';

/** Decoded bytes turned into text at most this many at a time (1 MiB). */
export const LINE_CHUNK_BYTES = 1_048_576;

export interface FrameScan {
  /** Bytes from the start that hold complete, valid members (the cut point; the file length when all are good). */
  goodEnd: number;
  /** Complete members read. */
  frames: number;
  /** Lines read from those members. */
  lines: number;
  /** True when every byte of the file belongs to a valid member. */
  complete: boolean;
  /** A member's last line did not end with a newline (not something the writer produces). */
  unterminated: boolean;
}

/**
 * Walks the gzip members of `buf` in order. For each member start it tries the next possible member starts (gzip magic
 * bytes, `frameStarts`) as its end, in increasing order, and takes the first that decodes: a magic sequence inside
 * compressed data never decodes as an end (the member's trailer and CRC fail), so each step reads exactly one member.
 * `onLine` gets each line (without its newline); `chunkBytes` bounds the text made at once.
 */
export function scanGzipFrames(buf: Uint8Array, onLine: (line: string) => void, chunkBytes = LINE_CHUNK_BYTES): FrameScan {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) throw new RangeError('chunkBytes must be a positive integer');
  const ends = [...frameStarts(buf, 'gzip'), buf.length];
  const out: FrameScan = { goodEnd: 0, frames: 0, lines: 0, complete: buf.length === 0, unterminated: false };
  let pos = 0;
  let next = 0;
  while (pos < buf.length) {
    while (next < ends.length && (ends[next] as number) <= pos) next += 1;
    let decoded: Buffer | null = null;
    let end = pos;
    for (let i = next; i < ends.length; i += 1) {
      try {
        decoded = gunzipSync(buf.subarray(pos, ends[i]));
        end = ends[i] as number;
        break;
      } catch { /* not this member's end */ }
    }
    // A member that is not valid UTF-8 counts as failing too; its lines are handed on only once the whole member is good.
    const lines = decoded === null ? null : splitLines(decoded, chunkBytes);
    if (lines === null) return out;                                       // the member at `pos` fails its own check
    out.frames += 1;
    out.goodEnd = end;
    pos = end;
    out.unterminated = lines.unterminated;
    out.lines += lines.lines.length;
    for (const l of lines.lines) onLine(l);
  }
  out.complete = true;
  return out;
}

/**
 * One member's lines, converting at most `chunkBytes` to text at a time, or null when the bytes are not valid UTF-8.
 * `unterminated` is true when the last line has no newline.
 */
function splitLines(bytes: Uint8Array, chunkBytes: number): { lines: string[]; unterminated: boolean } | null {
  const td = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = [];
  let carry = '';
  try {
    for (let at = 0; at < bytes.length; at += chunkBytes) {
      const parts = (carry + td.decode(bytes.subarray(at, at + chunkBytes), { stream: true })).split('\n');
      carry = parts.pop() as string;
      for (const p of parts) lines.push(p);
    }
    carry += td.decode();
  } catch {
    return null;
  }
  if (carry !== '') lines.push(carry);
  return { lines, unterminated: carry !== '' };
}
