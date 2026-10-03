import { TRIAL_POLICY, type Policy } from '../../src/config/index.ts';

type Obj = Record<string, unknown>;

/** A copy of the trial policy with one leaf moved by `delta`. List fields are changed in every entry, one entry per copy. */
export const withLeaf = (path: string, delta: number): Policy[] => {
  const segments = path.split('.').slice(1);
  const base = (): Obj => structuredClone(TRIAL_POLICY) as unknown as Obj;
  const targets = (root: Obj): Obj[] => {
    let nodes: Obj[] = [root];
    for (const seg of segments.slice(0, -1)) nodes = nodes.flatMap((n) => (Array.isArray(n[seg]) ? (n[seg] as Obj[]) : [n[seg] as Obj]));
    return nodes;
  };
  const count = targets(base()).length;
  const leaf = segments[segments.length - 1] as string;
  return Array.from({ length: count }, (_, i) => {
    const root = base();
    const node = targets(root)[i] as Obj;
    const v = node[leaf];
    node[leaf] = typeof v === 'bigint' ? v + BigInt(delta) : typeof v === 'number' ? v + delta : `${String(v)}!`;
    return root as unknown as Policy;
  });
};

export const clone = (): Obj => structuredClone(TRIAL_POLICY) as unknown as Obj;
