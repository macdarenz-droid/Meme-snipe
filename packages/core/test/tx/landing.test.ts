// TX-1 item 4: the landing client, driven through the real CORE-1 intent reducer. Rebroadcasts carry the identical
// signed bytes until lastValidBlockHeight; a replacement is allowed only after expiry and reconciliation; status reads
// keep CORE-1's commitment rules; no resend with a new blockhash while the old one is live. No network: the adapter
// runs on a stub transport.
import { describe, expect, test } from 'vitest';
import { decodeBase58, encodeBase58, fromBase64 } from '../../src/chain/index.ts';
import { attemptId, blockhash, signature, type TransactionAttempt } from '../../src/domain/index.ts';
import { type Effect, type IntentEvent, type IntentState, applyIntentEvent, isIllegal, newEntryIntent } from '../../src/lifecycle/index.ts';
import {
  type HttpCall,
  type LandingEndpoints,
  LandingError,
  buildTrade,
  firstAttemptAllowed,
  heightPoint,
  planBlockhash,
  planBroadcast,
  planStatusCheck,
  planTick,
  replacementAllowed,
  sendEvent,
  statusEvents,
  statusEventsAt,
  tickEvent,
} from '../../src/tx/index.ts';
import { type Transport, type TransportResult } from '../../src/tx/adapters/http.ts';
import { landingRunner } from '../../src/tx/adapters/landing-runner.ts';
import { type Moment, OFF_CHAIN } from '../../src/engine/index.ts';
import { entryIntent, reservation } from '../fixtures.ts';
import { POLICY, common, goldenOf, request } from './fixtures-policy.ts';

const ENDPOINTS: LandingEndpoints = { senderUrl: 'https://fra-sender.helius-rpc.com/fast', rpcUrl: 'https://rpc.example.invalid/' };
const LVBH = 1_000n;
const NOW: Moment = { slot: 1n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: 0 };

/** A built pool buy with a stand-in signature in its slot (test bytes only: nothing here signs). */
const signedFixture = (seed: number) => {
  const g = goldenOf('pool-buy');
  const r = buildTrade(request('pool-buy'), common(g, { lastValidBlockHeight: LVBH }), POLICY);
  if (!r.ok) throw new Error(r.detail);
  const bytes = r.tx.compiled.wire.slice();
  for (let i = 1; i <= 64; i++) bytes[i] = (seed * 31 + i) & 0xff || 1;
  const sig = signature(encodeBase58(bytes.subarray(1, 65)));
  return { built: r.tx, bytes, sig, blockhash: blockhash(common(g).recentBlockhash) };
};

const step = (s: IntentState, e: IntentEvent): { state: IntentState; effects: readonly Effect[] } => {
  const t = applyIntentEvent(s, e);
  if (isIllegal(t)) throw new Error(`illegal ${e.type} from ${t.from}: ${t.reason}`);
  return t;
};

/** An entry intent taken to `submitted` with one signed attempt; returns the broadcast effect. */
const submitted = (seed = 1) => {
  const f = signedFixture(seed);
  const intent = entryIntent(seed);
  const attempt: TransactionAttempt = {
    id: attemptId(`a-${seed}`), intentId: intent.id, signedBytesRef: `sha256:${seed}`, signature: f.sig, blockhash: f.blockhash, lastValidBlockHeight: LVBH, quote: f.built.quote,
  };
  let s = newEntryIntent(intent);
  for (const e of [{ type: 'mark_eligible' }, { type: 'approve_risk' }, { type: 'reserve_exposure', reservation: reservation(intent.id) }, { type: 'prepare', quote: f.built.quote }] as IntentEvent[]) s = step(s, e).state;
  expect(firstAttemptAllowed(s)).toEqual({ ok: true });
  s = step(s, { type: 'sign', attempt }).state;
  expect(firstAttemptAllowed(s).ok).toBe(false);
  const sub = step(s, { type: 'submit' });
  const broadcast = sub.effects.find((e) => e.type === 'broadcast') as Extract<Effect, { type: 'broadcast' }>;
  return { ...f, attempt, state: sub.state, broadcast };
};

const reasonOf = (c: { ok: boolean; reason?: string }) => c.reason ?? '';
const sentBytes = (calls: readonly HttpCall[]) => calls.map((c) => fromBase64((c.body.params[0] as string)));

