// Raw records (schema 2) reduced to token balances and token-program ops, checked on real mainnet pump creates
// (RUG-1's replay fixture, fetched from the public RPC) and on edited copies of them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeBase58, toBase64 } from '../../core/src/chain/index.ts';
import { compactRaw, RAW_EV_IDX } from '../src/dataset/raw.ts';
import { compareRows, type DatasetRow } from '../src/dataset/rows.ts';

interface RpcTx {
  signature: string; slot: number; blockTime: number; transaction: [string, string];
  meta: { err: unknown; loadedAddresses: unknown; innerInstructions: { index: number; instructions: { accounts: number[]; data: string; programIdIndex: number }[] }[] };
}
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../worker/test/fixtures/rug-replay.json'), 'utf8')) as {
  cases: { name: string; mint: string; transactions: RpcTx[] }[];
};
const RUG = fixture.cases[0]!;
const create = RUG.transactions[0]!;

/** The RPC transaction as a DATA-1 raw line (inner data base64, as the scanner writes it). */
const rawLine = (x: RpcTx, mint: string, edit: (meta: Record<string, unknown>) => void = () => {}): string => {
  const meta: Record<string, unknown> = {
    loadedAddresses: x.meta.loadedAddresses,
    innerInstructions: x.meta.innerInstructions.map((g) => ({ index: g.index, instructions: g.instructions.map((i) => ({ ...i, data: toBase64(decodeBase58(i.data)) })) })),
  };
  edit(meta);
  return JSON.stringify({ slot: x.slot, blockTime: x.blockTime, txIndex: 7, signature: x.signature, transaction: x.transaction[0], err: x.meta.err, mints: [mint], meta });
};

/** Index of the mint among the inner instruction accounts: the account the metadata-pointer instruction names. */
const mintIndex = (): number => {
  const g = create.meta.innerInstructions[0]!;
  return g.instructions[1]!.accounts[0]!;
};

