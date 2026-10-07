import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  createLogger, CORRELATION_FIELDS, escapeInvisible, hasKeyedQuery, LIMITS, M27_LOG_CODES, mergeLogCodes, REDACTED, renderField, rfc3339,
  truncateUtf8, type Level, type LogCodes, type SinkResult,
} from '../../src/m27/log.ts';
import { FileLogSink } from '../../src/m27/logfile.ts';
import { fakeClock, tempDir } from '../helpers.ts';

const CODES: LogCodes = mergeLogCodes(M27_LOG_CODES, {
  'm99.sample': { fields: { url: 'string', api_key: 'secret', symbol: 'symbol', name: 'name', size_lamports: 'bigint', latency_ms: 'number',
    count: 'integer', ok: 'boolean', detail: 'json' } },
});

function capture(over: { minLevel?: Level; result?: SinkResult } = {}) {
  const lines: Array<{ line: string; level: Level }> = [];
  const dropped: Level[] = [];
  const lost: Level[] = [];
  const errors: string[] = [];
  const log = createLogger({
    clock: fakeClock(Date.UTC(2026, 9, 6, 14, 2, 11, 123)), codes: CODES, runId: '01J9ZQ3V5W8X0Y1Z2A3B4C5D6E', mode: 'paper',
    sink: { write: (line, level) => { if (over.result !== undefined) return over.result; lines.push({ line, level }); return 'written'; } },
    onDrop: (l) => dropped.push(l), onLost: (l) => lost.push(l), onError: (e) => errors.push(e.code),
    ...(over.minLevel === undefined ? {} : { minLevel: over.minLevel }),
  });
  const parsed = () => lines.map((l) => JSON.parse(l.line) as Record<string, unknown>);
  return { log, lines, parsed, dropped, lost, errors };
}

describe('structured log lines (ARCH 13.2)', () => {
  it('writes ts, level, module, code, run_id, mode, correlation IDs and typed fields', () => {
    const { log, parsed } = capture();
    log.event('info', 'm99.sample', { size_lamports: 18_446_744_073_709_551_615n, latency_ms: 1.5, count: 3, ok: true, intent_id: 'I1', detail: { a: [1, 'b'] } });
    assert.deepEqual(parsed()[0], {
      ts: '2026-10-06T14:02:11.123Z', level: 'info', module: 'm99', code: 'm99.sample', run_id: '01J9ZQ3V5W8X0Y1Z2A3B4C5D6E', mode: 'paper',
      size_lamports: '18446744073709551615', latency_ms: 1.5, count: 3, ok: true, intent_id: 'I1', detail: { a: [1, 'b'] },
    });
  });

  it('filters by level, follows context changes and copies error and above to the alert hook', () => {
    const { log, parsed, errors } = capture({ minLevel: 'warn' });
    log.event('info', 'm99.sample');
    log.event('warn', 'm99.sample');
    log.setContext({ runId: 'R2', mode: 'live_small' });
    log.event('error', 'm99.sample');
    log.event('critical', 'm99.sample');
    assert.deepEqual(parsed().map((l) => [l.level, l.run_id, l.mode]), [['warn', '01J9ZQ3V5W8X0Y1Z2A3B4C5D6E', 'paper'], ['error', 'R2', 'live_small'], ['critical', 'R2', 'live_small']]);
    assert.deepEqual(errors, ['m99.sample', 'm99.sample']);
    const dflt = capture();
    dflt.log.event('debug', 'm99.sample');
    assert.equal(dflt.lines.length, 0);
  });

  it('counts shed and lost lines apart, and copies error and above to the alert hook whatever the sink did (ARCH 13.2)', () => {
    const shed = capture({ result: 'shed' });
    shed.log.event('info', 'm99.sample');
    assert.deepEqual([shed.dropped, shed.lost, shed.errors], [['info'], [], []]);
    const lost = capture({ result: 'lost' });
    lost.log.event('warn', 'm99.sample');
    lost.log.event('error', 'm99.sample');
    lost.log.event('critical', 'm42.nope');
    assert.deepEqual([lost.dropped, lost.lost, lost.errors], [[], ['warn', 'error', 'critical'], ['m99.sample', 'm27.unknown_code']]);
  });

  it('writes an unregistered code as m27.unknown_code without its fields', () => {
    const { log, parsed } = capture();
    log.event('warn', 'm42.nope', { url: 'x' });
    assert.deepEqual(parsed()[0], { ts: '2026-10-06T14:02:11.123Z', level: 'warn', module: 'm27', code: 'm27.unknown_code', run_id: '01J9ZQ3V5W8X0Y1Z2A3B4C5D6E', mode: 'paper', unknown_code: 'm42.nope' });
  });

  it('never writes the value of an undeclared field, and never lets a field replace a standard key', () => {
    const { log, parsed } = capture();
    log.event('info', 'm99.sample', { password: 'hunter2', ts: 'x', level: 'debug', 'Bad Name': 'y' });
    const line = parsed()[0] as Record<string, unknown>;
    assert.equal(line.password, REDACTED);
    assert.equal(line.ts, '2026-10-06T14:02:11.123Z');
    assert.equal(line.level, 'info');
    assert.equal('Bad Name' in line, false);
  });
});

