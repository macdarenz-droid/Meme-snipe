// A-M05-01 candidate state machine, prefilters, blacklist and cooldown (card Z09; ARCH 7.5, M05; C-15, C-44).
// Every transition is one edge of `ALLOWED` (ARCH 7.5), persisted with its reason through `CandidateStore` (M24: the
// candidate row by compare-and-set on its version, the `candidate_event` row and the outbox event in one transaction).
// A transition the store refuses (`E_STATE_CHANGED`, a write failure) is not applied in memory either.
//
// Phase 0: `screening_required = false` sends a candidate that passes the prefilter straight to `eligible` with reason
// `phase0_unscreened`; that setting is valid only while no strategy is enabled in any mode (C-44), so it never feeds
// a trade. Screening verdicts, signals and positions (Phase 1+) arrive through the handlers below (test doubles now).
//
// Builder readings (DECISIONS Z09-U1..U3; ARCH 7.5 is silent on these):
// - `stale` → `evicted`: A-M05-02 evicts stale pools first, so a stale pool can be evicted;
// - a timed blacklist that expires re-runs the prefilter (to `prefiltered_out`, `screening` or `eligible`);
// - a screening backlog drop (logic 13) goes to `rejected` (reason `backlog`), retried after 6 h like a soft reject.
import { createHash } from 'node:crypto';
import { canonicalJson, type CandidateState, type Lamports, type Pubkey, type Result, type UnixMs } from '@bot/types';

export const STATES: readonly CandidateState[] = ['discovered', 'prefiltered_out', 'screening', 'rejected', 'eligible', 'watched', 'signalled',
  'in_position', 'cooldown', 'blacklisted', 'stale', 'evicted'];

/** ARCH 7.5 edges (plus the readings in the header). `null` is "no candidate yet". */
export const ALLOWED: ReadonlyMap<CandidateState | null, ReadonlySet<CandidateState>> = new Map<CandidateState | null, ReadonlySet<CandidateState>>([
  [null, new Set<CandidateState>(['discovered'])],
  ['discovered', new Set<CandidateState>(['prefiltered_out', 'screening', 'eligible', 'blacklisted'])],
  ['prefiltered_out', new Set<CandidateState>(['screening', 'eligible', 'blacklisted'])],
  ['screening', new Set<CandidateState>(['rejected', 'eligible', 'blacklisted'])],
  ['rejected', new Set<CandidateState>(['screening', 'eligible', 'blacklisted'])],
  ['eligible', new Set<CandidateState>(['watched', 'blacklisted'])],
  ['watched', new Set<CandidateState>(['signalled', 'stale', 'rejected', 'evicted', 'blacklisted'])],
  ['signalled', new Set<CandidateState>(['watched', 'in_position', 'blacklisted'])],
  ['in_position', new Set<CandidateState>(['cooldown', 'blacklisted'])],
  ['cooldown', new Set<CandidateState>(['watched', 'evicted', 'blacklisted'])],
  ['stale', new Set<CandidateState>(['watched', 'evicted', 'blacklisted'])],
  ['evicted', new Set<CandidateState>(['eligible', 'blacklisted'])],
  ['blacklisted', new Set<CandidateState>(['prefiltered_out', 'screening', 'eligible'])],
]);
export const isAllowed = (from: CandidateState | null, to: CandidateState): boolean => ALLOWED.get(from)?.has(to) === true;

export interface CandidateRecord {
  candidateId: string; mint: Pubkey; poolId: Pubkey; venue: string; state: CandidateState;
  firstSeenAtMs: UnixMs; cooldownUntilMs: UnixMs | null; reasons: string[]; version: number;
  /** NEW (C-15): when the pool's migration landed (A-M03-02); the only age proof while D30 is parked. */
  migratedAtMs: UnixMs | null;
  /** NEW: the effective quote depth of the last prefilter (A-M05-02 orders by it). */
  depthLamports: Lamports;
  /** NEW: when the current state started and when a retry (prefilter, soft reject, blacklist expiry) is due. */
  sinceMs: UnixMs; retryAtMs: UnixMs | null;
}
export interface Transition { candidateId: string; poolId: Pubkey; mint: Pubkey; from: CandidateState | null; to: CandidateState; reason: string; atMs: UnixMs }

