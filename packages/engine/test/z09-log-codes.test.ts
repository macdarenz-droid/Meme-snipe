// Card Z09: every log event the Z09 modules write uses a declared code, and every field it writes is declared for that
// code (B-M27-01 writes an undeclared field as [redacted]; the Z08 cross-check's two fields were, until Z09). A static
// read of each source: the events are written on one line with their fields inline.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { M03_LOG_CODES } from '../src/m03/log.ts';
import { M05_LOG_CODES } from '../src/m05/log.ts';
import { M08_LOG_CODES } from '../src/m08/log.ts';
import { M10_LOG_CODES } from '../src/m10/log.ts';
import { CORRELATION_FIELDS, mergeLogCodes } from '../src/m27/log.ts';

const CODES = (): Record<string, { fields: Record<string, string> }> => mergeLogCodes(M03_LOG_CODES, M05_LOG_CODES, M08_LOG_CODES, M10_LOG_CODES) as never;
const FILES = ['m03/backfill.ts', 'm03/dexscreener.ts', 'm03/pumpportal-client.ts', 'm05/universe.ts', 'm05/watchlist.ts', 'm08/bar-store.ts', 'm10/costs.ts'];

describe('Z09 log codes', () => {
  it('M03 codes merge into the M27 logger (Z08 declared the reserved field "code" on m03.pp_disconnected)', () => {
    assert.doesNotThrow(() => mergeLogCodes(M03_LOG_CODES));
  });

  it('every event code is declared and every field it writes is declared', () => {
    let seen = 0;
    for (const f of FILES) {
      const text = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      const re = /event\(\s*(?:'[a-z]+'|[^,]+?),\s*(?:'([a-z0-9_.]+)'|([^,]+?)),\s*\{([^}]*)\}/g;
      for (const m of text.matchAll(re)) {
        const codes = m[1] !== undefined ? [m[1]] : [...(m[2] ?? '').matchAll(/'([a-z0-9_]+\.[a-z0-9_.]+)'/g)].map((x) => x[1] as string);
        assert.ok(codes.length > 0, `${f}: an event code could not be read: ${m[0].slice(0, 80)}`);
        const fields = [...(m[3] ?? '').matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*:/g)].map((x) => x[1] as string);
        for (const code of codes) {
          const def = CODES()[code];
          assert.ok(def !== undefined, `${f}: undeclared code ${code}`);
          for (const k of fields) assert.ok(k in def.fields || k in CORRELATION_FIELDS, `${f}: ${code} writes undeclared field ${k}`);
          seen += 1;
        }
      }
    }
    assert.ok(seen >= 20, `only ${seen} events read`);
  });
});
