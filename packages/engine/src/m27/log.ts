// Structured logs (B-M27-01 logic 4-5; ARCH 13.2, 12.4). One JSON line per event with `ts` (RFC 3339 UTC, ms),
// `level`, `module`, `code`, `run_id`, `mode`, the correlation IDs and the code's typed fields (units in the names).
//
// Redaction by schema: every code declares its fields and their kinds. A `secret` field, a field the code does not
// declare, and any string holding a URL query parameter named like a key (`api-key`, `api_key`, `key`, `token`, also
// percent-encoded) are written as `[redacted]`. Untrusted token strings are cut to 32 (symbol) or 64 (name) UTF-8
// bytes and invisible or direction-changing characters are escaped. Redaction is defence in depth: modules must not
// pass secrets to the log at all (SPEC-B convention 6).
import type { Clock, Mode } from '@bot/types';

export const LEVELS = ['debug', 'info', 'warn', 'error', 'critical'] as const;
export type Level = (typeof LEVELS)[number];

/** How a field is written. `symbol` and `name` are untrusted token strings (VM convention `Untrusted<string>`). */
export type FieldKind = 'string' | 'number' | 'integer' | 'bigint' | 'boolean' | 'id' | 'secret' | 'symbol' | 'name' | 'json';
export interface LogCodeDef { readonly fields: Readonly<Record<string, FieldKind>> }
export type LogCodes = Readonly<Record<string, LogCodeDef>>;

export const REDACTED = '[redacted]';
/** Correlation IDs any event may carry (ARCH 13.2). */
export const CORRELATION_FIELDS: Readonly<Record<string, FieldKind>> = {
  candidate_id: 'id', intent_id: 'id', attempt_id: 'id', position_id: 'id', signature: 'id',
};
const RESERVED = new Set(['ts', 'level', 'module', 'code', 'run_id', 'mode']);
const CODE_RE = /^[a-z][a-z0-9]*\.[a-z0-9_.]+$/;
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Byte limits of untrusted strings (UI convention 5; ARCH 13.2) and of any other string (keeps a line bounded). */
export const LIMITS = { symbol: 32, name: 64, string: 1_024, json: 4_096 } as const;

/** M27's own codes. */
export const M27_LOG_CODES = {
  'm27.unknown_code': { fields: { unknown_code: 'string' } },
  'm27.rollup_write_failed': { fields: { minute_start_ms: 'integer', row_count: 'integer', error_message: 'string' } },
} as const satisfies LogCodes;

/**
 * Merges the code tables modules export; a code defined twice, a malformed code, or a field that shadows a standard
 * key or a correlation ID is a programmer error (thrown at start).
 */
export function mergeLogCodes(...tables: LogCodes[]): LogCodes {
  const out: Record<string, LogCodeDef> = {};
  for (const table of tables) {
    for (const [code, def] of Object.entries(table)) {
      if (!CODE_RE.test(code)) throw new TypeError(`log code "${code}" must look like "module.event"`);
      if (code in out) throw new TypeError(`log code "${code}" is defined twice`);
      for (const field of Object.keys(def.fields)) {
        if (!FIELD_NAME_RE.test(field)) throw new TypeError(`log code "${code}": field "${field}" must be snake_case`);
        if (RESERVED.has(field) || field in CORRELATION_FIELDS) throw new TypeError(`log code "${code}" redefines the standard field "${field}"`);
      }
      out[code] = def;
    }
  }
  return out;
}

// A query parameter whose name is, or ends in, a key word: ?key=, &api-key=, ;x_api_key=, #access_token=, ?apiKey=.
const KEYED_QUERY = /[?&;#](?:[a-z0-9]*[-_.])?(?:api[-_.]?key|apikey|key|token|auth|secret|password)=/i;

function percentDecoded(s: string): string {
  return s.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** True when the text holds a URL query parameter named like a key, plainly or percent-encoded (up to 3 layers). */
export function hasKeyedQuery(s: string): boolean {
  let text = s;
  for (let layer = 0; layer < 4; layer++) {
    if (KEYED_QUERY.test(text)) return true;
    const next = percentDecoded(text);
    if (next === text) return false;
    text = next;
  }
  return false;
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes at a whole-character boundary. */
export function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

// Characters that are invisible or change text direction: C1 controls, soft hyphen, Arabic letter mark, Mongolian
// vowel separator, zero-width and bidi marks, line and paragraph separators, bidi embeddings and isolates, word
// joiners, byte-order mark and interlinear annotation marks. JSON.stringify already escapes C0 controls.
const INVISIBLE = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb]/g;

/** Writes invisible and direction-changing characters as visible `\uXXXX` text. */
export function escapeInvisible(s: string): string {
  return s.replace(INVISIBLE, (c) => `\\u${(c.codePointAt(0) as number).toString(16).padStart(4, '0')}`);
}

function safeString(s: string, maxBytes: number): string {
  return hasKeyedQuery(s) ? REDACTED : escapeInvisible(truncateUtf8(s, maxBytes));
}

function jsonValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return safeString(v, LIMITS.string);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  if (typeof v !== 'object' || depth >= 8) return null;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => jsonValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).slice(0, 100)) out[safeString(k, 64)] = jsonValue((v as Record<string, unknown>)[k], depth + 1);
  return out;
}

