// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { envSecrets, loadProviders, maxRpsUnder, PUBLIC_MAINNET_LIMITS, validateProviderConfigs } from '../../src/m14/providers.ts';
import type { ProviderConfig } from '../../src/m14/types.ts';
import { provider, PUBLIC_RPC_LIMITS, RecordingLog } from './helpers.ts';

const primary = provider({ label: 'shyft', unmeteredPrimary: true, failoverOrder: 0 });
const second = provider({
  label: 'chainstack', failoverOrder: 1, limits: { rps: 12 },
  documentedLimits: [{ scope: 'total', count: 25, windowMs: 1_000, fact: 'LD-32' }],
  metering: { unit: 'requests', monthlyAllowance: 3_000_000, methodCost: {} },
});
const publicRpc = provider({
  label: 'public', failoverOrder: 2, allowInLivePaths: false, limits: { rps: 5, perMethodRps: 2 }, documentedLimits: [...PUBLIC_RPC_LIMITS],
});
const secrets = envSecrets({
  RPC_URL_SHYFT: 'https://rpc.shyft.example/?api_key=k-shyf',
  RPC_URL_CHAINSTACK: 'https://chainstack.example/abcdef0123456789',
  RPC_URL_PUBLIC: 'https://api.mainnet-beta.solana.com',
});
/** Every provider of these tests wholly to the engine (Z03 ruling m12: the engine context needs an allocation). */
const WHOLE = { consumer: 'engine', shares: Object.fromEntries(['shyft', 'chainstack', 'public', 'helius', 'ws', 'live'].map((l) => [l, { engine: 10_000 }])) };
/** Every provider wholly to one research process (Z03 ruling 15: research reads under its own configured share). */
const RESEARCH = { consumer: 'research', shares: Object.fromEntries(['shyft', 'chainstack', 'public', 'helius', 'ws', 'live'].map((l) => [l, { research: 10_000 }])) };
const engine = { context: 'engine' as const, p0ReserveBps: 2_000, egressHosts: ['rpc.shyft.example', 'chainstack.example', 'api.mainnet-beta.solana.com'], allocation: WHOLE };

function problems(raw: unknown, ctx: 'engine' | 'research' = 'engine'): string[] {
  const r = validateProviderConfigs(raw, { context: ctx });
  return r.ok ? [] : r.error.problems.map((p) => `${p.key}: ${p.message}`);
}

