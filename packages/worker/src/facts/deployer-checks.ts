// RUG-1c's deployer check, kept per creator (WORKER-1c review: one check a minute per candidate would spend far past
// the Helius halt). A prior mint's `rug` or `clear` answer is final and never read again; `unjudged` (no total
// supply) cannot change either. A mint still `open` (or not read in full) is read again at most once per `minGapMs`
// per creator, whichever candidate asks. A prior mint the index lists that the cache does not hold is always read, so
// a deployer's new launch is never missed. The coverage fact is issued at the asking slot from the cache: a mint
// counts as judged only when its answer is final or was read within `maxLagSlots`; otherwise it is listed `unfetched`,
// so H14 stays not covered (fail closed). Every check also spends from a daily credit cap; past it nothing is read and
// the mints not judged stay unfetched.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { RugCheckConfig, RugConfig } from '../../../core/src/config/rugs.ts';
import { RUG_PREFIX, rugCheckKey, type MintCheck, type RugCheckFact } from '../../../core/src/gates/index.ts';
import { checkDeployer, type RugCheckRequest, type RugHistorySource } from '../providers/deployer-check.ts';

/** Trial cap (supervisor ruling on review of #99): Helius credits all deployer checks may spend in a UTC day. */
export const DEPLOYER_CHECK_CREDITS_PER_DAY = 5_000;
/** The daily spend's file in the worker's state dir. */
export const DEPLOYER_CHECK_SPEND_FILE = 'deployer-check-spend.json';

const DAY_MS = 86_400_000;
const FINAL: ReadonlySet<string> = new Set(['rug', 'clear', 'unjudged']);

interface Cached {
  readonly check: MintCheck;
  /** The as-of slot of the read that gave it. */
  readonly slot: bigint;
}

export interface DeployerChecksOptions {
  readonly history: RugHistorySource;
  readonly rugs: RugConfig;
  readonly config: RugCheckConfig;
  /** Least time between two reads of one creator's mints that are not final yet. */
  readonly minGapMs: number;
  readonly creditsPerDay?: number;
  /**
   * File keeping today's spend across restarts, so a reboot loop cannot spend the cap again. Missing: nothing spent
   * yet. Unreadable: today counts as spent (fail safe on spend).
   */
  readonly spendFile?: string;
}

export interface DeployerCheckOutcome {
  /** `rug:<mint>` labels found by this read, then the creator's coverage fact. */
  readonly facts: readonly { readonly key: string; readonly value: unknown }[];
  /** Every prior mint judged (rug, clear or open) and fresh: what H14 needs. */
  readonly covered: boolean;
  readonly credits: number;
  /** Mints read from the history this time. */
  readonly read: readonly string[];
}

/** Every listed mint judged as rug, clear or open: the only answers H14 accepts (`unjudged` and `unfetched` are not). */
export const checkCovers = (mints: readonly MintCheck[]): boolean => mints.every((m) => m.status === 'rug' || m.status === 'clear' || m.status === 'open');

export class DeployerChecks {
  readonly #o: DeployerChecksOptions;
  readonly #cache = new Map<string, Map<string, Cached>>();
  readonly #lastReread = new Map<string, number>();
  #day = -1;
  #spent = 0;

  constructor(o: DeployerChecksOptions) {
    this.#o = o;
    const f = o.spendFile;
    if (f !== undefined && existsSync(f)) {
      try {
        const v = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
        if (!Number.isSafeInteger(v['day']) || !Number.isSafeInteger(v['spent']) || (v['spent'] as number) < 0) throw new Error('bad spend file');
        this.#day = v['day'] as number;
        this.#spent = v['spent'] as number;
      } catch {
        this.#day = Number.MAX_SAFE_INTEGER;
        this.#spent = Number.MAX_SAFE_INTEGER;
      }
    }
  }

  /** Credits left today. */
  remaining(nowMs: number): number {
    this.#roll(nowMs);
    return Math.max(0, (this.#o.creditsPerDay ?? DEPLOYER_CHECK_CREDITS_PER_DAY) - this.#spent);
  }

  async check(req: RugCheckRequest, nowMs: number): Promise<DeployerCheckOutcome> {
    const o = this.#o;
    const cache = this.#cache.get(req.creator) ?? new Map<string, Cached>();
    this.#cache.set(req.creator, cache);
    const last = this.#lastReread.get(req.creator);
    const rereadDue = last === undefined || nowMs - last >= o.minGapMs;
    const pending = req.mints.filter((m) => {
      const c = cache.get(m.mint);
      return c === undefined || (!FINAL.has(c.check.status) && rereadDue);
    });
    const left = this.remaining(nowMs);
    let credits = 0;
    const labels: { key: string; value: unknown }[] = [];
    const read: string[] = [];
    if (pending.length > 0 && left > 0) {
      const r = await checkDeployer(o.history, o.rugs, { ...o.config, creditCapPerCandidate: Math.min(o.config.creditCapPerCandidate, left) }, { ...req, mints: pending }, nowMs);
      credits = r.fact.credits;
      this.#spent += credits;
      this.#save();
      // The creator's gap runs from its last read of any kind: a first read counts as a read of its open answers.
      this.#lastReread.set(req.creator, nowMs);
      for (const m of r.fact.mints) {
        // A rug is final and never read again, so its label goes out once.
        if (m.status === 'rug' && m.label !== undefined) labels.push({ key: `${RUG_PREFIX}${m.mint}`, value: m.label });
        cache.set(m.mint, { check: m, slot: req.asOf.slot });
        read.push(m.mint);
      }
    }
    const oldest = req.asOf.slot - BigInt(o.config.maxLagSlots);
    const mints: MintCheck[] = req.mints.map((m) => {
      const c = cache.get(m.mint);
      if (c !== undefined && (FINAL.has(c.check.status) || (c.slot >= oldest && c.slot <= req.asOf.slot))) return c.check;
      const why = c === undefined ? (left > 0 ? 'not read' : 'the daily deployer-check credits are spent') : `last read at slot ${c.slot}, more than ${o.config.maxLagSlots} slots ago`;
      return { mint: m.mint, createdAtMs: m.createdAtMs, status: 'unfetched', detail: why };
    });
    const fact: RugCheckFact = {
      obs: { provider: 'rug-check', slot: req.asOf.slot, receivedAt: nowMs, quality: [], commitment: 'confirmed' },
      creator: req.creator, version: o.config.version, fromMs: req.fromMs, asOfMs: req.asOfMs, mints, credits,
    };
    const covered = checkCovers(mints);
    return { facts: [...labels, { key: rugCheckKey(req.creator), value: fact }], covered, credits, read };
  }

  #save(): void {
    const f = this.#o.spendFile;
    if (f === undefined) return;
    writeFileSync(`${f}.tmp`, JSON.stringify({ day: this.#day, spent: this.#spent }));
    renameSync(`${f}.tmp`, f);
  }

  #roll(nowMs: number): void {
    const day = Math.floor(nowMs / DAY_MS);
    // An unreadable spend file counts today as spent: only a later UTC day starts again.
    if (this.#day === Number.MAX_SAFE_INTEGER) {
      this.#day = day;
      return;
    }
    if (day !== this.#day) {
      this.#day = day;
      this.#spent = 0;
    }
  }
}
