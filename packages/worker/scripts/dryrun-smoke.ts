// Opt-in mainnet smoke test of the dry-run RPC (TEST-2). Never part of CI or `pnpm test` (worker guard test):
//   ZEROED_LIVE_PROBE=1 CREDENTIALS_DIRECTORY=/run/credentials/zeroed-worker.service \
//     node packages/worker/scripts/dryrun-smoke.ts <funded-system-wallet> <pump-mint>
// Keyless, against the public mainnet RPC (Agave; rate-limited, for the fee check only):
//   ZEROED_LIVE_PROBE=1 ZEROED_SMOKE_PUBLIC=1 node packages/worker/scripts/dryrun-smoke.ts <funded-system-wallet> <pump-mint>
// Runs are recorded in docs/evidence/DRYRUN_SMOKE.md.
// It reads and simulates only (no send method exists in the dry-run client). It checks the provider's response
// shapes and the assumption the sell measurement rests on: a simulation's read-back fee payer balance has the base
// fee and priority fee already taken out. It prints counts and amounts only, never a key or a URL.
import { toAddress } from '../../core/src/chain/index.ts';
import { compileV0 } from '../../core/src/tx/compile.ts';
import { setComputeUnitLimit, setComputeUnitPrice } from '../../core/src/tx/native.ts';
import { DryRunRpc } from '../src/dryrun/index.ts';
import { credentialsDirectorySecrets, fetchHttp, heliusRpcUrl } from '../src/providers/index.ts';
import { HELIUS_FREE, P2, Scheduler, systemTimers } from '../src/scheduler/index.ts';

if (process.env.ZEROED_LIVE_PROBE !== '1') {
  console.error('dry-run smoke test is opt-in: set ZEROED_LIVE_PROBE=1 (it uses real provider credits)');
  process.exit(2);
}
const dir = process.env.CREDENTIALS_DIRECTORY;
const usePublic = process.env.ZEROED_SMOKE_PUBLIC === '1';
const [payerArg, mintArg] = process.argv.slice(2);
if ((!dir && !usePublic) || !payerArg || !mintArg) {
  console.error('usage: CREDENTIALS_DIRECTORY=<dir with HELIUS_API_KEY> dryrun-smoke.ts <funded-system-wallet> <pump-mint>');
  process.exit(2);
}

const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const url = usePublic ? () => PUBLIC_RPC : ((s) => () => heliusRpcUrl(s))(credentialsDirectorySecrets(dir!));
console.log(`endpoint: ${usePublic ? PUBLIC_RPC : 'helius (key from credentials)'}`);
const rpc = new DryRunRpc({ url, http: fetchHttp, scheduler: new Scheduler(HELIUS_FREE, { timers: systemTimers() }), timeoutMs: 10_000 });
const payer = toAddress(payerArg);
const mint = toAddress(mintArg);
let failed = false;
const check = async (name: string, f: () => Promise<string>) => {
  try {
    console.log(`${name}: ok (${await f()})`);
  } catch (e) {
    failed = true;
    console.log(`${name}: FAILED: ${(e as Error).message}`);
  }
};

await check('getTokenLargestAccounts', async () => {
  const r = await rpc.getTokenLargestAccounts(mint, 0n, P2);
  return `${r.accounts.length} holders at slot ${r.slot}`;
});

await check('simulateTransaction read-back includes fees', async () => {
  const pre = await rpc.getMultipleAccounts([payer], 0n, P2);
  const before = pre.accounts[0]?.lamports ?? 0n;
  const cuLimit = 1_000;
  const microLamports = 5_000_000n; // 5 lamports per unit: priority fee 5,000 lamports
  const ixs = [setComputeUnitLimit(cuLimit), setComputeUnitPrice(microLamports)];
  const tx = compileV0(payer, ixs, toAddress('11111111111111111111111111111111'), [], () => false);
  const sim = await rpc.simulate(tx.wire, [payer], pre.slot, P2);
  if (sim.value.err !== null) throw new Error(`simulation error ${JSON.stringify(sim.value.err)}`);
  const after = sim.value.accounts[0]?.lamports ?? 0n;
  const expected = 5_000n + (microLamports * BigInt(cuLimit)) / 1_000_000n;
  const { preBalances, postBalances, fee } = sim.value;
  // The node's own pre/post balances are atomic with the simulation; our earlier read is not (a busy payer can
  // receive lamports in between), so it is only a fallback.
  const atomic = preBalances !== null && postBalances !== null;
  const spent = atomic ? preBalances[0]! - postBalances[0]! : before - after;
  if (atomic && postBalances[0] !== after) throw new Error(`read-back ${after} differs from postBalances ${postBalances[0]}`);
  if (fee !== null && fee !== expected) throw new Error(`fee field ${fee}, expected ${expected}`);
  if (spent !== expected) throw new Error(`payer spent ${spent} lamports in simulation (${atomic ? 'preBalances' : 'our read'}), expected ${expected}`);
  const fields = ['fee', 'preBalances', 'postBalances', 'preTokenBalances', 'postTokenBalances'].filter((k) => (sim.value as unknown as Record<string, unknown>)[k] !== null);
  return `payer spent ${spent} = base fee + priority fee (from ${atomic ? 'preBalances/postBalances' : 'our read'}); read-back matches; fields returned: ${fields.join(', ') || 'none'}; slot ${sim.slot}, ${sim.value.unitsConsumed} units`;
});

process.exit(failed ? 1 : 0);
