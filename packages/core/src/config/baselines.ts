// The policies the owner has approved. A session may only be tighter than (or equal to) one of these on every field.
// Raising a limit means adding a new entry here in a reviewed pull request (AGENTS.md "Only the owner"); nothing at
// runtime can add to this list, and the list and its entries are frozen.
import { deepFreeze } from './freeze.ts';
import { policyHash } from './hash.ts';
import { TRIAL_POLICY, type Policy } from './policy.ts';

export const APPROVED_BASELINES: readonly Policy[] = deepFreeze([TRIAL_POLICY]);

/** The baseline a session is measured against when none is named: the trial policy. */
export const DEFAULT_BASELINE_HASH: string = policyHash(TRIAL_POLICY);

export const findBaseline = (hash: string): Policy | undefined => APPROVED_BASELINES.find((b) => policyHash(b) === hash);
