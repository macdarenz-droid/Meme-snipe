// Log codes of the recorder process (card Z10): M07's own codes (the queue, the segment writer and the disk manager log
// through plain functions with M07's level names) and the composition root's `recorder.*` codes. Every other module's
// table is merged in `RECORDER_LOG_TABLE`, so no line the recorder writes is `m27.unknown_code` (a test checks the soak).
import { M01_LOG_CODES } from '@bot/venue/constants';
import { M01_VENUE_LOG_CODES } from '../../../venue/src/log.ts';
import { M02_QUARANTINE_LOG_CODES } from '../m02/quarantine.ts';
import { M03_LOG_CODES } from '../m03/log.ts';
import { M04_LOG_CODES } from '../m04/log.ts';
import { M05_LOG_CODES } from '../m05/log.ts';
import { M08_LOG_CODES } from '../m08/log.ts';
import { M10_LOG_CODES } from '../m10/log.ts';
import { M14_LOG_CODES } from '../m14/log.ts';
import { M15_LOG_CODES } from '../m15/log.ts';
import { M24_LOG_CODES } from '../m24/db.ts';
import { M24_MIGRATION_LOG_CODES } from '../m24/migrate.ts';
import { M24_ROLLUP_LOG_CODES } from '../m24/repos.ts';
import { M25_LOG_CODES } from '../m25/bootstrap.ts';
import { M27_LOG_CODES, mergeLogCodes, type Level, type LogCodes } from '../m27/log.ts';

export const M07_LOG_CODES = {
  'm07.codec_fallback': { fields: { wanted: 'string', used: 'string' } },
  'm07.crash_recovered': { fields: { stream: 'string', path: 'string', records: 'integer', cut_bytes: 'integer', cut_reason: 'string' } },
  'm07.recording_halted': { fields: { reason: 'string' } },
  'm07.recording_halted_again': { fields: { reason: 'string', failures: 'integer' } },
  'm07.recording_resumed': { fields: {} },
  'm07.write_failed': { fields: { op: 'string', error_code: 'string' } },
  'm07.segment_rotated': { fields: { stream: 'string', records: 'integer', sha256: 'string' } },
  'm07.receipts_swept': { fields: { category: 'string', deleted: 'integer', stuck: 'integer', over_cap: 'integer' } },
  'm07.segment_deleted': { fields: { path: 'string', sha256: 'string' } },
  'm07.segment_delete_failed': { fields: { path: 'string', error_code: 'string' } },
  'm07.unpulled_segments': { fields: { count: 'integer', retention_days: 'integer' } },
  'm07.disk_full': { fields: { used_pct: 'integer', free_bytes: 'integer', recorder_bytes: 'integer', reasons: 'string' } },
  'm07.disk_ok_resume': { fields: { reason: 'string' } },
  'm07.outage': { fields: { silent_minutes: 'integer' } },
  'm07.clock_step': { fields: { direction: 'string', from: 'string', minutes: 'integer' } },
  'm07.rejected': { fields: { stream: 'string', error_code: 'string', why: 'string' } },
  'm07.queue_full': { fields: { stream: 'string' } },
  'm07.backpressure': { fields: { stream: 'string', depth: 'integer', bytes: 'integer' } },
} as const satisfies LogCodes;

export const RECORDER_LOG_CODES = {
  'recorder.started': { fields: { release: 'string', providers: 'string', primary: 'string' } },
  'recorder.start_refused': { fields: { reason: 'string', message: 'string' } },
  'recorder.stopped': { fields: { reason: 'string' } },
  'recorder.anchor_disagreement': { fields: { providers: 'string', slots: 'string' } },
  'recorder.anchor_agreed': { fields: { providers: 'string' } },
  'recorder.anchor_waiting': { fields: { tries: 'integer' } },
  'recorder.bus_handler_failed': { fields: { topic: 'string' } },
  'recorder.internal_error': { fields: { where: 'string', error_code: 'string' } },
  'recorder.facts_read_failed': { fields: { error_code: 'string', pools: 'integer' } },
  'recorder.memory_high': { fields: { rss_bytes: 'integer', limit_bytes: 'integer', pct: 'integer' } },
} as const satisfies LogCodes;

export const RECORDER_LOG_TABLE: LogCodes = mergeLogCodes(
  M27_LOG_CODES, M24_LOG_CODES, M24_MIGRATION_LOG_CODES, M24_ROLLUP_LOG_CODES, M25_LOG_CODES, M14_LOG_CODES, M15_LOG_CODES,
  M01_LOG_CODES, M01_VENUE_LOG_CODES, M02_QUARANTINE_LOG_CODES, M03_LOG_CODES, M04_LOG_CODES, M05_LOG_CODES, M07_LOG_CODES,
  M08_LOG_CODES, M10_LOG_CODES, RECORDER_LOG_CODES,
);

/** M07's level names on M27's. */
export const m07Level = (l: 'info' | 'warning' | 'error' | 'critical'): Level => (l === 'warning' ? 'warn' : l);

/** M07 names its error field `code`, which M27 reserves for the log code: it becomes `error_code`. */
const snake = (k: string): string => (k === 'code' ? 'error_code' : k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

/** M07's plain log functions on the logger: `M07.x` becomes `m07.x` (M27's code form), camelCase fields snake_case. */
export function m07Log(log: { event(level: Level, code: string, fields?: Readonly<Record<string, unknown>>): void }) {
  return (level: 'info' | 'warning' | 'error' | 'critical', code: string, fields: Record<string, string | number>): void => {
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(fields)) out[snake(k)] = v;
    log.event(m07Level(level), code.startsWith('M07.') ? `m07.${code.slice(4)}` : code, out);
  };
}
