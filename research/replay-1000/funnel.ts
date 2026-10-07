// REPLAY-1000: the gate funnel of one run for the replayed coins, from the bot's own journal and its own stage rules
// (packages/worker/src/run/api.ts `classify`, which the app's funnel uses): per coin, the furthest stage reached over
// all its evaluations (shortlisted, refused before the hard gates, failed a hard gate, passed every hard gate, risk
// approved, entered), risk's refusal codes for coins past the hard gates, and the H16 missing / not-covered reasons
// by input and neededBy (the journal carries them from H16-WHY on; older journals only their detail, from which the
// input is read: "no <input> as of slot N").
//   node research/replay-1000/funnel.ts <run-dir> <coins.json> > funnel.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../../packages/worker/src/run/api.ts';
import type { RunCoin } from './run.ts';

type Line = Record<string, unknown> & { kind: string; ts: string };
type Gate = { gate?: string; code?: string; input?: string; neededBy?: string; detail?: string };

/** Stages, furthest last. */
const STAGES = ['not-evaluated', 'shortlisted', 'refused-before-hard-gates', 'failed-hard-gate', 'passed-hard-gates', 'risk-approved', 'entered'] as const;
type Stage = (typeof STAGES)[number];

const inputOf = (g: Gate): string => {
  if (g.input !== undefined) return g.input;
  const d = g.detail ?? '';
  const m = /^no (\S+) as of slot/.exec(d) ?? /^no head for stream (\S+?):/.exec(d);
  if (m !== null) return `${m[1]} (from detail)`;
  if (d.startsWith('creates log ')) return 'creates log (from detail)';
  if (d.startsWith('rug labels unavailable')) return 'rug labels (from detail)';
  return `? ${d.replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, '<addr>').replace(/\d{4,}/g, 'N').slice(0, 80)}`;
};

export const funnel = (runDir: string, coins: readonly RunCoin[]) => {
  const full = new Set(coins.map((c) => c.mint));
  const stage = new Map<string, Stage>(coins.map((c) => [c.mint, 'not-evaluated']));
  const at = (m: string, s: Stage): void => {
    if (STAGES.indexOf(s) > STAGES.indexOf(stage.get(m)!)) stage.set(m, s);
  };
  const riskCodes = new Map<string, Set<string>>();
  const firstCheck = new Map<string, string>();
  const h16 = new Map<string, { lines: number; coins: Set<string> }>();
  const lines = readFileSync(join(runDir, 'state', 'journal.jsonl'), 'utf8').split('\n');
  for (const s of lines) {
    if (s === '' || (!s.includes('"decision"') && !s.includes('"entry"'))) continue;
    const l = JSON.parse(s) as Line;
    if (l.kind === 'entry') {
      if (full.has(String(l['mint']))) at(String(l['mint']), 'entered');
      continue;
    }
    if (l.kind !== 'decision') continue;
    const r = (l['reasons'] as string[] | undefined) ?? [];
    const [kind, , mint, why] = r;
    if (mint === undefined || !full.has(mint)) continue;
    if (kind === 'shortlist' || kind === 'shortlisted') at(mint, 'shortlisted');
    if (kind === 'risk approved') at(mint, 'risk-approved');
    if (kind !== 'reject' || why === undefined) continue;
    at(mint, 'shortlisted');
    const { check, stage: st } = classify(why);
    const hard = /^hard reject |^hard rejects incomplete/.test(why);
    if (st >= 1) at(mint, 'passed-hard-gates');
    else at(mint, hard ? 'failed-hard-gate' : 'refused-before-hard-gates');
    if (!firstCheck.has(mint)) firstCheck.set(mint, `${check ?? '?'}: ${why.replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, '<addr>').replace(/\d{4,}/g, 'N').slice(0, 90)}`);
    if (check === 'risk' || check === 'size') {
      const codes = riskCodes.get(mint) ?? new Set<string>();
      codes.add(why.replace(/\d{4,}/g, 'N').slice(0, 120));
      riskCodes.set(mint, codes);
    }
    for (const g of (l['gate_reasons'] as Gate[] | undefined) ?? []) {
      if (g.gate !== 'H16' || (g.code !== 'missing' && g.code !== 'not-covered')) continue;
      const k = `${g.code} | input ${inputOf(g)} | neededBy ${g.neededBy ?? '(not journaled)'}`;
      const e = h16.get(k) ?? { lines: 0, coins: new Set<string>() };
      e.lines++;
      e.coins.add(mint);
      h16.set(k, e);
    }
  }
  const byStage = Object.fromEntries(STAGES.map((s) => [s, [...stage.values()].filter((x) => x === s).length]));
  const reached = [...stage.values()].filter((s) => STAGES.indexOf(s) >= STAGES.indexOf('failed-hard-gate')).length;
  const passed = [...stage.entries()].filter(([, s]) => STAGES.indexOf(s) >= STAGES.indexOf('passed-hard-gates')).map(([m]) => m);
  return {
    coins: coins.length, byStage, reachedHardGates: reached, passedEveryHardGate: passed.length,
    passed: passed.map((m) => ({ mint: m, stage: stage.get(m), risk: [...(riskCodes.get(m) ?? [])] })),
    h16: [...h16.entries()].sort((a, b) => b[1].coins.size - a[1].coins.size).map(([k, v]) => ({ reason: k, coins: v.coins.size, lines: v.lines })),
    firstRefusal: Object.fromEntries([...firstCheck.entries()]),
  };
};

const main = () => {
  const [runDir, coinsFile] = process.argv.slice(2);
  const r = funnel(runDir!, JSON.parse(readFileSync(coinsFile!, 'utf8')) as RunCoin[]);
  console.log(JSON.stringify(r, null, 1));
};

if (process.argv[1] === new URL(import.meta.url).pathname) main();
