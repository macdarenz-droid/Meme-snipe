// The content hash of a fixture's cases: SHA-256 of their JSON with every object's keys sorted (supplementHash's rule,
// applied at every depth). The fetch script writes it as `meta.sha256`; the tests recompute it.
import { createHash } from 'node:crypto';

const sortedKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortedKeys) : typeof v === 'object' && v !== null ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys((v as Record<string, unknown>)[k])])) : v;

export const casesHash = (cases: unknown): string => createHash('sha256').update(JSON.stringify(sortedKeys(cases))).digest('hex');