describe('broadcast: identical signed bytes, both paths, no preflight, no node retries', () => {
  test('a broadcast effect becomes one send to Sender (SWQoS-only, mev-protect) and one to our RPC', () => {
    const { broadcast, attempt, bytes } = submitted();
    const calls = planBroadcast(broadcast, attempt, bytes, ENDPOINTS);
    expect(calls.map((c) => [c.path, c.url])).toEqual([
      ['sender', 'https://fra-sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true'],
      ['rpc', 'https://rpc.example.invalid/'],
    ]);
    for (const c of calls) {
      expect(c.body.method).toBe('sendTransaction');
      expect(c.body.params[1]).toEqual({ encoding: 'base64', skipPreflight: true, maxRetries: 0 });
    }
    expect(sentBytes(calls)).toEqual([bytes, bytes]);
  });

  test('every rebroadcast until lastValidBlockHeight sends the same bytes; after it, only a history status read', () => {
    const { broadcast, attempt, bytes, state } = submitted();
    let s = step(state, sendEvent([{ path: 'sender', kind: 'accepted', signature: attempt.signature }], attempt.signature)).state;
    expect(s.status).toBe('pending');
    const first = planBroadcast(broadcast, attempt, bytes, ENDPOINTS);
    for (const h of [LVBH - 50n, LVBH - 1n, LVBH]) {
      const t = step(s, tickEvent(h));
      const again = t.effects.find((e) => e.type === 'broadcast') as Extract<Effect, { type: 'broadcast' }>;
      expect(again).toEqual(broadcast);
      expect(planBroadcast(again, attempt, bytes, ENDPOINTS)).toEqual(first);
      s = t.state;
    }
    const expired = step(s, tickEvent(LVBH + 1n));
    expect(expired.effects).toEqual([{ type: 'check_status', intentId: attempt.intentId, signatures: [attempt.signature], searchHistory: true }]);
  });

  test('bytes that do not match the attempt are never sent', () => {
    const { broadcast, attempt, bytes } = submitted();
    const other = submitted(2);
    expect(() => planBroadcast(broadcast, attempt, other.bytes, ENDPOINTS)).toThrow(LandingError);
    // The same signature slot over a message with another blockhash.
    const g = goldenOf('pool-buy');
    const r = buildTrade(request('pool-buy'), common(g, { recentBlockhash: common(goldenOf('pool-sell')).recentBlockhash }), POLICY);
    if (!r.ok) throw new Error(r.detail);
    const rehashed = r.tx.compiled.wire.slice();
    rehashed.set(bytes.subarray(1, 65), 1);
    expect(() => planBroadcast(broadcast, attempt, rehashed, ENDPOINTS)).toThrow(/different blockhash/);
    const unsigned = bytes.slice();
    unsigned.fill(0, 1, 65);
    expect(() => planBroadcast({ ...broadcast, signature: signature('1'.repeat(64)) }, { ...attempt, signature: signature('1'.repeat(64)) }, unsigned, ENDPOINTS)).toThrow(LandingError);
    expect(() => planBroadcast({ ...broadcast, attemptId: attemptId('other') }, attempt, bytes, ENDPOINTS)).toThrow(/does not match/);
  });
});

describe('send outcomes', () => {
  const sig = signature(encodeBase58(new Uint8Array(64).fill(7)));
  test('accepted on any path is acceptance; a different signature is an error; timeouts are unknown', () => {
    expect(sendEvent([{ path: 'sender', kind: 'error', message: 'x' }, { path: 'rpc', kind: 'accepted', signature: sig }], sig)).toEqual({ type: 'send_accepted' });
    expect(sendEvent([{ path: 'sender', kind: 'timeout' }, { path: 'rpc', kind: 'error', message: 'blockhash not found' }], sig)).toEqual({ type: 'send_timeout' });
    expect(sendEvent([{ path: 'sender', kind: 'accepted', signature: 'abc' }, { path: 'rpc', kind: 'error', message: 'boom' }], sig)).toEqual({
      type: 'send_error', message: 'sender: answered signature abc; rpc: boom',
    });
    expect(() => sendEvent([], sig)).toThrow(LandingError);
  });
});