describe('A-M14-01 config validation', () => {
  it('accepts the default free-provider set (engine) and orders it by failoverOrder', () => {
    const r = validateProviderConfigs([second, primary, publicRpc], { context: 'engine' });
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((c) => c.label), ['shyft', 'chainstack', 'public']);
  });

  it('rejects a provider URL starting with http:// (E_CONFIG, CA-30)', () => {
    const log = new RecordingLog();
    const r = loadProviders([primary, second], envSecrets({ RPC_URL_SHYFT: 'http://rpc.shyft.example/?api_key=zzz', RPC_URL_CHAINSTACK: 'https://chainstack.example/x' }), engine, log);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.code === 'E_CONFIG');
    assert.match(JSON.stringify(r), /HTTPS only/);
    assert.doesNotMatch(JSON.stringify(r), /zzz|rpc\.shyft\.example/);   // the message never echoes the URL
  });

  it('rejects a wss URL for an https provider, an https URL for a wss provider, and a URL that does not parse', () => {
    const stream = provider({ label: 'ws', transport: 'wss', roles: ['stream'], failoverOrder: 9 });
    const bad = (env: Record<string, string>, list: ProviderConfig[]) => loadProviders(list, envSecrets(env), engine, new RecordingLog());
    const base = { RPC_URL_SHYFT: 'https://a.example', RPC_URL_CHAINSTACK: 'https://b.example' };
    assert.equal(bad({ ...base, RPC_URL_SHYFT: 'wss://a.example' }, [primary, second]).ok, false);
    assert.equal(bad({ ...base, RPC_URL_WS: 'https://c.example' }, [primary, second, stream]).ok, false);
    assert.equal(bad({ ...base, RPC_URL_WS: 'wss://c.example' }, [primary, second, stream]).ok, true);
    assert.equal(bad({ ...base, RPC_URL_SHYFT: 'not a url' }, [primary, second]).ok, false);
  });

  it('allows the public mainnet endpoint only with allowInLivePaths = false [LD-26, DA-09]', () => {
    const live = { ...publicRpc, allowInLivePaths: true };
    const r = loadProviders([primary, second, live], secrets, engine, new RecordingLog());
    assert.ok(!r.ok && r.error.problems.some((p) => /allowInLivePaths = false/.test(p.message)));
    assert.ok(loadProviders([primary, second, publicRpc], secrets, engine, new RecordingLog()).ok);
  });

  it('needs exactly one unmetered primary, distinct labels and distinct read failover orders', () => {
    assert.match(problems([second, publicRpc], 'research').join(), /exactly one unmeteredPrimary/);
    assert.match(problems([primary, { ...primary, failoverOrder: 3, unmeteredPrimary: false }]).join(), /labels must be distinct/);
    assert.match(problems([primary, { ...second, failoverOrder: 0 }]).join(), /distinct failoverOrder/);
    assert.match(problems([primary, { ...second, unmeteredPrimary: true }]).join(), /found 2|metering null/);
  });

  it('needs two live read providers in the engine, one in research, and a live primary in the engine', () => {
    assert.match(problems([primary, publicRpc]).join(), /at least two read providers/);
    assert.deepEqual(problems([{ ...publicRpc, unmeteredPrimary: true }], 'research'), []);
    assert.match(problems([{ ...publicRpc, unmeteredPrimary: true }, primary, second].map((c, i) => ({ ...c, unmeteredPrimary: i === 0, failoverOrder: i }))).join(), /primary must be allowed in live paths/);
    assert.match(problems([provider({ label: 'ws', transport: 'wss', roles: ['stream'], unmeteredPrimary: true })], 'research').join(), /must have the read role/);
    assert.match(problems([provider({ label: 'ws', transport: 'wss', roles: ['stream'] })], 'research').join(), /at least one read provider is required/);
  });

  it('enforces the owner rule: configured rates at most half of every documented limit', () => {
    assert.equal(maxRpsUnder({ count: 100, windowMs: 10_000 }), 5);
    assert.equal(maxRpsUnder({ count: 40, windowMs: 10_000 }), 2);
    assert.equal(maxRpsUnder({ count: 1, windowMs: 1_000 }), 0.5);
    // Public RPC: 100 per 10 s per IP and 40 per 10 s per method [LD-26] → at most 5/s and 2/s.
    assert.deepEqual(problems([{ ...publicRpc, unmeteredPrimary: true }], 'research'), []);
    assert.match(problems([{ ...publicRpc, unmeteredPrimary: true, limits: { rps: 5.1, perMethodRps: 2 } }], 'research').join(), /is 5.1\/s; the owner rule caps it at 5\/s \(half of 100 per 10000 ms \[LD-26\]\)/);
    assert.match(problems([{ ...publicRpc, unmeteredPrimary: true, limits: { rps: 5, perMethodRps: 2.1 } }], 'research').join(), /caps it at 2\/s/);
    assert.match(problems([{ ...publicRpc, unmeteredPrimary: true, limits: { rps: 5 } }], 'research').join(), /perMethodRps: is required/);
    // Helius Free: 10 req/s and sendTransaction 1/s [LD-27] → 5/s and 0.5/s.
    const helius = provider({
      label: 'helius', roles: ['read', 'send'], failoverOrder: 3, limits: { rps: 5, sendRps: 1 },
      documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-27' }, { scope: 'send', count: 1, windowMs: 1_000, fact: 'LD-27' }],
      metering: { unit: 'credits', monthlyAllowance: 1_000_000, methodCost: { getProgramAccounts: 10 } },
    });
    assert.match(problems([primary, second, helius]).join(), /limits.sendRps: is 1\/s; the owner rule caps it at 0.5\/s/);
    assert.deepEqual(problems([primary, second, { ...helius, limits: { rps: 5, sendRps: 0.5 } }]), []);
    // A send limit on a provider without the send role does not apply.
    assert.deepEqual(problems([primary, second, { ...helius, roles: ['read'], limits: { rps: 5 } }]), []);
    assert.match(problems([primary, second, { ...helius, limits: { rps: 5 } }]).join(), /sendRps: is required for the send role/);
  });

  it('refuses malformed entries field by field', () => {
    const r = (o: Record<string, unknown>) => problems([{ ...primary, ...o }], 'research').join(' | ');
    assert.match(problems('x').join(), /must be a list/);
    assert.match(problems([7]).join(), /must be an object/);
    assert.match(r({ label: 'Bad Label' }), /label/);
    assert.match(r({ transport: 'http' }), /transport/);
    assert.match(r({ urlSecretRef: 'lower' }), /urlSecretRef/);
    assert.match(r({ roles: [] }), /roles/);
    assert.match(r({ roles: ['read', 'read'] }), /roles/);
    assert.match(r({ roles: 'read' }), /roles/);
    assert.match(r({ roles: ['stream'] }), /stream needs transport wss/);
    assert.match(r({ unmeteredPrimary: 'yes' }), /unmeteredPrimary/);
    assert.match(r({ allowInLivePaths: 1 }), /allowInLivePaths/);
    assert.match(r({ failoverOrder: -1 }), /failoverOrder/);
    assert.match(r({ failoverOrder: '1' }), /failoverOrder/);
    assert.match(r({ limits: null }), /limits.rps/);
    assert.match(r({ limits: { rps: 0 } }), /limits.rps/);
    assert.match(r({ limits: { rps: 5, heavyRps: 6 } }), /limits.heavyRps/);
    assert.match(r({ limits: { rps: 5, perMethodRps: -1 } }), /limits.perMethodRps/);
    assert.match(r({ metering: { unit: 'credits', monthlyAllowance: 0, methodCost: {} } }), /metering/);
    assert.match(r({ metering: { unit: 'credits', monthlyAllowance: 5, methodCost: { a: -1 } } }), /metering/);
    assert.match(r({ metering: 'x' }), /metering/);
    assert.match(r({ documentedLimits: [] }), /documentedLimits/);
    assert.match(r({ documentedLimits: 'x' }), /documentedLimits/);
    assert.match(r({ documentedLimits: [{ scope: 'total', count: 10, windowMs: 1000 }] }), /documentedLimits\[0\]/);
    assert.match(r({ documentedLimits: [{ scope: 'other', count: 10, windowMs: 1000, fact: 'X' }] }), /documentedLimits\[0\]/);
    assert.match(r({ documentedLimits: [7] }), /documentedLimits\[0\]/);
    assert.match(r({ documentedLimits: [{ scope: 'per_method', count: 40, windowMs: 10_000, fact: 'LD-26' }] }), /must include the total limit/);
  });
});