export interface CandidateStore {
  load(): CandidateRecord[];
  /** Persists `next` (insert when `prev` is null, else compare-and-set on `prev.version`) and the transition. */
  apply(prev: CandidateRecord | null, next: CandidateRecord, t: Transition): Result<void, { code: 'E_STATE_CHANGED' | 'E_WRITE' }>;
}

/** What the prefilter reads: the venue, quote mint, per-side fee and effective depth of one snapshot. */
export interface PrefilterFacts { venue: string; quoteMint: Pubkey; feeTotalBps: number; effectiveQuoteLamports: bigint }
/** One strategy's universe limits (`strategy.<id>.universe.*`). */
export interface UniverseLimits { strategyId: string; feeCeilingBps: number; minDepthLamports: bigint; minAgeMs: number }
/** MR 30 bps / 300 SOL / 24 h; PM 125 bps / 85 SOL / 20 min after migration (A-M05-01 config). */
export const MR_LIMITS: UniverseLimits = { strategyId: 'mr-01', feeCeilingBps: 30, minDepthLamports: 300_000_000_000n, minAgeMs: 86_400_000 };
export const PM_LIMITS: UniverseLimits = { strategyId: 'pm-01', feeCeilingBps: 125, minDepthLamports: 85_000_000_000n, minAgeMs: 1_200_000 };
/**
 * The named limit sets the Phase 0 recording may use (ruling Z09-2): `universe.phase0_limit_set`, default `pm01`, never
 * implicit. MR-01's set stays here, unused while MR-01 is parked (C-76).
 */
export const LIMIT_SETS: Readonly<Record<'pm01' | 'mr01', readonly UniverseLimits[]>> = { pm01: [PM_LIMITS], mr01: [MR_LIMITS] };
export type LimitSetId = keyof typeof LIMIT_SETS;
/** SHA-256 of the set's canonical JSON (bigints as decimal strings): the manifest names the set and this hash. */
export function limitSetHash(limits: readonly UniverseLimits[]): string {
  return createHash('sha256').update(canonicalJson(limits.map((l) => ({ ...l, minDepthLamports: l.minDepthLamports.toString() }))), 'utf8').digest('hex');
}

export interface UniverseConfig {
  screeningRequired: boolean;
  cooldownMs: number; prefilterRetryMs: number; staleToStateMs: number; screenBacklogMax: number;
  /** The named set (`universe.phase0_limit_set`) and its limits; `limits` must be that set's (checked). */
  limitSetId: string;
  limits: readonly UniverseLimits[];
  /** Strategies enabled in any mode (C-44: `screening_required = false` needs none). */
  enabledStrategies: number;
  /** Venues the prefilter allows and that are specified (PumpSwap; Raydium after A-M01-06). */
  venues: readonly string[];
}
export const UNIVERSE_DEFAULTS: UniverseConfig = {
  screeningRequired: true, cooldownMs: 1_800_000, prefilterRetryMs: 21_600_000, staleToStateMs: 30_000, screenBacklogMax: 100,
  limitSetId: 'pm01', limits: LIMIT_SETS.pm01, enabledStrategies: 0, venues: ['pumpswap'],
};
export const SOFT_RETRY_MS = 21_600_000;
export const HONEYPOT_BLACKLIST_MS = 86_400_000;