/** The written form of one field value of the given kind. */
export function renderField(kind: FieldKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'secret':
      return REDACTED;
    case 'symbol':
    case 'name':
      return typeof value === 'string' ? safeString(value, LIMITS[kind]) : null;
    case 'string':
    case 'id':
      return typeof value === 'string' ? safeString(value, LIMITS.string) : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'integer':
      return Number.isSafeInteger(value) ? value : null;
    case 'bigint':
      return typeof value === 'bigint' ? value.toString() : null;
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'json': {
      const text = JSON.stringify(jsonValue(value, 0));
      return Buffer.byteLength(text) > LIMITS.json ? '[truncated]' : JSON.parse(text);
    }
  }
}

/** RFC 3339 UTC with milliseconds, e.g. 2026-10-06T14:02:11.123Z. */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * What a sink did with a line: `written`; `shed` by "sink full → drop debug, keep warn and above" (debug and info
 * only; ARCH M27); `lost` when no file can take it or, for warn and above, the write queue is at its hard memory bound
 * (spec deviation, counted apart).
 */
export type SinkResult = 'written' | 'shed' | 'lost';
/** Where lines go. */
export interface LogSink { write(line: string, level: Level): SinkResult }

export interface LoggerOptions {
  clock: Clock;
  codes: LogCodes;
  sink: LogSink;
  runId: string;
  mode: Mode;
  /** Events below this level are not written. Default `info`. */
  minLevel?: Level;
  /** Called for each line the sink shed (`log_dropped_total{level}`). */
  onDrop?: (level: Level) => void;
  /** Called for each line the sink lost (`log_lost_total{level}`). */
  onLost?: (level: Level) => void;
  /** Called for every event at `error` or above, written or not, so the alert store keeps a copy (ARCH 13.2). */
  onError?: (e: { level: Level; code: string; line: string }) => void;
}

export interface Logger {
  event(level: Level, code: string, fields?: Readonly<Record<string, unknown>>): void;
  setContext(ctx: { runId: string; mode: Mode }): void;
}

/** The logger: `log.event(level, code, fields)` (ARCH M27). */
export function createLogger(opts: LoggerOptions): Logger {
  let runId = opts.runId;
  let mode = opts.mode;
  const min = LEVELS.indexOf(opts.minLevel ?? 'info');
  return {
    setContext(ctx): void {
      runId = ctx.runId;
      mode = ctx.mode;
    },
    event(level, code, fields = {}): void {
      if (LEVELS.indexOf(level) < min) return;
      const def = opts.codes[code];
      const line: Record<string, unknown> = {
        ts: rfc3339(opts.clock.nowMs()), level, module: def === undefined ? 'm27' : code.slice(0, code.indexOf('.')),
        code: def === undefined ? 'm27.unknown_code' : code, run_id: runId, mode,
      };
      if (def === undefined) {
        line.unknown_code = safeString(code, 64);
      } else {
        for (const [key, value] of Object.entries(fields)) {
          const kind = def.fields[key] ?? CORRELATION_FIELDS[key];
          if (kind !== undefined) line[key] = renderField(kind, value);
          else if (!RESERVED.has(key) && FIELD_NAME_RE.test(key)) line[key] = REDACTED;   // undeclared: name kept, value never
        }
      }
      const text = JSON.stringify(line);
      const result = opts.sink.write(text, level);
      if (result === 'shed') opts.onDrop?.(level);
      if (result === 'lost') opts.onLost?.(level);
      if (LEVELS.indexOf(level) >= LEVELS.indexOf('error')) opts.onError?.({ level, code: line.code as string, line: text });
    },
  };
}