describe('status reads keep CORE-1 commitment rules', () => {
  test('requests carry every signature, the history flag and the confirmed block height', () => {
    const { attempt } = submitted();
    const plan = planStatusCheck({ type: 'check_status', intentId: attempt.intentId, signatures: [attempt.signature], searchHistory: true }, ENDPOINTS);
    expect(plan.height.body).toEqual({ jsonrpc: '2.0', id: 1, method: 'getEpochInfo', params: [{ commitment: 'confirmed' }] });
    expect(plan.statuses.body).toEqual({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[attempt.signature], { searchTransactionHistory: true }] });
    expect(planTick(ENDPOINTS).body).toEqual({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [{ commitment: 'confirmed' }] });
    expect(planBlockhash(ENDPOINTS).body).toEqual({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] });
  });

  test('processed success waits, confirmed success fills; failure is terminal only at finalized', () => {
    const { attempt, state } = submitted();
    let s = step(state, { type: 'send_accepted' }).state;
    const read = (status: string | null, err: unknown) => statusEvents([attempt.signature], [{ slot: 1, err, confirmationStatus: status }], 10n, false)[0]!;
    expect(step(s, read('processed', null)).state.status).toBe('pending');
    expect(step(s, read('confirmed', { InstructionError: [4, { Custom: 6040 }] })).state.status).toBe('pending');
    expect(step(s, read('finalized', { InstructionError: [4, { Custom: 6040 }] })).state.status).toBe('failed');
    const filled = step(s, read('confirmed', null));
    expect(filled.state.status).toBe('confirmed_fill');
    expect(filled.effects).toContainEqual({ type: 'reconcile_balances', intentId: attempt.intentId });
    s = filled.state;
    expect(replacementAllowed(s, LVBH + 10n).ok).toBe(false);
  });

  test('unknown commitment levels and mismatched answers are refused, never guessed', () => {
    const { attempt } = submitted();
    expect(() => statusEvents([attempt.signature], [{ slot: 1, err: null, confirmationStatus: null }], 1n, false)).toThrow(LandingError);
    expect(() => statusEvents([attempt.signature], [{ slot: 1, err: null, confirmationStatus: 'rooted' }], 1n, false)).toThrow(LandingError);
    expect(() => statusEvents([attempt.signature], [], 1n, false)).toThrow(LandingError);
    expect(statusEvents([attempt.signature], [null], 5n, true)).toEqual([
      { type: 'status', signature: attempt.signature, result: 'not_found', commitment: null, blockHeight: 5n, searchedHistory: true },
    ]);
  });
});

describe('replacement only after expiry and reconciliation', () => {
  test('no new blockhash while the old one is live; allowed once expired, history-searched and reconciled empty', () => {
    const { attempt, state } = submitted();
    let s = step(state, { type: 'send_accepted' }).state;
    expect(reasonOf(replacementAllowed(s, LVBH))).toMatch(/needs a reconciled intent/);
    // Not found before expiry, even with a history search: still in flight.
    s = step(s, statusEvents([attempt.signature], [null], LVBH, true)[0]!).state;
    expect(s.status).toBe('pending');
    s = step(s, statusEvents([attempt.signature], [null], LVBH + 1n, true)[0]!).state;
    expect(s.status).toBe('expired_unfilled');
    expect(replacementAllowed(s, LVBH + 1n).ok).toBe(false);
    // Reconciled with no balance change: now, and only now, a replacement may be built.
    s = step(s, { type: 'reconcile', fills: [], blockHeight: LVBH + 1n }).state;
    expect(s.status).toBe('reconciled');
    expect(replacementAllowed(s, LVBH + 1n)).toEqual({ ok: true });
    // Had the attempt still been live at the height given, the check refuses.
    expect(reasonOf(replacementAllowed(s, LVBH))).toMatch(/can still land until block height 1000/);
    // The CORE-1 reducer agrees on both sides.
    const next = signedFixture(9);
    const replacement: TransactionAttempt = { ...attempt, id: attemptId('a-replacement'), signature: next.sig, signedBytesRef: 'sha256:r', lastValidBlockHeight: LVBH + 200n };
    expect(isIllegal(applyIntentEvent(s, { type: 'sign_replacement', attempt: replacement, blockHeight: LVBH }))).toBe(true);
    expect(step(s, { type: 'sign_replacement', attempt: replacement, blockHeight: LVBH + 1n }).state.status).toBe('signed');
  });

  test('a cancel request blocks replacement', () => {
    const { attempt, state } = submitted();
    let s = step(state, { type: 'send_accepted' }).state;
    s = step(s, { type: 'cancel' }).state;
    s = step(s, statusEvents([attempt.signature], [null], LVBH + 1n, true)[0]!).state;
    expect(replacementAllowed({ ...s, status: 'reconciled', fills: [] }, LVBH + 1n)).toEqual({ ok: false, reason: 'cancel was requested' });
  });
});

