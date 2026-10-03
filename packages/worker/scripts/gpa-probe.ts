// Is getProgramAccounts (memcmp on a mint at offset 0) served on the free providers, for both token programs, and at
// what latency? Opt-in; prints availability, account counts, context slots and timings only, never a key or URL.
//   ZEROED_GPA_PROBE=1 CREDENTIALS_DIRECTORY=<dir with HELIUS_API_KEY and ALCHEMY_API_KEY> node packages/worker/scripts/gpa-probe.ts
// or, in the gpa-probe workflow, with HELIUS_API_KEY and ALCHEMY_API_KEY in the environment.
// Neither API reports the credits a call used. The script prints the published price (Helius credits page:
// getProgramAccounts 10 credits, data.md §1.2; Alchemy: not published for this method on its CU table, read the
// dashboard's usage before and after a run).
import { alchemyRpcUrl, credentialsDirectorySecrets, heliusRpcUrl, type Secrets } from '../src/providers/index.ts';

if (process.env.ZEROED_GPA_PROBE !== '1') {
  console.error('gpa probe is opt-in: set ZEROED_GPA_PROBE=1 (it uses real provider credits)');
  process.exit(2);
}
const dir = process.env.CREDENTIALS_DIRECTORY;
const fromEnv: Secrets = {
  get: (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  },
};
const secrets = dir ? credentialsDirectorySecrets(dir) : fromEnv;
/** At least a second between Alchemy calls, so one probe run can measure it. */
const ALCHEMY_SPACING_MS = 1_500;
const PRICE = { helius: '10 credits (published)', alchemy: 'not published; read the dashboard' } as const;
/** A Token-2022 pump coin (create_v2, about 60 token accounts) and a legacy SPL pump coin with a very large holder set
 * (Fartcoin, about 569k token accounts), both recorded on 2026-10-03. */
const CASES = [
  { program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', mint: 'DRnMYnkK3dCwypBgZaH5jcVoQHQhoEr8NcMNLJ18pump' },
  { program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
];
/** Both filter sets per program: the mint memcmp alone, and the indexed form the supervisor ruled (readers.ts holderFilters). */
const filterSets = (program: string, mint: string): readonly [string, unknown[]][] => [
  ['mint only', [{ memcmp: { offset: 0, bytes: mint } }]],
  ['indexed', program.startsWith('Tokenz') ? [{ memcmp: { offset: 0, bytes: mint } }, { memcmp: { offset: 165, bytes: '3' } }] : [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }]],
];
for (const [name, url] of [['helius', heliusRpcUrl(secrets)], ['alchemy', alchemyRpcUrl(secrets)]] as const) {
  for (const c of CASES) {
    for (const [label, filters] of filterSets(c.program, c.mint)) {
      // Alchemy answered 429 (compute units per second) to back-to-back calls in run 37149567929: space them out.
      if (name === 'alchemy') await new Promise((r) => setTimeout(r, ALCHEMY_SPACING_MS));
      const t0 = Date.now();
      const tag = `${name} ${c.program.slice(0, 8)} ${label}`;
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [c.program, { encoding: 'base64', commitment: 'confirmed', withContext: true, dataSlice: { offset: 0, length: 0 }, filters }] }) });
        const body = (await res.json()) as { result?: { context: { slot: number }; value: unknown[] }; error?: { code: number; message: string } };
        const ms = Date.now() - t0;
        if (body.error) console.log(`${tag}: refused (${body.error.code} ${body.error.message.slice(0, 80)}), ${ms} ms, HTTP ${res.status}`);
        else console.log(`${tag}: served, ${body.result!.value.length} accounts at slot ${body.result!.context.slot}, ${ms} ms, ${PRICE[name]}`);
      } catch (e) {
        console.log(`${tag}: failed (${(e as Error).name}), ${Date.now() - t0} ms`);
      }
    }
  }
}
