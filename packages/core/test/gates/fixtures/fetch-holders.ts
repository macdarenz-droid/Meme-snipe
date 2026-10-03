// Dev tool, not a test: collects real mainnet token accounts for the holder-classification fixtures (GATE-1).
// Run: node packages/core/test/gates/fixtures/fetch-holders.ts
// Public RPC (override with SOLANA_RPC). The public endpoint refuses getTokenLargestAccounts, so holders are found
// by address: the curve ATA, the mayhem vault ATA and the creator ATA are derived, the pool vault is read from the
// pool, a buyer's account comes from a mainnet BuyEvent, and a burn is a token account owned by the incinerator.
// Every account keeps its address and the slot it was read at.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, addressBytes, bondingCurveAddress, decodePool, findProgramAddress,
  fromBase64, recordFromRpc, transactionEvents,
} from '../../../src/chain/index.ts';
import { MAYHEM_VAULT_OWNER, INCINERATOR } from '../../../src/gates/index.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const HERE = dirname(fileURLToPath(import.meta.url));
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = (await res.json()) as { result?: T; error?: { code: number } };
    if ((res.status === 429 || body.error?.code === 429) && attempt < 7) {
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      continue;
    }
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    await sleep(150);
    return body.result as T;
  }
}

const ata = (owner: Address, mint: Address, program: Address): Address =>
  findProgramAddress([addressBytes(owner), addressBytes(program), addressBytes(mint)], ATA_PROGRAM).address;

const txs = JSON.parse(readFileSync(join(HERE, '..', '..', 'chain', 'fixtures', 'transactions.json'), 'utf8')) as {
  transactions: { label: string; signature: string; base64: never }[];
};
const events = (label: string) => {
  const t = txs.transactions.find((x) => x.label === label);
  if (!t) throw new Error(`no transaction fixture "${label}"`);
  return transactionEvents(recordFromRpc(t.signature, t.base64));
};
const create = events('pump CreateEvent (mayhem)').find((e) => e.name === 'CreateEvent');
const buy = events('PumpSwap BuyEvent').find((e) => e.name === 'BuyEvent');
if (create?.name !== 'CreateEvent' || buy?.name !== 'BuyEvent') throw new Error('fixture events missing');

const accounts = JSON.parse(readFileSync(join(HERE, '..', '..', 'chain', 'fixtures', 'accounts.json'), 'utf8')) as {
  accounts: { address: string; dataBase64: string }[];
};
const poolOf = (address: string) => {
  const a = accounts.accounts.find((x) => x.address === address);
  if (!a) throw new Error(`no account fixture ${address}`);
  const d = decodePool(fromBase64(a.dataBase64)) as unknown as { value: { baseMint: Address; poolBaseTokenAccount: Address } };
  return d.value;
};

const GRADUATED_POOL = '9KBF3KqYErfs1NXRK35gb4J8wnAD2i9ePZAzcwn7yhFT' as Address;
const CURVE_MINT = 'AiXQrgzWWWG7puqLtHhgBNtyRvvvbu9yUjs6kD1mpump' as Address;
const BURN_MINT = '13tU1e27MnPNBEHetd8fsp9sY6HrfqHp54ueGoX8pump' as Address;
const BURN_ACCOUNT = '8eMjbKyrY4pQF7KFa1kCmjFRDcTaFSUxEjXD7KU5pwma' as Address;

const mayhemMint = create.data.mint as Address;
const graduated = poolOf(GRADUATED_POOL);
const buyPool = await rpc<{ value: { data: [string, string] } }>('getAccountInfo', [buy.data.pool, { encoding: 'base64', commitment: 'confirmed' }]);
const buyMint = (decodePool(fromBase64(buyPool.value.data[0])) as unknown as { value: { baseMint: Address } }).value.baseMint;

const wanted: { label: string; address: Address }[] = [
  { label: 'fresh curve coin: mint', address: CURVE_MINT },
  { label: 'fresh curve coin: bonding-curve ATA', address: ata(bondingCurveAddress(CURVE_MINT), CURVE_MINT, TOKEN_2022_PROGRAM) },
  { label: 'mayhem coin: mint', address: mayhemMint },
  { label: 'mayhem coin: bonding-curve ATA', address: ata(bondingCurveAddress(mayhemMint), mayhemMint, TOKEN_2022_PROGRAM) },
  { label: 'mayhem coin: mayhem vault (owner BwWK17cb)', address: ata(MAYHEM_VAULT_OWNER, mayhemMint, TOKEN_2022_PROGRAM) },
  { label: 'mayhem coin: creator ATA', address: ata(create.data.creator as Address, mayhemMint, TOKEN_2022_PROGRAM) },
  { label: 'graduated coin: mint', address: graduated.baseMint },
  { label: 'graduated coin: canonical pool base vault', address: graduated.poolBaseTokenAccount },
  { label: 'PumpSwap buyer: base token account (from a mainnet BuyEvent)', address: buy.data.userBaseTokenAccount as Address },
  { label: 'PumpSwap buyer: mint', address: buyMint },
  { label: 'burned coin: mint', address: BURN_MINT },
  { label: 'burned coin: incinerator token account', address: BURN_ACCOUNT },
];

const res = await rpc<{ context: { slot: number }; value: ({ owner: string; lamports: number; data: [string, string] } | null)[] }>(
  'getMultipleAccounts', [wanted.map((w) => w.address), { encoding: 'base64', commitment: 'confirmed' }],
);
const OPTIONAL = new Set(['mayhem coin: creator ATA']);
const out = wanted.flatMap((w, i) => {
  const v = res.value[i];
  if (!v && OPTIONAL.has(w.label)) {
    console.log(`skipped ${w.label}: ${w.address} does not exist (closed or never opened)`);
    return [];
  }
  if (!v) throw new Error(`${w.label} ${w.address} does not exist`);
  if (v.owner !== TOKEN_PROGRAM && v.owner !== TOKEN_2022_PROGRAM) throw new Error(`${w.label} is owned by ${v.owner}`);
  return [{ label: w.label, address: w.address, slot: String(res.context.slot), owner: v.owner, lamports: String(v.lamports), dataBase64: v.data[0] }];
});
const meta = {
  rpc: RPC,
  fetchedAt: new Date().toISOString(),
  sources: { mayhemCreate: create.signature, buyEvent: buy.signature, graduatedPool: GRADUATED_POOL, poolOfBuy: buy.data.pool },
  creator: create.data.creator,
};
writeFileSync(join(HERE, 'holders.json'), `${JSON.stringify({ meta, accounts: out }, null, 2)}\n`);
console.log(`wrote ${out.length} accounts at slot ${res.context.slot}`);
