// Session lock. A policy loaded for a running session cannot change: not raised, not tightened, not swapped.
// A different policy means a new session (R15: never edit policy mid-session).
// A session also cannot start looser than an approved baseline: code can load limits and tighten them, never raise them.
import { DEFAULT_BASELINE_HASH, findBaseline } from './baselines.ts';
import { policyHash } from './hash.ts';
import { loadPolicy } from './load.ts';
import type { Policy } from './policy.ts';
import { type Change, applyOverride } from './tighten.ts';
import { PolicyError, policyIssues } from './validate.ts';

export type ChangeAttempt = { readonly ok: false; readonly reason: string };

export interface PolicySession {
  /** Deeply frozen, and a private copy. Writing to it throws. */
  readonly policy: Policy;
  readonly versionHash: string;
  /** The approved policy this session was measured against. */
  readonly baselineHash: string;
  /** What differs from the baseline (every entry is a tightening). */
  readonly changesFromBaseline: readonly Change[];
  readonly running: boolean;
  /** Always refused, with the reason. Any proposed change, tighter or looser, waits for the next session. */
  requestChange(proposed: unknown): ChangeAttempt;
  /** Marks the session over. The policy stays frozen; a new session takes a new policy. */
  end(): void;
}

export interface SessionOptions {
  /** Hash of an approved baseline (see baselines.ts). Defaults to the trial policy. An unknown hash is refused. */
  readonly baselineHash?: string;
}

/**
 * Starts a session on a copy of `proposed`. The copy is taken first and is what gets validated, compared with the baseline,
 * hashed and locked, so the policy cannot change between the checks and the lock. Throws PolicyError if the proposal is
 * invalid, is not tighter than or equal to the baseline on every field, or names an unknown baseline.
 */
export const startSession = (proposed: Policy, options: SessionOptions = {}): PolicySession => {
  const baselineHash = options.baselineHash ?? DEFAULT_BASELINE_HASH;
  const baseline = findBaseline(baselineHash);
  if (!baseline) throw new PolicyError([`baseline ${baselineHash.slice(0, 12)} is not an approved policy version`]);
  const copy: unknown = structuredClone(proposed);
  const issues = policyIssues(copy); // a full policy: a missing field would otherwise be filled in from the baseline
  if (issues.length > 0) throw new PolicyError(issues);
  const result = applyOverride(baseline, copy as Policy);
  if (!result.ok) throw new PolicyError(result.refusals.map((r) => r.reason));
  const policy = result.policy;
  const versionHash = policyHash(policy);
  let running = true;
  return {
    policy,
    versionHash,
    baselineHash,
    changesFromBaseline: result.changes,
    get running() { return running; },
    requestChange: (candidate) => {
      const same = (() => { try { return policyHash(candidate) === versionHash; } catch { return false; } })();
      return {
        ok: false,
        reason: running
          ? `Policy ${versionHash.slice(0, 12)} is locked while this session runs${same ? ' (the proposal is identical)' : ''}; the change applies from the next session`
          : 'This session has ended; start a new session to use a different policy',
      };
    },
    end: () => { running = false; },
  };
};

/** Loads saved policy text (all checks applied) and starts a session on it. */
export const startSessionFromText = (text: string, options: SessionOptions = {}): PolicySession =>
  startSession(loadPolicy(text).policy, options);