describe('redaction (ARCH 12.4; acceptance: https://x?api-key=abc is written as [redacted])', () => {
  it('redacts the acceptance example, secret fields and keyed URLs in json fields', () => {
    const { log, parsed } = capture();
    log.event('info', 'm99.sample', { url: 'https://x?api-key=abc', api_key: 'abc', detail: { endpoint: 'https://x/rpc?token=abc', list: ['ok'] } });
    const line = parsed()[0] as Record<string, unknown>;
    assert.equal(line.url, REDACTED);
    assert.equal(line.api_key, REDACTED);
    assert.deepEqual(line.detail, { endpoint: REDACTED, list: ['ok'] });
  });

  it('finds keyed query parameters plainly, in any case, under prefixes and percent-encoded', () => {
    for (const s of ['https://x?api-key=1', 'https://x/?a=1&API_KEY=2', 'u?apikey=3', 'u;key=4', 'u#access_token=5', 'u?x-api-key=6', 'u?Token=7',
      'u?auth=8', 'u?client_secret=9', 'https%3A%2F%2Fx%3Fapi-key%3D1', 'a%253Fkey%253D1', 'a%25253Ftoken%25253D1']) {
      assert.equal(hasKeyedQuery(s), true, s);
    }
    for (const s of ['https://x/path', 'u?monkey=1', 'keys and tokens', 'u?a=1&b=2', '%zz', 'a%2525252Fkey']) assert.equal(hasKeyedQuery(s), false, s);
  });

  it('fuzz: no secret-shaped value in a keyed URL query ever reaches a line, in any field', () => {
    const name = fc.constantFrom('api-key', 'api_key', 'API-KEY', 'apikey', 'key', 'KEY', 'token', 'Token', 'access_token', 'x-api-key', 'auth');
    const secret = fc.stringMatching(/^[A-Za-z0-9_-]{8,40}$/);
    const host = fc.stringMatching(/^[a-z]{1,12}\.[a-z]{2,6}$/);
    const path = fc.stringMatching(/^(\/[a-z0-9]{0,8}){0,3}$/);
    const other = fc.array(fc.tuple(fc.stringMatching(/^[a-z]{1,6}$/), fc.stringMatching(/^[a-z0-9]{0,6}$/)), { maxLength: 3 });
    const encode = fc.integer({ min: 0, max: 2 });
    fc.assert(fc.property(name, secret, host, path, other, encode, fc.boolean(), (n, s, h, p, params, layers, first) => {
      const query = first ? [[n, s], ...params] : [...params, [n, s]];
      let url = `https://${h}${p}?${query.map(([k, v]) => `${k}=${v}`).join('&')}`;
      for (let i = 0; i < layers; i++) url = encodeURIComponent(url);
      const { log, lines } = capture();
      log.event('info', 'm99.sample', { url, symbol: url, name: url, detail: { nested: [url] }, intent_id: url });
      return lines.every((l) => !l.line.includes(s));
    }), { seed: 20261007, numRuns: 2_000 });
  });
});

describe('untrusted strings (symbol 32, name 64 bytes) and escaping', () => {
  it('cuts at whole UTF-8 characters and escapes invisible and direction-changing characters', () => {
    assert.equal(truncateUtf8('a'.repeat(40), LIMITS.symbol), 'a'.repeat(32));
    assert.equal(truncateUtf8('\u00e9'.repeat(40), LIMITS.symbol), '\u00e9'.repeat(16));
    assert.equal(truncateUtf8('\u20ac\u20ac\u20ac', 7), '\u20ac\u20ac');
    assert.equal(truncateUtf8('\u{1f600}\u{1f600}', 7), '\u{1f600}');
    assert.equal(escapeInvisible('a\u202eb\u200bc\u0085d'), 'a\\u202eb\\u200bc\\u0085d');
    const { log, parsed } = capture();
    log.event('info', 'm99.sample', { symbol: `${'S'.repeat(31)}\u00e9`, name: `x\u202e${'n'.repeat(70)}` });
    const line = parsed()[0] as Record<string, unknown>;
    assert.equal(line.symbol, 'S'.repeat(31));
    assert.equal(line.name, `x\\u202e${'n'.repeat(60)}`);
  });

  it('fuzz: an untrusted field never exceeds its byte limit before escaping and never holds a raw bidi control', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (s) => {
      const out = renderField('name', s) as string;
      return !/[\u202a-\u202e\u2066-\u2069]/.test(out) && Buffer.byteLength(truncateUtf8(s, LIMITS.name)) <= LIMITS.name;
    }), { seed: 20261007, numRuns: 2_000 });
  });
});

