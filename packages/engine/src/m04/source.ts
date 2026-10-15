// A-M04-03 transport seam (the D03 switch). M04 reads pool accounts through a `PoolSource`; both sources deliver the
// same `SourceRecord`s, so snapshots, lag and recording are identical whichever one runs.
// - `poll` (D03 default (a), the only enabled source): per priority class a timer at the class interval (positions
//   500 ms at P1, candidates 1 s at P2, tail 10 s at P4; logic 2), each pool's accounts kept together in batches of at
//   most `max_accounts_per_call`. A tick never overlaps the class's previous one (`poll_skipped_total{class}`), and a
//   late tick runs once, with no catch-up burst (edge 5). A failed read records nothing (edge 2: never fabricate).
// - `account_subscribe`: a stub. It refuses to start unless `pool_tracker.subscribe.enabled`, and even then without a
//   transport, because its method names, message shape and metering (2 credits per 0.1 MB on Helius [LD-V01]) are
//   VERIFY items (A-31). A transport that disconnects falls back to polling those pools at once and never reconnects
//   on its own (the reconnect-storm finding of red team C, C3: a storm can never spend more than polling does).
import type { Pubkey, Slot } from '@bot/types';
import { intervalOf, priorityOf, type M04Settings } from './settings.ts';
import type { AccountsReader, PoolClass, RawAccount, SchedulerPort, TrackerLog, TrackerMetrics } from './types.ts';

export interface SourcePool { poolId: Pubkey; accounts: Pubkey[]; cls: PoolClass }
/** One delivery: each pool's accounts in the order asked, read at one context slot from one provider. */
export interface SourceRecord { entries: Array<{ poolId: Pubkey; accounts: Array<RawAccount | null> }>; contextSlot: Slot; providerLabel: string; latencyMs: number; cls: PoolClass }

export interface PoolSource {
  kind: 'poll' | 'account_subscribe';
  /** The pools to deliver from now on (replaces the previous set). */
  start(pools: readonly SourcePool[]): void;
  stop(): void;
  onAccounts(h: (r: SourceRecord) => void): () => void;
}

const CLASSES: readonly PoolClass[] = ['position', 'candidate', 'tail'];