describe('A-M14-01 secrets and registry', () => {
  it('reads URLs by reference, keeps them in memory only, and orders providers', () => {
    const log = new RecordingLog();
    const r = loadProviders([publicRpc, second, primary], secrets, engine, log);
    assert.ok(r.ok);
    assert.deepEqual(r.value.providers.map((p) => p.config.label), ['shyft', 'chainstack', 'public']);
    assert.equal(r.value.liveModesAllowed, true);
    assert.deepEqual(r.value.warnings, []);
    assert.deepEqual(log.events, []);
  });

  it('a missing secret disables that provider, logs m14.provider_disabled and blocks live modes below two readers', () => {
    const log = new RecordingLog();
    const r = loadProviders([primary, second], envSecrets({ RPC_URL_SHYFT: 'https://rpc.shyft.example', RPC_URL_CHAINSTACK: '  ' }), engine, log);
    assert.ok(r.ok);
    assert.deepEqual(r.value.disabled, [{ label: 'chainstack', reason: 'secret_missing' }]);
    assert.deepEqual(r.value.providers.map((p) => p.config.label), ['shyft']);
    assert.equal(r.value.liveModesAllowed, false);
    assert.deepEqual(log.events, [{ level: 'error', code: 'm14.provider_disabled', fields: { provider: 'chainstack', reason: 'secret_missing' } }]);
  });

  it('warns when a host is not in the egress allowlist, or when no allowlist is given', () => {
    const a = loadProviders([primary, second], secrets, { context: 'engine', p0ReserveBps: 2_000, egressHosts: ['rpc.shyft.example'], allocation: WHOLE }, new RecordingLog());
    assert.ok(a.ok);
    assert.deepEqual(a.value.warnings.map((w) => [w.label, w.code]), [['chainstack', 'egress_host_missing']]);
    const b = loadProviders([primary, second], secrets, { context: 'engine', p0ReserveBps: 2_000, allocation: WHOLE }, new RecordingLog());
    assert.ok(b.ok);
    assert.deepEqual(b.value.warnings.map((w) => w.code), ['egress_allowlist_missing']);
  });

  it('research processes never allow live modes; config errors pass through loadProviders', () => {
    const r = loadProviders([{ ...publicRpc, unmeteredPrimary: true }], secrets, { context: 'research', p0ReserveBps: 2_000, egressHosts: ['api.mainnet-beta.solana.com'], allocation: RESEARCH }, new RecordingLog());
    assert.ok(r.ok);
    assert.equal(r.value.liveModesAllowed, false);
    assert.equal(loadProviders('x', secrets, engine, new RecordingLog()).ok, false);
  });

  it('holds a public-host provider to the LD-26 limits whatever its config says (review C03 R4)', () => {
    const research = { context: 'research' as const, p0ReserveBps: 2_000, egressHosts: ['api.mainnet-beta.solana.com'], allocation: RESEARCH };
    const madeUp = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 50, perMethodRps: 50 },
      documentedLimits: [{ scope: 'total', count: 1_000, windowMs: 1_000, fact: 'made-up' }] });
    assert.deepEqual(problems([madeUp], 'research'), []);                // the config alone passes the static check
    const r = loadProviders([madeUp], secrets, research, new RecordingLog());
    assert.ok(!r.ok);
    assert.deepEqual(r.error.problems.map((p) => p.key), ['rpc.providers[public].limits.rps', 'rpc.providers[public].limits.perMethodRps']);
    assert.match(r.error.problems[0]?.message as string, /caps it at 5\/s \(half of 100 per 10000 ms \[LD-26\]\)/);
    const noPerMethod = { ...madeUp, limits: { rps: 5 } };
    const n = loadProviders([noPerMethod], secrets, research, new RecordingLog());
    assert.ok(!n.ok);
    assert.deepEqual(n.error.problems.map((p) => [p.key, p.message]),
      [['rpc.providers[public].limits.perMethodRps', 'is required by documentedLimits[2] (per_method [LD-26])']]);
    const fine = loadProviders([{ ...madeUp, limits: { rps: 5, perMethodRps: 2 } }], secrets, research, new RecordingLog());
    assert.ok(fine.ok);
    assert.deepEqual(fine.value.providers[0]?.config.documentedLimits, [...madeUp.documentedLimits, ...PUBLIC_MAINNET_LIMITS]);
    const other = loadProviders([{ ...madeUp, limits: { rps: 5, perMethodRps: 2 } }],
      envSecrets({ RPC_URL_PUBLIC: 'https://api.mainnet.solana.com/' }), { context: 'research', p0ReserveBps: 2_000, allocation: RESEARCH }, new RecordingLog());
    assert.ok(other.ok);
    assert.equal(other.value.providers[0]?.config.documentedLimits.length, 4);
  });

  it('a public host written with a trailing dot gets the same LD-26 pin and live-path refusal (review C03 N2)', () => {
    const madeUp = provider({ label: 'public', unmeteredPrimary: true, failoverOrder: 0, allowInLivePaths: false, limits: { rps: 50 },
      documentedLimits: [{ scope: 'total', count: 1_000, windowMs: 1_000, fact: 'made-up' }] });
    for (const url of ['https://api.mainnet-beta.solana.com./', 'https://API.Mainnet.Solana.com../x']) {
      const r = loadProviders([madeUp], envSecrets({ RPC_URL_PUBLIC: url }), { context: 'research', p0ReserveBps: 2_000, egressHosts: ['api.mainnet-beta.solana.com', 'api.mainnet.solana.com'], allocation: RESEARCH }, new RecordingLog());
      assert.ok(!r.ok, url);
      assert.deepEqual(r.error.problems.map((p) => p.key), ['rpc.providers[public].limits.rps', 'rpc.providers[public].limits.perMethodRps'], url);
      const fine = loadProviders([{ ...madeUp, limits: { rps: 5, perMethodRps: 2 } }], envSecrets({ RPC_URL_PUBLIC: url }),
        { context: 'research', p0ReserveBps: 2_000, egressHosts: ['api.mainnet-beta.solana.com', 'api.mainnet.solana.com'], allocation: RESEARCH }, new RecordingLog());
      assert.ok(fine.ok && fine.value.providers[0]?.config.documentedLimits.length === 4, url);
      assert.deepEqual(fine.value.warnings, [], url);                    // the same host for the egress allowlist
    }
    const live = loadProviders([primary, second, { ...publicRpc, allowInLivePaths: true }],
      envSecrets({ RPC_URL_SHYFT: 'https://a.example/', RPC_URL_CHAINSTACK: 'https://b.example/', RPC_URL_PUBLIC: 'https://api.mainnet-beta.solana.com./' }),
      { context: 'engine', p0ReserveBps: 2_000, allocation: WHOLE }, new RecordingLog());
    assert.ok(!live.ok && live.error.problems.some((p) => /allowInLivePaths = false/.test(p.message)));
  });

  it('accepts a documented byte limit, which no configured rate bounds (review C03 R3)', () => {
    const bytes = { ...publicRpc, unmeteredPrimary: true, documentedLimits: [...PUBLIC_RPC_LIMITS, { scope: 'bytes' as const, count: 100_000_000, windowMs: 30_000, fact: 'LD-26' }] };
    assert.deepEqual(problems([bytes], 'research'), []);
    assert.deepEqual(problems([{ ...bytes, documentedLimits: [{ scope: 'bytes', count: 1.5, windowMs: 30_000, fact: 'LD-26' }] }], 'research'), [
      'rpc.providers[0].documentedLimits[0]: must be { scope, count, windowMs, fact }',
      'rpc.providers[0].documentedLimits: must include the total limit',
    ]);
  });

  it('envSecrets reads own keys only', () => {
    const s = envSecrets({ A: 'x' });
    assert.equal(s.get('A'), 'x');
    assert.equal(s.get('toString'), undefined);
  });
});
