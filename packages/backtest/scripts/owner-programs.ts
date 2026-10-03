// Builds the owner-program supplement (src/dataset/owner-programs.ts) for a schema-3 dataset: every off-curve owner
// seen in its trade and movement rows, looked up once with getMultipleAccounts.
//
//   RPC_URL=<provider url> RPC_NAME=<provider name> node packages/backtest/scripts/owner-programs.ts --dataset <dir> --out <dir>
//
// Cost: one call per 100 owners, recorded in the manifest. The URL (which may carry a key) is never written anywhere.
import { offCurve } from '../../core/src/gates/index.ts';
import { loadDay, loadManifest, loadMovements } from '../src/dataset/dataset.ts';
import { fetchOwnerPrograms, writeOwnerPrograms } from '../src/dataset/owner-programs.ts';

const args = process.argv.slice(2);
const flag = (n: string): string => {
  const i = args.indexOf(`--${n}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (v === undefined) throw new Error(`--${n} is required`);
  return v;
};
const url = process.env['RPC_URL'];
if (url === undefined || url === '') throw new Error('RPC_URL is required');
const dataset = flag('dataset');
const manifest = loadManifest(dataset);
const owners = new Set<string>();
for (const day of manifest.days) {
  for (const r of loadDay(dataset, day)) if ((r.kind === 'amm' || r.kind === 'curve') && r.userTokenOwner !== '' && offCurve(r.userTokenOwner)) owners.add(r.userTokenOwner);
  for (const m of loadMovements(dataset, day)) for (const o of [m.fromOwner, m.toOwner]) if (o !== '' && offCurve(o)) owners.add(o);
}
const { rows, calls } = await fetchOwnerPrograms([...owners], async (addresses) => {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [addresses, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] }),
  });
  const j = (await res.json()) as { result?: { value: ({ owner: string } | null)[] }; error?: unknown };
  if (j.result === undefined) throw new Error(`getMultipleAccounts failed: ${JSON.stringify(j.error)}`);
  return j.result.value.map((v) => v?.owner ?? null);
});
const m = writeOwnerPrograms(flag('out'), rows, { calls, source: process.env['RPC_NAME'] ?? 'unnamed provider', fetchedAt: new Date().toISOString() });
console.log(JSON.stringify(m));