/** Packs pools into batches of at most `max` accounts, a pool's accounts never split. */
export function packBatches(pools: readonly SourcePool[], max: number): SourcePool[][] {
  const out: SourcePool[][] = [];
  let cur: SourcePool[] = [];
  let n = 0;
  for (const p of pools) {
    if (n + p.accounts.length > max && cur.length > 0) { out.push(cur); cur = []; n = 0; }
    cur.push(p);
    n += p.accounts.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** The `code` of something thrown, or `E_THROWN` (Z07-34: background failures are logged, never unhandled). */
export const thrownCode = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === undefined ? 'E_THROWN' : String(code);
};

export function createPollSource(deps: { reader: AccountsReader; scheduler: SchedulerPort; settings: M04Settings; log: TrackerLog; metrics?: TrackerMetrics }): PoolSource {
  const handlers = new Set<(r: SourceRecord) => void>();
  let pools: readonly SourcePool[] = [];
  const timers = new Map<PoolClass, () => void>();
  const busy = new Set<PoolClass>();

  async function tick(cls: PoolClass): Promise<void> {
    const mine = pools.filter((p) => p.cls === cls);
    if (mine.length === 0) return;
    if (busy.has(cls)) {
      deps.metrics?.counter('poll_skipped_total', { class: cls });
      return;
    }
    busy.add(cls);
    try {
      await Promise.all(packBatches(mine, deps.settings.maxAccountsPerCall).map(async (batch) => {
        const r = await deps.reader.read(batch.flatMap((p) => p.accounts), { priority: priorityOf(cls) });
        if (!r.ok) {
          deps.log.event('warn', 'm04.poll_failed', { class: cls, error_code: r.error.code });
          return;
        }
        deps.metrics?.observe('poll_batch_latency_ms', { provider: r.value.providerLabel }, r.value.latencyMs);
        let at = 0;
        const entries = batch.map((p) => {
          const accounts = r.value.accounts.slice(at, at + p.accounts.length);
          at += p.accounts.length;
          return { poolId: p.poolId, accounts };
        });
        for (const h of handlers) h({ entries, contextSlot: r.value.contextSlot, providerLabel: r.value.providerLabel, latencyMs: r.value.latencyMs, cls });
      }));
    } finally {
      busy.delete(cls);
    }
  }

  function arm(cls: PoolClass, dueAt: number): void {
    const now = deps.scheduler.nowMs();
    timers.set(cls, deps.scheduler.set(() => {
      const started = deps.scheduler.nowMs();
      // A tick that throws (a reader or a handler) is logged; the next tick runs as scheduled (Z07-34).
      void tick(cls).catch((e: unknown) => {
        deps.log.event('error', 'm04.poll_failed', { class: cls, error_code: thrownCode(e) });
      });
      const interval = intervalOf(deps.settings, cls);
      // Edge 5: a tick late by a whole interval or more runs once and the next is one interval after it (no burst).
      arm(cls, dueAt + interval > started ? dueAt + interval : started + interval);
    }, Math.max(0, dueAt - now)));
  }

  return {
    kind: 'poll',
    start(next) {
      pools = [...next];
      for (const cls of CLASSES) if (!timers.has(cls)) arm(cls, deps.scheduler.nowMs() + intervalOf(deps.settings, cls));
    },
    stop() {
      for (const cancel of timers.values()) cancel();
      timers.clear();
      pools = [];
    },
    onAccounts(h) {
      handlers.add(h);
      return () => { handlers.delete(h); };
    },
  };
}

/** A subscription transport (A-M04-03); none is built until its VERIFY items are resolved (A-31, D03). */
export interface SubscribeTransport {
  open(pools: readonly SourcePool[], deliver: (r: SourceRecord) => void, closed: () => void): void;
  close(): void;
}

export class SubscribeRefused extends Error {
  readonly code: 'E_SUBSCRIBE_DISABLED' | 'E_SUBSCRIBE_UNVERIFIED';
  constructor(code: 'E_SUBSCRIBE_DISABLED' | 'E_SUBSCRIBE_UNVERIFIED') {
    super(code);
    this.code = code;
  }
}

/**
 * The `account_subscribe` stub: refuses to start while `pool_tracker.subscribe.enabled` is false or no verified
 * transport exists. With a transport, a close hands the pools to `fallback` (polling) at once and never reopens.
 */
export function createSubscribeSource(deps: { enabled: boolean; transport?: SubscribeTransport; fallback: PoolSource; log: TrackerLog }): PoolSource & { fellBack(): boolean } {
  const handlers = new Set<(r: SourceRecord) => void>();
  let fell = false;
  let detach: (() => void) | null = null;
  return {
    kind: 'account_subscribe',
    start(pools) {
      if (!deps.enabled) throw new SubscribeRefused('E_SUBSCRIBE_DISABLED');
      const t = deps.transport;
      if (t === undefined) throw new SubscribeRefused('E_SUBSCRIBE_UNVERIFIED');
      if (fell) { deps.fallback.start(pools); return; }
      t.open(pools, (r) => { for (const h of handlers) h(r); }, () => {
        deps.log.event('warn', 'm04.subscribe_closed', { pools: pools.length });
        fell = true;
        detach ??= deps.fallback.onAccounts((r) => { for (const h of handlers) h(r); });
        deps.fallback.start(pools);
      });
    },
    stop() {
      deps.transport?.close();
      deps.fallback.stop();
    },
    onAccounts(h) {
      handlers.add(h);
      return () => { handlers.delete(h); };
    },
    fellBack: () => fell,
  };
}