export function checkUniverseConfig(c: UniverseConfig): string | null {
  if (!c.screeningRequired && c.enabledStrategies > 0) return 'universe.screening_required = false is allowed only while no strategy is enabled (C-44)';
  const range = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
  if (!range(c.cooldownMs, 0, 86_400_000)) return 'universe.cooldown_ms must be 0-86,400,000';
  if (!range(c.prefilterRetryMs, 600_000, 86_400_000)) return 'universe.prefilter_retry_ms must be 600,000-86,400,000';
  if (!range(c.staleToStateMs, 5_000, 600_000)) return 'universe.stale_to_state_ms must be 5,000-600,000';
  if (!range(c.screenBacklogMax, 10, 1_000)) return 'universe.screen_backlog_max must be 10-1,000';
  if (c.limits.length === 0) return 'at least one strategy universe limit set is needed';
  const named = (LIMIT_SETS as Readonly<Record<string, readonly UniverseLimits[]>>)[c.limitSetId];
  if (named === undefined || limitSetHash(named) !== limitSetHash(c.limits)) return `universe.phase0_limit_set "${c.limitSetId}" must name the limits in use (Z09-2)`;
  for (const l of c.limits) if (!range(l.feeCeilingBps, 0, 10_000) || l.minDepthLamports < 0n || !range(l.minAgeMs, 0, 30 * 86_400_000)) return `bad universe limits for ${l.strategyId}`;
  return null;
}

export type TerminalKind = 'closed' | 'open_failed' | 'written_off';
export interface UniverseDeps {
  config: UniverseConfig;
  store: CandidateStore;
  nowMs(): UnixMs;
  newId(): string;
  wsolMint: Pubkey;
  /** The latest prefilter facts for a pool (M04's latest snapshot, or the verification read), or null. */
  facts(poolId: Pubkey): PrefilterFacts | null;
  /** M22 lists (read): mints that never become candidates for new entries. */
  lists: { isWrittenOff(mint: Pubkey): boolean; isUnsolicited(mint: Pubkey): boolean };
  publish(t: Transition): void;
  log: { event(level: 'debug' | 'info' | 'warn', code: string, fields: Readonly<Record<string, unknown>>): void };
}

export interface Universe {
  onDiscovery(e: { poolId: Pubkey; baseMint: Pubkey; quoteMint: Pubkey; venue: string; verifiedOnChain: boolean; migratedAtMs: UnixMs | null }, facts?: PrefilterFacts | null): void;
  blacklist(mint: Pubkey, reason: string, untilMs: UnixMs | null): void;
  candidate(poolId: Pubkey): CandidateRecord | null;
  candidates(): CandidateRecord[];
  /** Phase 1+: M06 verdicts (soft reject, hard fail kinds, eligible). */
  onScreen(poolId: Pubkey, v: { verdict: 'eligible' } | { verdict: 'rejected' } | { verdict: 'hard_fail'; kind: 'authority' | 'extension' | 'honeypot' | 'lp' }): void;
  /** A-M05-02 granted a slot or evicted the pool. */
  onWatched(poolId: Pubkey): void;
  onEvicted(poolId: Pubkey, reason: string): void;
  onSignal(poolId: Pubkey): void;
  onRiskDecision(poolId: Pubkey, accepted: boolean): void;
  onPositionTerminal(poolId: Pubkey, kind: TerminalKind): void;
  /** M04 `pool.stale` / `pool.fresh`. */
  onStale(poolId: Pubkey, sinceMs: UnixMs): void;
  onFresh(poolId: Pubkey): void;
  /** M06 `token.authority_changed`, A-M02-05 `decoder.unknown_layout`, A-M01-04 `venue.pool_quarantined`. */
  onAuthorityChanged(mint: Pubkey): void;
  onUnknownLayout(poolId: Pubkey): void;
  onQuarantine(poolId: Pubkey): void;
  /** Timers: prefilter retries, soft-reject retries, cooldowns, stale, blacklist expiry. */
  tick(): void;
}

const SOL = 1_000_000_000n;

