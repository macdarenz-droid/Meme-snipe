// TX-1b: the eligibility gates and the transaction builders share one support boundary. For each coin and pool
// configuration, the hard rejects run on the gate world and the TX-1 builders build the entry and the protective exit
// on the golden PumpSwap market with the same configuration. Whatever the gates accept must build and simulate
// (TEST-2's dry run on the stub chain) on both sides; whatever the builders refuse must fail the gates.
import { describe, expect, it } from 'vitest';
import { type Address, EXTENSION_TYPES, type Extension, type Pool, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../core/src/chain/index.ts';
import { evaluateHardRejects, mintKey, poolKey } from '../../core/src/gates/index.ts';
import { buildTrade, type TradeRequest } from '../../core/src/tx/index.ts';
import { POOL, MINT, contextOf, deps, mintFixture, passingFacts, patch, request as gateRequest, session } from '../../core/test/gates/world.ts';
import { dryRunTrade } from '../src/dryrun/index.ts';
import { fund, setup, tradeOf } from './dryrun-fixture.ts';
import { blockNetwork } from './helpers.ts';

blockNetwork();

type ExtensionKind = (typeof EXTENSION_TYPES)[number];
const ext = (kind: ExtensionKind, fields: Record<string, unknown> = {}): Extension =>
  ({ kind, type: EXTENSION_TYPES.indexOf(kind), fields, data: '' }) as unknown as Extension;
/** The real pump `create_v2` pair (MetadataPointer, TokenMetadata) of the gate world's mint. */
const META = mintFixture(MINT).account.extensions;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;

interface Config {
  readonly name: string;
  readonly program: 'spl-token' | 'token-2022';
  readonly extensions: readonly Extension[];
  readonly pool: { readonly isMayhemMode?: boolean | undefined; readonly isCashbackCoin?: boolean | undefined; readonly coinCreator?: Address | undefined; readonly quoteMint?: Address };
  /** The pool account's data length; undefined: not read. */
  readonly accountBytes: number | undefined;
}

const base: Config = { name: 'pump create_v2 coin on a current pool', program: 'token-2022', extensions: META, pool: {}, accountBytes: 301 };
const CONFIGS: readonly Config[] = [
  base,
  { ...base, name: 'SPL Token coin', program: 'spl-token', extensions: [] },
  { ...base, name: 'Token-2022 without extensions', extensions: [] },
  { ...base, name: '+ GroupPointer', extensions: [...META, ext('GroupPointer', { authority: null, groupAddress: null })] },
  { ...base, name: '+ TokenGroup', extensions: [...META, ext('TokenGroup', { updateAuthority: null, mint: MINT, size: 1n, maxSize: 10n })] },
  { ...base, name: '+ GroupMemberPointer', extensions: [...META, ext('GroupMemberPointer', { authority: null, memberAddress: null })] },
  { ...base, name: '+ TokenGroupMember', extensions: [...META, ext('TokenGroupMember', { mint: MINT, group: MINT, memberNumber: 1n })] },
  { ...base, name: '+ DefaultAccountState initialized', extensions: [...META, ext('DefaultAccountState', { state: 'initialized' })] },
  { ...base, name: '+ DefaultAccountState frozen', extensions: [...META, ext('DefaultAccountState', { state: 'frozen' })] },
  { ...base, name: '+ TransferFeeConfig', extensions: [...META, ext('TransferFeeConfig')] },
  { ...base, name: '+ an unknown extension', extensions: [...META, { kind: 'unknown', type: 99, data: '' } as Extension] },
  { ...base, name: 'cashback pool', pool: { isCashbackCoin: true } },
  { ...base, name: 'cashback flag unread', pool: { isCashbackCoin: undefined } },
  { ...base, name: 'mayhem pool', pool: { isMayhemMode: true } },
  { ...base, name: 'coin creator unread', pool: { coinCreator: undefined } },
  { ...base, name: 'USDC-quoted pool', pool: { quoteMint: USDC } },
  { ...base, name: 'outdated pool layout (287 bytes, needs extend_account)', accountBytes: 287 },
  { ...base, name: 'pool layout at the 300-byte minimum', accountBytes: 300 },
  { ...base, name: 'pool account size unread', accountBytes: undefined },
];

const tokenProgramOf = (c: Config): Address => (c.program === 'spl-token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM);

const gates = (c: Config) => {
  let f = patch(passingFacts(), mintKey(MINT), { owner: tokenProgramOf(c), account: { ...mintFixture(MINT).account, extensions: c.extensions } });
  f = patch(f, poolKey(MINT), { pool: { ...POOL, ...c.pool }, accountBytes: c.accountBytes });
  return evaluateHardRejects(contextOf(f), deps('live', session(), 'RUG-1'), gateRequest(), { stopAtFirst: false });
};

/** The golden PumpSwap entry or exit with the configuration applied to its mint and pool. */
const configured = (c: Config, kind: 'pool-buy' | 'pool-sell'): TradeRequest => {
  const t = tradeOf(kind);
  const r = t.request;
  if (r.venue !== 'pool') throw new Error('pool kinds only');
  return {
    ...r,
    mint: { ...r.mint, program: c.program, extensions: c.extensions },
    // An unread flag is modelled as an absent field, which the decoded type does not allow.
    market: { ...r.market, baseTokenProgram: tokenProgramOf(c), state: { ...r.market.state, ...c.pool } as Pool, accountBytes: c.accountBytes as number },
  };
};

describe('the gates accept only what the builders can trade', () => {
  it.each(CONFIGS)('$name', async (c) => {
    const g = gates(c);
    const shapeFailed = g.failed.includes('H17' as never) || g.reasons.some((r) => r.neededBy === ('H17' as never));
    for (const kind of ['pool-buy', 'pool-sell'] as const) {
      const req = configured(c, kind);
      const t = tradeOf(kind, { request: req });
      const built = buildTrade(req, t.common, t.policy);
      if (g.pass) {
        // Accepted: the entry and the protective exit both build and simulate.
        expect(built.ok, `${kind} refused: ${built.ok ? '' : `${built.reason}: ${built.detail}`}`).toBe(true);
        const { chain, deps: d } = setup();
        fund(chain, t);
        const r = await dryRunTrade(t, d);
        expect(r.error).toBeNull();
        expect(r).toMatchObject({ outcome: 'simulated', success: true, amountErrorE4: 0 });
      }
      // Refused by a builder: the supported-shape gate itself rejects (not only some other gate), before any entry.
      if (!built.ok) expect(shapeFailed, `${kind} refused (${built.reason}) but the shape gate passed`).toBe(true);
    }
  });

  it('the gate world itself is a supported shape', () => {
    expect(gates(base).pass).toBe(true);
    expect(gates({ ...CONFIGS[1]! }).pass).toBe(true);
  });
});