describe('landing runner (adapter) on a stub transport', () => {
  const stub = (answer: (c: HttpCall) => TransportResult) => {
    const calls: HttpCall[] = [];
    const transport: Transport = { call: async (c) => (calls.push(c), answer(c)) };
    return { calls, transport };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  test('broadcast: both paths get the stored bytes; the round reports one lifecycle event', async () => {
    const { broadcast, attempt, bytes } = submitted();
    const { calls, transport } = stub((c) => (c.path === 'sender' ? { kind: 'ok', result: attempt.signature } : { kind: 'timeout' }));
    const events: IntentEvent[] = [];
    const alerts: string[] = [];
    const runner = landingRunner({
      transport, endpoints: ENDPOINTS, store: { attempt: (_i, a) => (a === attempt.id ? { attempt, bytes } : null) }, emit: (_i, e) => events.push(e), alert: (_i, m) => alerts.push(m),
    });
    expect(runner.handles(broadcast)).toBe(true);
    expect(runner.handles({ type: 'reconcile_balances', intentId: attempt.intentId })).toBe(false);
    runner.run(broadcast, NOW);
    await flush();
    expect(sentBytes(calls)).toEqual([bytes, bytes]);
    expect(events).toEqual([{ type: 'send_accepted' }]);
    expect(alerts).toEqual([]);
  });

  test('review item 4: the height is read before the statuses, so a landing between the two reads is never expired', async () => {
    // A chain that moves after every answer: at first the attempt has not landed and the height is lastValidBlockHeight;
    // right after the first answer it lands in block LVBH and the confirmed height passes LVBH. Answers are given in
    // the order requests arrive.
    const { attempt, state } = submitted();
    let landed = false;
    let height = LVBH;
    const calls: string[] = [];
    const transport: Transport = {
      call: async (c) => {
        calls.push(c.body.method);
        const answer: TransportResult = c.body.method === 'getEpochInfo'
          ? { kind: 'ok', result: { absoluteSlot: 5_000, blockHeight: Number(height) } }
          : { kind: 'ok', result: { context: { slot: 5_001 }, value: [landed ? { slot: 5_001, err: null, confirmationStatus: 'confirmed' } : null] } };
        landed = true;
        height = LVBH + 1n;
        return answer;
      },
    };
    const events: IntentEvent[] = [];
    const effect: Extract<Effect, { type: 'check_status' }> = { type: 'check_status', intentId: attempt.intentId, signatures: [attempt.signature], searchHistory: true };
    landingRunner({ transport, endpoints: ENDPOINTS, store: { attempt: () => null }, emit: (_i, e) => events.push(e), alert: () => undefined }).run(effect, NOW);
    await flush();
    await flush();
    expect(calls).toEqual(['getEpochInfo', 'getSignatureStatuses']);
    expect(events).toEqual([{ type: 'status', signature: attempt.signature, result: 'succeeded', commitment: 'confirmed', blockHeight: LVBH, searchedHistory: true }]);
    // Fed to CORE-1 the attempt is filled, never expired, so no replacement can follow.
    let s = step(state, { type: 'send_accepted' }).state;
    for (const e of events) s = step(s, e).state;
    expect(s.status).toBe('confirmed_fill');
  });

  test('re-check item 1: a status answer from a node behind the height read is no answer, so nothing expires', async () => {
    // One RPC URL, two nodes: getEpochInfo is answered by a node at slot 9,000 whose confirmed height is past
    // lastValidBlockHeight; getSignatureStatuses by a node at slot 8,990 that has not seen the landing block yet.
    const { attempt, state } = submitted();
    const answers = (statusSlot: number): Transport => ({
      call: async (c) => (c.body.method === 'getEpochInfo'
        ? { kind: 'ok', result: { absoluteSlot: 9_000, blockHeight: Number(LVBH + 1n) } }
        : { kind: 'ok', result: { context: { slot: statusSlot }, value: [null] } }),
    });
    const effect: Extract<Effect, { type: 'check_status' }> = { type: 'check_status', intentId: attempt.intentId, signatures: [attempt.signature], searchHistory: true };
    const run = async (transport: Transport) => {
      const events: IntentEvent[] = [];
      const alerts: string[] = [];
      landingRunner({ transport, endpoints: ENDPOINTS, store: { attempt: () => null }, emit: (_i, e) => events.push(e), alert: (_i, m) => alerts.push(m) }).run(effect, NOW);
      await flush();
      await flush();
      return { events, alerts };
    };
    const lagging = await run(answers(8_990));
    expect(lagging).toEqual({ events: [], alerts: [] });
    // The same not-found from a node at or past the height's slot does expire the attempt, as CORE-1 requires.
    const current = await run(answers(9_000));
    expect(current.events).toEqual([{ type: 'status', signature: attempt.signature, result: 'not_found', commitment: null, blockHeight: LVBH + 1n, searchedHistory: true }]);
    const pending = step(state, { type: 'send_accepted' }).state;
    expect(step(pending, current.events[0]!).state.status).toBe('expired_unfilled');
    // Malformed answers are refused, never guessed.
    expect(() => heightPoint({ absoluteSlot: 1 })).toThrow(LandingError);
    expect(() => heightPoint(950)).toThrow(LandingError);
    expect(() => statusEventsAt([attempt.signature], { value: [null] }, { slot: 1n, blockHeight: 1n }, true)).toThrow(/context slot/);
    expect(statusEventsAt([attempt.signature], { context: { slot: 0 }, value: [null] }, { slot: 1n, blockHeight: 1n }, true)).toBeNull();
  });

  test('review item 4: no status request is sent before the height has answered', async () => {
    const { attempt } = submitted();
    const pending: { method: string; resolve: (r: TransportResult) => void }[] = [];
    const transport: Transport = { call: (c) => new Promise((resolve) => pending.push({ method: c.body.method, resolve })) };
    const events: IntentEvent[] = [];
    const effect: Extract<Effect, { type: 'check_status' }> = { type: 'check_status', intentId: attempt.intentId, signatures: [attempt.signature], searchHistory: true };
    landingRunner({ transport, endpoints: ENDPOINTS, store: { attempt: () => null }, emit: (_i, e) => events.push(e), alert: () => undefined }).run(effect, NOW);
    await flush();
    expect(pending.map((p) => p.method)).toEqual(['getEpochInfo']);
    pending[0]!.resolve({ kind: 'ok', result: { absoluteSlot: 7_000, blockHeight: 990 } });
    await flush();
    expect(pending.map((p) => p.method)).toEqual(['getEpochInfo', 'getSignatureStatuses']);
    pending[1]!.resolve({ kind: 'ok', result: { context: { slot: 7_000 }, value: [null] } });
    await flush();
    expect(events).toEqual([{ type: 'status', signature: attempt.signature, result: 'not_found', commitment: null, blockHeight: 990n, searchedHistory: true }]);
  });

  test('a transport that throws is reported as an alert, not an unhandled rejection', async () => {
    const { broadcast, attempt, bytes } = submitted();
    const transport: Transport = { call: async () => { throw new Error('socket closed'); } };
    const alerts: string[] = [];
    const events: IntentEvent[] = [];
    landingRunner({ transport, endpoints: ENDPOINTS, store: { attempt: () => ({ attempt, bytes }) }, emit: (_i, e) => events.push(e), alert: (_i, m) => alerts.push(m) }).run(broadcast, NOW);
    await flush();
    expect(alerts).toEqual(['landing broadcast failed: socket closed']);
    expect(events).toEqual([]);
  });

  test('an attempt that was never persisted is not sent', async () => {
    const { broadcast } = submitted();
    const { calls, transport } = stub(() => ({ kind: 'ok', result: 'x' }));
    const alerts: string[] = [];
    landingRunner({ transport, endpoints: ENDPOINTS, store: { attempt: () => null }, emit: () => undefined, alert: (_i, m) => alerts.push(m) }).run(broadcast, NOW);
    await flush();
    expect(calls).toEqual([]);
    expect(alerts).toEqual([`attempt ${broadcast.attemptId} is not persisted; nothing sent`]);
  });

  test('status checks report status events with the confirmed height; failed reads report nothing', async () => {
    const { attempt } = submitted();
    const effect: Extract<Effect, { type: 'check_status' }> = { type: 'check_status', intentId: attempt.intentId, signatures: [attempt.signature], searchHistory: false };
    const ok = stub((c) => (c.body.method === 'getEpochInfo' ? { kind: 'ok', result: { absoluteSlot: 1, blockHeight: 950 } } : { kind: 'ok', result: { context: { slot: 1 }, value: [{ slot: 1, err: null, confirmationStatus: 'confirmed' }] } }));
    const events: IntentEvent[] = [];
    landingRunner({ transport: ok.transport, endpoints: ENDPOINTS, store: { attempt: () => null }, emit: (_i, e) => events.push(e), alert: () => undefined }).run(effect, NOW);
    await flush();
    expect(events).toEqual([{ type: 'status', signature: attempt.signature, result: 'succeeded', commitment: 'confirmed', blockHeight: 950n, searchedHistory: false }]);
    const bad = stub(() => ({ kind: 'http-error', status: 429 }));
    const none: IntentEvent[] = [];
    landingRunner({ transport: bad.transport, endpoints: ENDPOINTS, store: { attempt: () => null }, emit: (_i, e) => none.push(e), alert: () => undefined }).run(effect, NOW);
    await flush();
    expect(none).toEqual([]);
  });
});

test('fixture sanity: stand-in signatures are 64 bytes and decode', () => {
  const f = signedFixture(3);
  expect(decodeBase58(f.sig).length).toBe(64);
});
