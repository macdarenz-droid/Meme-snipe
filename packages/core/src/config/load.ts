// Policy files: stored as canonical text (bigint as decimal strings) and loaded back with every check applied.
import { canonicalPolicy, policyHash } from './hash.ts';
import { TRIAL_POLICY, type Policy } from './policy.ts';
import { PolicyError, assertValidPolicy } from './validate.ts';

/** Revives bigint fields (stored as decimal strings) using the trial policy as the template for field types. */
const revive = (template: unknown, value: unknown, path: string): unknown => {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) throw new PolicyError([`${path}: must be a list`]);
    return value.map((v, i) => revive(template[0], v, `${path}[${i}]`));
  }
  if (typeof template === 'object' && template !== null) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PolicyError([`${path}: must be an object`]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = k in template ? revive((template as Record<string, unknown>)[k], v, `${path}.${k}`) : v;
    return out;
  }
  if (typeof template === 'bigint') {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new PolicyError([`${path}: must be a whole number written as text`]);
    return BigInt(value);
  }
  return value;
};

/** The text a policy is saved as. The same text always hashes to the same version. */
export const savePolicy = (policy: Policy): string => canonicalPolicy(assertValidPolicy(policy));

/** Parses and validates saved policy text. Throws PolicyError on anything inconsistent. */
export const loadPolicy = (text: string): { readonly policy: Policy; readonly versionHash: string } => {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new PolicyError(['policy text is not valid JSON']); }
  const policy = assertValidPolicy(revive(TRIAL_POLICY, parsed, 'policy'));
  return { policy, versionHash: policyHash(policy) };
};
