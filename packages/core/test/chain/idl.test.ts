// The hand-written layouts must match the pinned pump IDLs field for field: same names (camelCase), same types,
// same order, same discriminators. A pump layout change fails here first.
import { describe, expect, it } from 'vitest';
import { BondingCurveLayout, GlobalLayout } from '../../src/chain/pump.ts';
import { GlobalConfigLayout, PoolLayout } from '../../src/chain/pump-amm.ts';
import { FeeConfigLayout, FeeTier, Fees } from '../../src/chain/fees.ts';
import {
  BoostBuyAndBurnEventLayout,
  BuyEventLayout,
  CompleteEventLayout,
  CompletePumpAmmMigrationEventLayout,
  CreateEventLayout,
  CreatePoolEventLayout,
  InitBoostEventLayout,
  SellEventLayout,
  Shareholder,
  TradeEventLayout,
} from '../../src/chain/events.ts';
import type { Field, Layout } from '../../src/chain/schema.ts';
import { PUMP_AMM_PROGRAM, PUMP_FEES_PROGRAM, PUMP_PROGRAM } from '../../src/chain/programs.ts';
import { IDL, type IdlType, camel } from './helpers.ts';

const asIdl = (fields: readonly Field[]) => fields.map(([name, c]) => ({ name, type: c.idl }));
const fromIdl = (fields: { name: string; type: IdlType }[]) => fields.map((f) => ({ name: camel(f.name), type: f.type }));

const CASES: [keyof typeof IDL.programs, 'accounts' | 'events', Layout<readonly Field[], readonly Field[]>][] = [
  ['pump', 'accounts', GlobalLayout],
  ['pump', 'accounts', BondingCurveLayout],
  ['pump', 'events', TradeEventLayout],
  ['pump', 'events', CreateEventLayout],
  ['pump', 'events', CompleteEventLayout],
  ['pump', 'events', CompletePumpAmmMigrationEventLayout],
  ['pump_amm', 'accounts', PoolLayout],
  ['pump_amm', 'accounts', GlobalConfigLayout],
  ['pump_amm', 'events', BuyEventLayout],
  ['pump_amm', 'events', SellEventLayout],
  ['pump_amm', 'events', CreatePoolEventLayout],
  ['pump_amm', 'events', InitBoostEventLayout],
  ['pump_amm', 'events', BoostBuyAndBurnEventLayout],
  ['pump_fees', 'accounts', FeeConfigLayout],
  ['pump', 'accounts', FeeConfigLayout],
  ['pump_amm', 'accounts', FeeConfigLayout],
];

describe('layouts match the pinned IDL', () => {
  it('pins pump-public-docs cb188ce and the program addresses', () => {
    expect(IDL.commit).toBe('cb188ce08b5069196eef1f3e4a0c43b70099793b');
    expect(IDL.programs.pump.address).toBe(PUMP_PROGRAM);
    expect(IDL.programs.pump_amm.address).toBe(PUMP_AMM_PROGRAM);
    expect(IDL.programs.pump_fees.address).toBe(PUMP_FEES_PROGRAM);
  });

  it.each(CASES.map(([p, kind, l]) => [`${p}.${l.name}`, p, kind, l] as const))('%s', (_n, program, kind, l) => {
    const p = IDL.programs[program];
    expect([...l.discriminator]).toEqual(p[kind][l.name]);
    expect([...asIdl(l.base), ...asIdl(l.added)]).toEqual(fromIdl(p.types[l.name]!.fields));
  });

  it.each([
    ['Fees', Fees.fields],
    ['FeeTier', FeeTier.fields],
  ] as const)('nested %s', (name, fields) => {
    for (const program of ['pump', 'pump_amm', 'pump_fees'] as const) {
      expect(asIdl(fields)).toEqual(fromIdl(IDL.programs[program].types[name]!.fields));
    }
  });

  it('nested Shareholder', () => {
    expect(asIdl(Shareholder.fields)).toEqual(fromIdl(IDL.programs.pump.types['Shareholder']!.fields));
  });
});
