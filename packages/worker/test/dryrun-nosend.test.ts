// TEST-2 "never sent": the dry run has no send path at all. Two proofs: (1) the static import graph from the dry-run
// module reaches no module and no function that can send a transaction; (2) at run time every request the dry run
// makes is a read or a simulation, and asking it for anything else fails before any request is built.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POLICY, RATES, common, goldenOf, request } from '../../core/test/tx/fixtures-policy.ts';
import type { Kind } from '../../core/test/tx/helpers.ts';
import { associatedTokenAddress } from '../../core/src/tx/index.ts';
import * as dryrun from '../src/dryrun/index.ts';
import { DRYRUN_METHODS, DryRunRpc, NoSendPath, dryRunTrade } from '../src/dryrun/index.ts';
import { HELIUS_FREE, ManualTimers, P2, Scheduler } from '../src/scheduler/index.ts';
import { blockNetwork } from './helpers.ts';
import { stubChain, testAddress, tokenAccount, wallet } from './dryrun-chain.ts';

blockNetwork();

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY = join(REPO, 'packages/worker/src/dryrun/index.ts');

/** Every module reachable from `entry` through static imports and re-exports (relative specifiers). */
const reachable = (entry: string): Map<string, string> => {
  const out = new Map<string, string>();
  const todo = [entry];
  while (todo.length > 0) {
    const f = todo.pop()!;
    if (out.has(f)) continue;
    const text = readFileSync(f, 'utf8');
    out.set(f, text);
    // `import … from '…'`, `export … from '…'`, and side-effect imports `import '…'`.
    const specs = [...text.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const spec of specs) {
      // Only relative imports and Node built-ins exist in this repo's source; a package import would be unchecked.
      if (spec.startsWith('.')) todo.push(resolve(dirname(f), spec));
      else expect(spec, `${relative(REPO, f)} imports a package`).toMatch(/^node:/);
    }
  }
  return out;
};

/** Source without comments. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** Modules that can send: the TX-1 landing client and its HTTP adapters, and the barrels that re-export them. */
const SENDING_MODULES = [
  'packages/core/src/tx/landing.ts',
  'packages/core/src/tx/adapters/http.ts',
  'packages/core/src/tx/adapters/landing-runner.ts',
  'packages/core/src/tx/index.ts',
  'packages/worker/src/providers/index.ts',
];
/** Solana send methods and the TX-1 functions that plan or run a broadcast. */
const SEND_NAMES = /\b(sendTransaction|sendRawTransaction|sendBundle|sendEvent|planBroadcast|landingRunner|httpTransport|LANDING_EFFECTS)\b/;