export function createUniverse(deps: UniverseDeps): Universe {
  const problem = checkUniverseConfig(deps.config);
  if (problem !== null) throw { code: 'E_CONFIG', message: problem };
  const cfg = deps.config;
  const byPool = new Map<Pubkey, CandidateRecord>();
  const blacklisted = new Map<Pubkey, { untilMs: UnixMs | null; reason: string }>();
  const staleSince = new Map<Pubkey, number>();
  for (const r of deps.store.load()) {
    byPool.set(r.poolId, r);
    // A blacklisted candidate keeps its expiry in `retryAtMs` (null: permanent), so the blacklist survives a restart.
    if (r.state === 'blacklisted' && !blacklisted.has(r.mint)) blacklisted.set(r.mint, { untilMs: r.retryAtMs, reason: r.reasons[0] ?? 'restored' });
  }

  /** Applies one transition; false (and nothing changes) when the edge is undefined or the store refuses it. */
  function move(r: CandidateRecord | null, base: Omit<CandidateRecord, 'state' | 'version' | 'sinceMs' | 'retryAtMs' | 'reasons'> & Partial<CandidateRecord>, to: CandidateState, reason: string, o: { retryAtMs?: UnixMs | null; reasons?: string[] } = {}): boolean {
    const from = r?.state ?? null;
    if (!isAllowed(from, to)) {
      deps.log.event('warn', 'm05.transition_refused', { from: from ?? 'none', to, reason });
      return false;
    }
    const now = deps.nowMs();
    const next: CandidateRecord = {
      ...(r ?? {}), ...base, state: to, reasons: o.reasons ?? [reason], version: r === null ? 1 : r.version + 1, sinceMs: now,
      retryAtMs: o.retryAtMs ?? null, cooldownUntilMs: to === 'cooldown' ? ((now + cfg.cooldownMs) as UnixMs) : null,
    } as CandidateRecord;
    // The event's reason carries the detail (the limits a pass met), so a manifest rebuilt from M24 shows it too.
    const t: Transition = { candidateId: next.candidateId, poolId: next.poolId, mint: next.mint, from, to, reason: o.reasons === undefined ? reason : o.reasons.join(';'), atMs: now };
    const w = deps.store.apply(r, next, t);
    if (!w.ok) {
      deps.log.event('warn', 'm05.transition_not_applied', { from: from ?? 'none', to, error_code: w.error.code });
      return false;
    }
    byPool.set(next.poolId, next);
    deps.publish(t);
    deps.log.event(to === 'blacklisted' ? 'info' : 'debug', to === 'blacklisted' ? 'm05.blacklisted' : 'm05.transition', { pool: next.poolId, from: from ?? 'none', to, reason });
    return true;
  }
  const to = (r: CandidateRecord, state: CandidateState, reason: string, o: { retryAtMs?: UnixMs | null; reasons?: string[] } = {}): boolean => move(r, r, state, reason, o);

  function isBlacklisted(mint: Pubkey): { reason: string } | null {
    const b = blacklisted.get(mint);
    if (b === undefined) return null;
    if (b.untilMs !== null && b.untilMs <= deps.nowMs()) return null;
    return b;
  }

  /** Logic 2: the cheap prefilter on one snapshot; the reasons of a pass describe which limits it met (manifest). */
  function prefilter(r: CandidateRecord, f: PrefilterFacts | null): { pass: boolean; reasons: string[]; depth: Lamports } {
    if (f === null) return { pass: false, reasons: ['no_snapshot'], depth: r.depthLamports };
    const depth = (f.effectiveQuoteLamports > 0n ? f.effectiveQuoteLamports : 0n) as Lamports;
    const fail: string[] = [];
    if (!cfg.venues.includes(f.venue)) fail.push(`venue=${f.venue}`);
    if (f.quoteMint !== deps.wsolMint) fail.push('quote_not_wsol');
    if (isBlacklisted(r.mint) !== null) fail.push('blacklisted');
    const ageMs = r.migratedAtMs === null ? null : deps.nowMs() - r.migratedAtMs;
    const sets = cfg.limits.map((l) => {
      const why: string[] = [];
      if (f.feeTotalBps > l.feeCeilingBps) why.push(`fee=${f.feeTotalBps}bps>${l.feeCeilingBps}`);
      if (depth < l.minDepthLamports) why.push(`depth=${depth / SOL}SOL<${l.minDepthLamports / SOL}`);
      if (ageMs === null) why.push('age=unknown');
      else if (ageMs < l.minAgeMs) why.push(`age<${l.minAgeMs}ms`);
      return { l, why };
    });
    const ok = sets.find((s) => s.why.length === 0);
    if (fail.length === 0 && ok !== undefined) {
      return { pass: true, depth, reasons: [`set=${ok.l.strategyId};fee=${f.feeTotalBps}bps;depth=${depth / SOL}SOL;age>=${ok.l.minAgeMs}ms`] };
    }
    return { pass: false, depth, reasons: [...fail, ...sets.flatMap((s) => s.why.map((w) => `${s.l.strategyId}:${w}`))] };
  }

  /** From `discovered`, `prefiltered_out`, `rejected` (retry) or an expired blacklist: prefilter, then screen or Phase 0. */
  function evaluate(r: CandidateRecord, f: PrefilterFacts | null = deps.facts(r.poolId)): void {
    const p = prefilter(r, f);
    const now = deps.nowMs();
    if (!p.pass) {
      if (r.state === 'prefiltered_out') {
        byPool.set(r.poolId, { ...r, retryAtMs: (now + cfg.prefilterRetryMs) as UnixMs, reasons: p.reasons });   // stays (no transition)
        return;
      }
      move(r, { ...r, depthLamports: p.depth }, 'prefiltered_out', 'prefilter', { reasons: p.reasons, retryAtMs: (now + cfg.prefilterRetryMs) as UnixMs });
      return;
    }
    if (cfg.screeningRequired) {
      if (r.state === 'screening') return;
      move(r, { ...r, depthLamports: p.depth }, 'screening', 'prefilter_pass', { reasons: p.reasons });
      const backlog = [...byPool.values()].filter((c) => c.state === 'screening').sort((a, b) => a.sinceMs - b.sinceMs || a.firstSeenAtMs - b.firstSeenAtMs);
      for (const c of backlog.slice(0, Math.max(0, backlog.length - cfg.screenBacklogMax))) to(c, 'rejected', 'backlog', { retryAtMs: (now + SOFT_RETRY_MS) as UnixMs });
      return;
    }
    move(r, { ...r, depthLamports: p.depth }, 'eligible', 'phase0_unscreened', { reasons: [...p.reasons, 'phase0_unscreened'] });
  }

  function blacklistOne(r: CandidateRecord, reason: string): void {
    const b = blacklisted.get(r.mint);
    if (r.state !== 'blacklisted') to(r, 'blacklisted', reason, { retryAtMs: b?.untilMs ?? null });
  }

  const api: Universe = {
    onDiscovery(e, facts) {
      if (!e.verifiedOnChain) return;                                                // logic 1: unverified discoveries are ignored
      const existing = byPool.get(e.poolId);
      if (existing !== undefined) {
        if (existing.mint !== e.baseMint) return;
        if (existing.state === 'prefiltered_out') evaluate(existing, facts ?? deps.facts(e.poolId));   // re-evaluated on the next discovery
        return;
      }
      if (deps.lists.isWrittenOff(e.baseMint) || deps.lists.isUnsolicited(e.baseMint)) {
        deps.log.event('info', 'm05.not_a_candidate', { pool: e.poolId, reason: deps.lists.isWrittenOff(e.baseMint) ? 'written_off' : 'unsolicited' });
        if (deps.lists.isWrittenOff(e.baseMint)) blacklisted.set(e.baseMint, { untilMs: null, reason: 'written_off' });
        return;
      }
      const now = deps.nowMs();
      const base = { candidateId: deps.newId(), mint: e.baseMint, poolId: e.poolId, venue: e.venue, firstSeenAtMs: now, cooldownUntilMs: null,
        migratedAtMs: e.migratedAtMs, depthLamports: 0n as Lamports };
      if (!move(null, base, 'discovered', 'discovery')) return;
      const r = byPool.get(e.poolId) as CandidateRecord;
      const b = isBlacklisted(e.baseMint);
      if (b !== null) { blacklistOne(r, b.reason); return; }
      evaluate(r, facts ?? deps.facts(e.poolId));
    },
    blacklist(mint, reason, untilMs) {
      blacklisted.set(mint, { untilMs, reason });
      for (const r of [...byPool.values()]) if (r.mint === mint) blacklistOne(r, reason);
    },
    candidate: (poolId) => byPool.get(poolId) ?? null,
    candidates: () => [...byPool.values()],
    onScreen(poolId, v) {
      const r = byPool.get(poolId);
      if (r === undefined || (r.state !== 'screening' && r.state !== 'watched')) return;
      const now = deps.nowMs();
      if (v.verdict === 'eligible') { if (r.state === 'screening') to(r, 'eligible', 'screen=eligible'); return; }
      if (v.verdict === 'rejected') { to(r, 'rejected', 'screen_soft', { retryAtMs: (now + SOFT_RETRY_MS) as UnixMs }); return; }
      api.blacklist(r.mint, `screen_${v.kind}`, v.kind === 'honeypot' ? ((now + HONEYPOT_BLACKLIST_MS) as UnixMs) : null);
    },
    onWatched(poolId) {
      const r = byPool.get(poolId);
      if (r !== undefined && (r.state === 'eligible' || r.state === 'evicted')) {
        if (r.state === 'evicted' && !to(r, 'eligible', 'requeued')) return;
        to(byPool.get(poolId) as CandidateRecord, 'watched', 'slot');
      }
    },
    onEvicted(poolId, reason) {
      const r = byPool.get(poolId);
      if (r !== undefined && (r.state === 'watched' || r.state === 'stale')) to(r, 'evicted', reason);
    },
    onSignal(poolId) {
      const r = byPool.get(poolId);
      if (r?.state === 'watched') to(r, 'signalled', 'proposal');
    },
    onRiskDecision(poolId, accepted) {
      const r = byPool.get(poolId);
      if (r?.state === 'signalled') to(r, accepted ? 'in_position' : 'watched', accepted ? 'risk_accept' : 'risk_reject');
    },
    onPositionTerminal(poolId, kind) {
      const r = byPool.get(poolId);
      if (r === undefined) { deps.log.event('warn', 'm05.unknown_candidate', { pool: poolId, event: kind }); return; }   // edge case 2
      if (r.state !== 'in_position') return;
      if (!to(r, 'cooldown', `position_${kind}`)) return;
      if (kind === 'written_off') api.blacklist(r.mint, 'written_off', null);       // CA-15
    },
    onStale(poolId, sinceMs) {
      if (!staleSince.has(poolId)) staleSince.set(poolId, sinceMs);
      api.tick();
    },
    onFresh(poolId) {
      staleSince.delete(poolId);
      const r = byPool.get(poolId);
      if (r?.state === 'stale') to(r, 'watched', 'fresh');
    },
    onAuthorityChanged(mint) { api.blacklist(mint, 'authority_changed', null); },
    onUnknownLayout(poolId) {
      const r = byPool.get(poolId);
      if (r !== undefined) blacklistOne(r, 'unknown_layout');
    },
    onQuarantine(poolId) {
      const r = byPool.get(poolId);
      if (r !== undefined) blacklistOne(r, 'pool_quarantined');
    },
    tick() {
      const now = deps.nowMs();
      for (const r of [...byPool.values()]) {
        const cur = byPool.get(r.poolId) as CandidateRecord;
        if (cur.state === 'watched') {
          const s = staleSince.get(cur.poolId);
          if (s !== undefined && now - s > cfg.staleToStateMs) to(cur, 'stale', 'stale_data');
        } else if (cur.state === 'cooldown' && cur.cooldownUntilMs !== null && cur.cooldownUntilMs <= now) {
          const p = prefilter(cur, deps.facts(cur.poolId));
          if (isBlacklisted(cur.mint) !== null) blacklistOne(cur, (isBlacklisted(cur.mint) as { reason: string }).reason);
          else to(cur, p.pass ? 'watched' : 'evicted', p.pass ? 'cooldown_done' : 'cooldown_rescreen_failed');
        } else if ((cur.state === 'prefiltered_out' || cur.state === 'rejected') && cur.retryAtMs !== null && cur.retryAtMs <= now) {
          evaluate(cur);
        } else if (cur.state === 'blacklisted' && cur.retryAtMs !== null && cur.retryAtMs <= now && isBlacklisted(cur.mint) === null) {
          evaluate(cur);
        }
      }
    },
  };
  return api;
}
