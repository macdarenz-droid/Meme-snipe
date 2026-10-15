// Frame-by-frame reading of a segment (rulings Z08-23, Z08-26 to Z08-28). A segment is a sequence of complete gzip
// members, one or more per flush. Crash recovery and md-pull walk it one member at a time, parsing each member's exact
// bounds: the 10-byte header (no optional fields: the writer sets none), the raw deflate data, and the 8-byte footer whose
// CRC-32 and length must match what was decoded. So a member ends exactly where the next starts or where the file ends;
// a torn header, trailing bytes or a bad footer stop the walk there, and only there may recovery cut. No whole segment
// is ever held as one string (V8 strings stop at about 512 MiB): a member decodes to at most `memberBytes` (64 MiB) and
// a line to at most `lineBytes` (4 MiB); a member over either cap counts as corrupt, so a hostile or damaged file cannot
// exhaust the host's memory. The writer never writes a member or a line near those caps (segments.ts, queue.ts).
// Pure: bytes in, lines out.
import { crc32, inflateRawSync } from 'node:zlib';

/** Decoded bytes a member may hold (64 MiB); the writer's members stay at most a quarter of it (FRAME_TARGET_BYTES). */
export const MEMBER_MAX_BYTES = 67_108_864;
/** Bytes a line may hold (4 MiB); a record is at most `recorder.record_max_bytes` (at most 1 MiB) plus its envelope. */
export const LINE_MAX_BYTES = 4_194_304;
/** The writer splits a flush into members of at most this many decoded bytes (16 MiB) whenever a flush holds more. */
export const FRAME_TARGET_BYTES = 16_777_216;

export interface FrameCaps { memberBytes: number; lineBytes: number }
export const FRAME_CAPS: FrameCaps = { memberBytes: MEMBER_MAX_BYTES, lineBytes: LINE_MAX_BYTES };

/** Why the walk stopped before the end of the file. */
export type FrameStop = 'torn' | 'bad_header' | 'bad_footer' | 'member_too_large' | 'line_too_long' | 'not_utf8';

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
  /** Why the walk stopped early, or null when it read the whole file. */
  stop: FrameStop | null;
}

const HEADER = 10;
const FOOTER = 8;

/** Walks the gzip members of `buf` in order; `onLine` gets each line (without its newline) of each valid member. */
export function scanGzipFrames(buf: Uint8Array, onLine: (line: string) => void, caps: FrameCaps = FRAME_CAPS): FrameScan {
  const out: FrameScan = { goodEnd: 0, frames: 0, lines: 0, complete: false, unterminated: false, stop: null };
  let pos = 0;
  while (pos < buf.length) {
    const m = readMember(buf, pos, caps);
    if (typeof m === 'string') { out.stop = m; return out; }
    out.frames += 1;
    out.goodEnd = m.end;
    pos = m.end;
    out.unterminated = m.unterminated;
    out.lines += m.lines.length;
    for (const l of m.lines) onLine(l);
  }
  out.complete = true;
  return out;
}

function readMember(buf: Uint8Array, pos: number, caps: FrameCaps): { end: number; lines: string[]; unterminated: boolean } | FrameStop {
  if (buf.length - pos < HEADER) return 'torn';
  // Magic 1f 8b, method 8 (deflate), flags 0: the writer (zlib's gzip) never sets a name, comment, extra field or header CRC.
  if (buf[pos] !== 0x1f || buf[pos + 1] !== 0x8b || buf[pos + 2] !== 8 || buf[pos + 3] !== 0) return 'bad_header';
  let decoded: Buffer;
  let used: number;
  try {
    const r = inflateRawSync(buf.subarray(pos + HEADER), { info: true, maxOutputLength: caps.memberBytes }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    decoded = r.buffer;
    used = r.engine.bytesWritten;                                         // deflate bytes consumed; what follows is not read
  } catch (e) {
    return (e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE' ? 'member_too_large' : 'torn';
  }
  const foot = pos + HEADER + used;
  if (buf.length - foot < FOOTER) return 'torn';
  const view = Buffer.from(buf.buffer, buf.byteOffset + foot, FOOTER);
  if (view.readUInt32LE(0) !== crc32(decoded) || view.readUInt32LE(4) !== decoded.length % 4_294_967_296) return 'bad_footer';
  const lines = splitLines(decoded, caps.lineBytes);
  if (typeof lines === 'string') return lines;
  return { end: foot + FOOTER, ...lines };
}

/** A member's lines, split on the newline byte (never inside a UTF-8 sequence) and decoded one line at a time. */
function splitLines(bytes: Buffer, lineBytes: number): { lines: string[]; unterminated: boolean } | FrameStop {
  const td = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const nl = bytes.indexOf(0x0a, at);
    const end = nl === -1 ? bytes.length : nl;
    if (end - at > lineBytes) return 'line_too_long';
    try {
      lines.push(td.decode(bytes.subarray(at, end)));
    } catch {
      return 'not_utf8';
    }
    if (nl === -1) return { lines, unterminated: true };
    at = nl + 1;
  }
  return { lines, unterminated: false };
}