describe('no send path: static import graph', () => {
  const graph = reachable(ENTRY);
  const files = [...graph.keys()].map((f) => relative(REPO, f));

  it('reaches the TX-1 builders and the signer policy, and none of the sending modules', () => {
    expect(files).toContain('packages/core/src/tx/trade.ts');
    expect(files).toContain('packages/core/src/tx/policy.ts');
    for (const m of SENDING_MODULES) expect(files, m).not.toContain(m);
  });

  it('no reachable module names a send method or loads code dynamically', () => {
    for (const [f, text] of graph) {
      const name = relative(REPO, f);
      expect(text, name).not.toMatch(SEND_NAMES);
      // The HTTP client (fetch) is injected and only ever carries the methods the runtime trap allows.
      expect(code(text), name).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\beval\s*\(/);
    }
  });

  it('the only reachable function named send* is the HTTP request helper, whose only dry-run caller is the method-checked RPC', () => {
    const sendExports = [...graph].flatMap(([f, text]) => [...text.matchAll(/export\s+(?:const|function|class|async function)\s+(send\w*)/gi)].map((m) => `${relative(REPO, f)}:${m[1]}`));
    expect(sendExports).toEqual(['packages/worker/src/providers/http.ts:send']);
    const callers = [...graph].filter(([f, text]) => f.includes('/dryrun/') && /\bsend\s*\(/.test(code(text))).map(([f]) => relative(REPO, f));
    expect(callers).toEqual(['packages/worker/src/dryrun/rpc.ts']);
  });

  it.each([
    ['a named import', (p: string) => `import { planBroadcast } from '${p}';\nexport const x = planBroadcast;\n`],
    ['a side-effect import', (p: string) => `import '${p}';\n`],
  ])('the guard itself catches a send path (planted %s)', (_, source) => {
    const dir = mkdtempSync(join(tmpdir(), 'dryrun-plant-'));
    const planted = join(dir, 'planted.ts');
    const landing = relative(dir, join(REPO, 'packages/core/src/tx/landing.ts'));
    writeFileSync(planted, source(landing.startsWith('.') ? landing : `./${landing}`));
    try {
      const g = reachable(planted);
      expect([...g.keys()].map((f) => relative(REPO, f))).toContain('packages/core/src/tx/landing.ts');
      expect([...g.values()].some((t) => SEND_NAMES.test(t))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the module exports nothing that sends', () => {
    for (const name of Object.keys(dryrun)) expect(name).not.toMatch(/^send|broadcast|land/i);
  });
});

describe('no send path: runtime trap', () => {
  const setup = () => {
    const { chain, http } = stubChain();
    const scheduler = new Scheduler({ ...HELIUS_FREE, window: { limit: 1_000, windowMs: 1_000 } }, { timers: new ManualTimers(0) });
    return { chain, scheduler, rpc: new DryRunRpc({ url: () => 'https://rpc.test/', http, scheduler, timeoutMs: 1_000 }) };
  };

  it('the method list is closed and frozen', () => {
    expect([...DRYRUN_METHODS]).toEqual(['getMultipleAccounts', 'getTokenLargestAccounts', 'simulateTransaction']);
    expect(Object.isFrozen(DRYRUN_METHODS)).toBe(true);
    expect(() => (DRYRUN_METHODS as unknown as string[]).push('sendTransaction')).toThrow(TypeError);
  });

  it.each(['sendTransaction', 'sendRawTransaction', 'sendBundle', 'requestAirdrop', 'getBalance'])('%s is refused before the scheduler or the network', async (method) => {
    const { chain, scheduler, rpc } = setup();
    await expect(rpc.call(method as never, [], P2)).rejects.toBeInstanceOf(NoSendPath);
    expect(chain.requests).toHaveLength(0);
    expect(scheduler.status().granted).toEqual([0, 0, 0, 0]);
  });

  it('a full dry run of every kind only reads and simulates', async () => {
    const methods = new Set<string>();
    for (const kind of ['curve-buy', 'curve-sell', 'pool-buy', 'pool-sell'] as Kind[]) {
      const { chain, rpc } = setup();
      const bot = testAddress(1);
      const buyer = testAddress(2);
      const holder = testAddress(3);
      const req = request(kind);
      const mint = req.venue === 'curve' ? req.market.mint : req.market.state.baseMint;
      const amount = req.side === 'sell' ? (req.venue === 'curve' ? req.quote.tokens : req.quote.base) : 0n;
      const ata = associatedTokenAddress(holder, mint, req.market.baseTokenProgram);
      chain.accounts.set(buyer, wallet(10n ** 12n)).set(holder, wallet(10n ** 9n)).set(ata, tokenAccount(mint, holder, amount));
      chain.largest = [{ address: ata, amount: amount.toString() }];
      chain.simulate = () => ({ err: { InstructionError: [0, 'Custom'] }, logs: [] });
      const r = await dryRunTrade(
        {
          id: kind, request: req, common: common(goldenOf(kind), { wallet: bot }), policy: POLICY, minContextSlot: 1n,
          signerPolicy: { wallet: bot, kind: 'trade', maxSolOut: 10n ** 12n, maxPriorityFeeLamports: POLICY.maxPriorityFeeLamports, maxTipLamports: POLICY.maxTipLamports, tipAccounts: POLICY.tipAccounts, withdrawalAddress: null, lamportsPerSignature: RATES.lamportsPerSignature, rent: RATES.rent },
        },
        { rpc, priority: P2, buyStandIns: [buyer] },
      );
      expect(r.outcome).toBe('sim-error');
      for (const q of chain.requests) methods.add(q.method);
    }
    expect([...methods].sort()).toEqual(['getMultipleAccounts', 'getTokenLargestAccounts', 'simulateTransaction']);
  });
});