describe('renderField kinds', () => {
  it('writes null for a value of the wrong type and for null or undefined', () => {
    assert.equal(renderField('string', undefined), null);
    assert.equal(renderField('string', null), null);
    assert.equal(renderField('string', 3), null);
    assert.equal(renderField('id', 'a'), 'a');
    assert.equal(renderField('symbol', 3), null);
    assert.equal(renderField('number', Number.NaN), null);
    assert.equal(renderField('number', '1'), null);
    assert.equal(renderField('integer', 1.5), null);
    assert.equal(renderField('integer', 2), 2);
    assert.equal(renderField('bigint', 1), null);
    assert.equal(renderField('boolean', 'true'), null);
    assert.equal(renderField('secret', 'x'), REDACTED);
  });

  it('json: bigints as strings, non-finite numbers and functions as null, depth and size bounded', () => {
    assert.deepEqual(renderField('json', { b: 1n, n: Number.NaN, f: () => 1, t: true, z: null, s: Symbol('x') }), { b: '1', n: null, f: null, t: true, z: null, s: null });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i++) deep = [deep];
    assert.deepEqual(renderField('json', deep), [[[[[[[[null]]]]]]]]);
    assert.equal(renderField('json', { big: Array.from({ length: 50 }, () => 'x'.repeat(200)) }), '[truncated]');
    assert.equal((renderField('json', Array.from({ length: 150 }, () => 0)) as unknown[]).length, 100);
    assert.equal(Object.keys(renderField('json', Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, 0]))) as object).length, 100);
  });

  it('rfc3339 writes UTC with milliseconds', () => {
    assert.equal(rfc3339(Date.UTC(2026, 9, 6, 14, 2, 11, 123)), '2026-10-06T14:02:11.123Z');
  });
});

describe('mergeLogCodes', () => {
  it('refuses duplicates, malformed codes and fields that shadow standard keys', () => {
    assert.throws(() => mergeLogCodes(M27_LOG_CODES, M27_LOG_CODES), /defined twice/);
    assert.throws(() => mergeLogCodes({ Bad: { fields: {} } }), /module\.event/);
    assert.throws(() => mergeLogCodes({ 'm1.x': { fields: { ts: 'string' } } }), /standard field "ts"/);
    assert.throws(() => mergeLogCodes({ 'm1.x': { fields: { intent_id: 'string' } } }), /standard field "intent_id"/);
    assert.throws(() => mergeLogCodes({ 'm1.x': { fields: { Bad: 'string' } } }), /snake_case/);
    assert.deepEqual(Object.keys(CORRELATION_FIELDS), ['candidate_id', 'intent_id', 'attempt_id', 'position_id', 'signature']);
  });
});

describe('logger with the file sink when the sink is full (B-M27-01 logic 4-5)', () => {
  it('keeps warn and above past the daily size, and copies an error the full queue lost to the alert hook', async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 7, 0, 0, 0));
    const dir = tempDir('full');
    const sink = new FileLogSink({ dir, clock, retentionDays: 14, maxBytesPerDay: 100, queueBytes: 1_000 });
    const dropped: Level[] = [];
    const lost: Level[] = [];
    const alerts: Level[] = [];
    const log = createLogger({ clock, codes: CODES, sink, runId: 'R', mode: 'paper', minLevel: 'debug',
      onDrop: (l) => dropped.push(l), onLost: (l) => lost.push(l), onError: (e) => alerts.push(e.level) });
    const url = 'u'.repeat(1_000);
    log.event('warn', 'm99.sample', { url });                         // ~1.1 kB: past the daily size and the queue
    log.event('debug', 'm99.sample');
    log.event('info', 'm99.sample');
    log.event('critical', 'm99.sample', { url });                     // queue now past twice queueBytes
    log.event('error', 'm99.sample');
    await sink.close();
    assert.deepEqual(dropped, ['debug', 'info']);
    assert.deepEqual(lost, ['error']);
    assert.deepEqual(alerts, ['critical', 'error']);
    assert.deepEqual(readFileSync(sink.path(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).level), ['warn', 'critical']);
  });
});

describe('secret scan of produced logs (ARCH 16.6)', () => {
  it('writes secret-bearing events through the file sink and prints the file for the CI secrets scan of the test log', async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 7, 0, 0, 0));
    const dir = tempDir('scan');
    const sink = new FileLogSink({ dir, clock, retentionDays: 14, maxBytesPerDay: 1_000_000, queueBytes: 1_000_000 });
    const log = createLogger({ clock, codes: CODES, sink, runId: 'R', mode: 'paper' });
    const key = ['K', 'e', 'y', '9'].join('').repeat(6);                 // built at run time, never a literal
    for (const p of ['api-key', 'api_key', 'key', 'token']) {
      log.event('error', 'm99.sample', { url: `https://rpc.example/v1?${p}=${key}`, api_key: key, detail: { u: `wss://x/?${p}=${key}` } });
    }
    await sink.close();
    const text = readFileSync(sink.path(), 'utf8');
    assert.equal(text.includes(key), false);
    assert.equal(text.split('\n').filter(Boolean).length, 4);
    console.log(text);
  });
});