describe('raw records', () => {
  it('reads a real pump create: authorities, extensions and supply', () => {
    const r = compactRaw(rawLine(create, RUG.mint))!;
    expect(r.undecodable).toBeNull();
    expect(r.evIdx).toBe(RAW_EV_IDX);
    const ops = r.ops.filter((o) => 'mint' in o ? o.mint === RUG.mint : o.account === RUG.mint);
    expect(ops.map((o) => o.op)).toEqual(['extension', 'init-mint', 'extension', 'mint-to', 'set-authority']);
    expect(ops[1]).toMatchObject({ op: 'init-mint', freezeAuthority: null });
    expect((ops[1] as { mintAuthority: string }).mintAuthority).not.toBeNull();
    expect(ops[3]).toMatchObject({ op: 'mint-to', amount: 1_000_000_000_000_000n });
    expect(ops[4]).toMatchObject({ op: 'set-authority', authorityType: 0, newAuthority: null });
    expect(ops.filter((o) => o.op === 'extension').map((o) => (o as { ext: { kind: string } }).ext.kind)).toEqual(['MetadataPointer', 'TokenMetadata']);
  });

  it('reports a blocked and an unknown Token-2022 extension set up before the mint is initialised', () => {
    const k = mintIndex();
    const t22 = create.meta.innerInstructions[0]!.instructions[1]!.programIdIndex;
    const r = compactRaw(rawLine(create, RUG.mint, (meta) => {
      const g = (meta['innerInstructions'] as { instructions: unknown[] }[])[0]!;
      g.instructions.unshift(
        { programIdIndex: t22, accounts: [k], data: toBase64(new Uint8Array([35, ...new Uint8Array(32).fill(9)])), stackHeight: 2 },
        { programIdIndex: t22, accounts: [k], data: toBase64(new Uint8Array([99, 1, 2])), stackHeight: 2 },
      );
    }))!;
    const kinds = r.ops.filter((o) => o.op === 'extension').map((o) => (o as { ext: { kind: string; type: number } }).ext);
    expect(kinds).toContainEqual({ kind: 'PermanentDelegate', type: 12 });
    expect(kinds).toContainEqual({ kind: 'unknown', type: 99 });
  });

  it('reads Approve, ApproveChecked, Revoke and CloseAccount on token accounts (delegates, GATE-1e)', () => {
    const tok = create.meta.innerInstructions[0]!.instructions[1]!.programIdIndex;
    const amt = (n: number) => [...new Uint8Array(new BigUint64Array([BigInt(n)]).buffer)];
    const r = compactRaw(rawLine(create, RUG.mint, (meta) => {
      const g = (meta['innerInstructions'] as { instructions: unknown[] }[])[0]!;
      g.instructions.push(
        { programIdIndex: tok, accounts: [2, 3, 4], data: toBase64(new Uint8Array([4, ...amt(500)])), stackHeight: 2 },
        { programIdIndex: tok, accounts: [2, 1, 5, 4], data: toBase64(new Uint8Array([13, ...amt(70), 6])), stackHeight: 2 },
        { programIdIndex: tok, accounts: [2, 4], data: toBase64(new Uint8Array([5])), stackHeight: 2 },
        { programIdIndex: tok, accounts: [6, 4, 4], data: toBase64(new Uint8Array([9])), stackHeight: 2 },
      );
    }))!;
    const ops = r.ops.filter((o) => o.op === 'approve' || o.op === 'revoke' || o.op === 'close');
    expect(ops.map((o) => o.op)).toEqual(['approve', 'approve', 'revoke', 'close']);
    expect(ops[0]).toMatchObject({ amount: 500n });
    expect(ops[1]).toMatchObject({ amount: 70n });
    // ApproveChecked names the delegate third, after the mint; Approve second.
    expect((ops[0] as { delegate: string }).delegate).not.toBe((ops[1] as { delegate: string }).delegate);
    expect((ops[0] as { account: string }).account).toBe((ops[2] as { account: string }).account);
  });

  it('keeps token balances of the sampled mints only, with owners', () => {
    const r = compactRaw(rawLine(create, RUG.mint, (meta) => {
      meta['preTokenBalances'] = [{ accountIndex: 3, mint: 'OtherMint1111111111111111111111111111111111', owner: 'o', uiTokenAmount: { amount: '5' } }];
      meta['postTokenBalances'] = [
        { accountIndex: 2, mint: RUG.mint, owner: 'Owner111', uiTokenAmount: { amount: '1000000000000000' } },
        { accountIndex: 3, mint: 'OtherMint1111111111111111111111111111111111', owner: 'o', uiTokenAmount: { amount: '6' } },
      ];
    }))!;
    expect(r.balances).toHaveLength(1);
    expect(r.balances[0]).toMatchObject({ mint: RUG.mint, owner: 'Owner111', pre: null, post: 1_000_000_000_000_000n });
  });

  it('drops a failed transaction and flags an undecodable one', () => {
    expect(compactRaw(JSON.stringify({ ...JSON.parse(rawLine(create, RUG.mint)), err: { hex: '00' } }))).toBeNull();
    const bad = compactRaw(JSON.stringify({ ...JSON.parse(rawLine(create, RUG.mint)), transaction: 'AAAA' }))!;
    expect(bad.undecodable).not.toBeNull();
    expect(bad.ops).toEqual([]);
    const noInner = compactRaw(rawLine(create, RUG.mint, (meta) => { meta['innerInstructions'] = null; }))!;
    expect(noInner.undecodable).toBe('inner instructions not recorded');
  });

  it('sorts after every event of its own transaction and before the block row', () => {
    const r = compactRaw(rawLine(create, RUG.mint))!;
    const ev: DatasetRow = { kind: 'event', slot: r.slot, blockTime: r.blockTime, txIdx: r.txIdx, evIdx: 40, signature: r.signature, program: 'pump', event: 'CreateEvent', fields: {} };
    const block: DatasetRow = { kind: 'block', slot: r.slot, blockTime: r.blockTime, parentSlot: r.slot - 1n };
    expect([block, r, ev].sort(compareRows).map((x) => x.kind)).toEqual(['event', 'raw', 'block']);
  });
});
