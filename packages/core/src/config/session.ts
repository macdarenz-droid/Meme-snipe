// Session lock. A policy loaded for a running session cannot change: not raised, not tightened, not swapped.
// A different policy means a new session (R15: never edit policy mid-session).
import { policyHash } from './hash.ts';
import type { Policy } from './policy.ts';
import { assertValidPolicy } from './validate.ts';

export type ChangeAttempt = { readonly ok: false; readonly reason: string };

export interface PolicySession {
  /** Deeply frozen. Writing to it throws. */
  readonly policy: Policy;
  readonly versionHash: string;
  readonly running: boolean;
  /** Always refused, with the reason. Any proposed change, tighter or looser, waits for the next session. */
  requestChange(proposed: unknown): ChangeAttempt;
  /** Marks the session over. The policy stays frozen; a new session takes a new policy. */
  end(): void;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

/** Validates a policy, takes a frozen copy, and locks it for the life of the session. */
export const startSession = (policy: Policy): PolicySession => {
  const locked = deepFreeze(structuredClone(assertValidPolicy(policy)));
  const versionHash = policyHash(locked);
  let running = true;
  return {
    policy: locked,
    versionHash,
    get running() { return running; },
    requestChange: (proposed) => {
      const same = (() => { try { return policyHash(proposed) === versionHash; } catch { return false; } })();
      return {
        ok: false,
        reason: running
          ? `Policy ${versionHash.slice(0, 12)} is locked while this session runs${same ? ' (the proposal is identical)' : ''}; the change applies from the next session`
          : `This session has ended; start a new session to use a different policy`,
      };
    },
    end: () => { running = false; },
  };
};
