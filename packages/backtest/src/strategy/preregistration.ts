// RES-4's pre-registered hypotheses (research/edge/preregistration.json): one family of trials, read in BT-2's
// UniverseConfig shape. The file is bound by its sha256, which the study configuration pins and the holdout plan records
// with the hypothesis ids. A changed file, or a hypothesis added later, is a different family: it cannot be frozen on
// this window (the registry refuses a changed plan) and needs a new one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FEATURE_IDS, type FeatureId } from '../research/tracker.ts';
import type { FeatureRules, U1Rules, U2Rules, UniverseConfig } from './config.ts';

export interface Preregistration {
  readonly sha256: string;
  /** The hypotheses in file order, each tagged by its id. */
  readonly hypotheses: readonly UniverseConfig[];
}

const bad = (id: string, what: string): never => {
  throw new RangeError(`preregistration ${id}: ${what}`);
};
const int = (id: string, k: string, v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : bad(id, `${k} must be an integer >= 0`));
const u64 = (id: string, k: string, v: unknown): bigint => (typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) ? BigInt(v) : bad(id, `${k} must be a decimal integer string`));
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

const rulesOf = (id: string, r: Record<string, unknown>): U1Rules | U2Rules | FeatureRules => {
  switch (r['kind']) {
    case 'U2':
      return { kind: 'U2', flushBps: int(id, 'flushBps', r['flushBps']), higherLowBps: int(id, 'higherLowBps', r['higherLowBps']), recentMs: int(id, 'recentMs', r['recentMs']), stopBelowLowBps: int(id, 'stopBelowLowBps', r['stopBelowLowBps']) };
    case 'U1':
      return {
        kind: 'U1', rangeMs: int(id, 'rangeMs', r['rangeMs']), recentMs: int(id, 'recentMs', r['recentMs']), volumeTenths: int(id, 'volumeTenths', r['volumeTenths']),
        holderGrowthBps: int(id, 'holderGrowthBps', r['holderGrowthBps']), minMarketCapLamports: u64(id, 'minMarketCapLamports', r['minMarketCapLamports']),
        stopLowMs: int(id, 'stopLowMs', r['stopLowMs']), stopBelowLowBps: int(id, 'stopBelowLowBps', r['stopBelowLowBps']),
      };
    case 'features': {
      const conds = r['conds'];
      if (!Array.isArray(conds) || conds.length === 0) return bad(id, 'a feature rule needs conditions');
      return {
        kind: 'features', stopBelowBps: int(id, 'stopBelowBps', r['stopBelowBps']),
        conds: conds.map((c: Record<string, unknown>) => {
          if (!(FEATURE_IDS as readonly string[]).includes(c['f'] as string)) bad(id, `unknown feature ${String(c['f'])}`);
          if (c['dir'] !== 'ge' && c['dir'] !== 'le') bad(id, `condition direction ${String(c['dir'])}`);
          if (typeof c['t'] !== 'string' || !DECIMAL.test(c['t'])) bad(id, `threshold ${String(c['t'])} must be exact decimal text`);
          return { f: c['f'] as FeatureId, dir: c['dir'] as 'ge' | 'le', t: c['t'] as string };
        }),
      };
    }
    default:
      return bad(id, `rule kind ${String(r['kind'])}`);
  }
};

/** Parses the file's text; refuses it unless its sha256 is `expectedSha256` and every hypothesis is well formed. */
export const parsePreregistration = (text: string, expectedSha256: string): Preregistration => {
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (sha256 !== expectedSha256) throw new RangeError(`preregistration sha256 ${sha256} is not the registered ${expectedSha256}: a changed family needs a new holdout window`);
  const doc = JSON.parse(text) as { hypotheses?: unknown };
  if (!Array.isArray(doc.hypotheses) || doc.hypotheses.length === 0) throw new RangeError('preregistration has no hypotheses');
  const ids = new Set<string>();
  const hypotheses = doc.hypotheses.map((h: Record<string, unknown>) => {
    const id = h['id'];
    if (typeof id !== 'string' || id === '' || ids.has(id)) throw new RangeError(`preregistration: hypothesis id ${String(id)} is missing or repeated`);
    ids.add(id);
    const universe = h['universe'];
    if (universe !== 'U1' && universe !== 'U2') bad(id, `universe ${String(universe)}`);
    const w = h['window'] as Record<string, unknown> | undefined;
    if (w === undefined || w['universe'] !== universe) bad(id, 'its window must be for its universe');
    return {
      id, universe: universe as 'U1' | 'U2',
      window: { universe: universe as string, fromMs: int(id, 'fromMs', w!['fromMs']), toMs: int(id, 'toMs', w!['toMs']), everyMs: int(id, 'everyMs', w!['everyMs']), minQuoteLamports: u64(id, 'minQuoteLamports', w!['minQuoteLamports']) },
      rules: rulesOf(id, h['rules'] as Record<string, unknown>),
      edgePpm: u64(id, 'edgePpm', h['edgePpm']), medianTargetBps: int(id, 'medianTargetBps', h['medianTargetBps']),
    } satisfies UniverseConfig;
  });
  return { sha256, hypotheses };
};

export const loadPreregistration = (path: string, expectedSha256: string): Preregistration => parsePreregistration(readFileSync(path, 'utf8'), expectedSha256);
