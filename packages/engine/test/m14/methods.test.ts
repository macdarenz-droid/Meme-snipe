// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { METHODS, methodSpec, prepareParams } from '../../src/m14/methods.ts';

const ok = (r: ReturnType<typeof prepareParams>): unknown[] => {
  assert.ok(r.ok, r.ok ? "" : r.problem);
  return r.params;
};
const problem = (r: ReturnType<typeof prepareParams>): string => (r.ok ? 'ok' : r.problem);

describe('A-M14-01 parameter rules (logic 4)', () => {
  it('getTransaction and getBlock always carry maxSupportedTransactionVersion: 1, even when a caller asks for 0', () => {
    assert.deepEqual(ok(prepareParams('getTransaction', ['sig'], 'read', 'confirmed')),
      ['sig', { commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
    assert.deepEqual(ok(prepareParams('getTransaction', ['sig', { encoding: 'json', maxSupportedTransactionVersion: 0 }], 'read', 'confirmed')),
      ['sig', { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
    assert.deepEqual(ok(prepareParams('getBlock', [453967079n, { transactionDetails: 'signatures' }], 'read', 'finalized')),
      [453967079n, { transactionDetails: 'signatures', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
  });

  it('a read without commitment is refused (missing_commitment), and so is one the method does not support', () => {
    assert.equal(problem(prepareParams('getAccountInfo', ['pk', { encoding: 'base64' }], 'read', undefined)), 'missing_commitment');
    assert.equal(problem(prepareParams('getTransaction', ['sig'], 'read', 'processed')), 'unsupported_commitment');
    assert.equal(problem(prepareParams('getSignaturesForAddress', ['addr'], 'read', 'processed')), 'unsupported_commitment');
    assert.equal(problem(prepareParams('getAccountInfo', ['pk', { encoding: 'base64', commitment: 'finalized' }], 'read', 'confirmed')), 'commitment_conflict');
    assert.deepEqual(ok(prepareParams('getAccountInfo', ['pk', { encoding: 'base64', commitment: 'confirmed' }], 'read', 'confirmed')),
      ['pk', { encoding: 'base64', commitment: 'confirmed' }]);
  });

  it('account reads must name an encoding [DA-06]', () => {
    for (const m of ['getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts']) {
      assert.equal(problem(prepareParams(m, ['x'], 'read', 'confirmed')), 'missing_encoding', m);
      assert.ok(prepareParams(m, ['x', { encoding: 'base64' }], 'read', 'confirmed').ok, m);
    }
  });

  it('methods without commitment refuse one, and keep their parameters unchanged', () => {
    assert.equal(problem(prepareParams('getSignatureStatuses', [['s']], 'read', 'confirmed')), 'commitment_not_supported');
    assert.deepEqual(ok(prepareParams('getSignatureStatuses', [['s']], 'read', undefined)), [['s']]);
    assert.deepEqual(ok(prepareParams('getSignatureStatuses', [['s'], { searchTransactionHistory: true }], 'read', undefined)),
      [['s'], { searchTransactionHistory: true }]);
    assert.deepEqual(ok(prepareParams('getHealth', [], 'read', undefined)), []);
    assert.equal(problem(prepareParams('getHealth', [1], 'read', undefined)), 'bad_params');
    assert.deepEqual(ok(prepareParams('getSlot', [], 'read', 'confirmed')), [{ commitment: 'confirmed' }]);
  });

  it('refuses unknown methods, wrong roles and malformed parameters', () => {
    assert.equal(problem(prepareParams('requestAirdrop', [], 'read', undefined)), 'unknown_method');
    assert.equal(problem(prepareParams('toString', [], 'read', undefined)), 'unknown_method');
    assert.equal(problem(prepareParams('sendTransaction', ['tx'], 'read', undefined)), 'role_mismatch');
    assert.equal(problem(prepareParams('getSlot', [], 'send', 'confirmed')), 'role_mismatch');
    assert.ok(prepareParams('sendTransaction', ['tx', { encoding: 'base64' }], 'send', undefined).ok);
    assert.equal(problem(prepareParams('getAccountInfo', [], 'read', 'confirmed')), 'bad_params');
    assert.equal(problem(prepareParams('getAccountInfo', ['pk', { encoding: 'base64' }, 3], 'read', 'confirmed')), 'bad_params');
    assert.equal(problem(prepareParams('getAccountInfo', ['pk', ['base64']], 'read', 'confirmed')), 'bad_params');
    assert.equal(problem(prepareParams('getAccountInfo', 'pk' as unknown as unknown[], 'read', 'confirmed')), 'bad_params');
  });

  it('never changes the caller\'s arrays or objects', () => {
    const config = { encoding: 'base64' };
    const params = ['pk', config];
    ok(prepareParams('getAccountInfo', params, 'read', 'confirmed'));
    assert.deepEqual(params, ['pk', { encoding: 'base64' }]);
  });

  it('classes heavy, send and fee methods for the buckets of A-M14-02', () => {
    assert.equal(methodSpec('getProgramAccounts')?.methodClass, 'heavy');
    assert.equal(methodSpec('getBlock')?.methodClass, 'heavy');
    assert.equal(methodSpec('sendTransaction')?.methodClass, 'send');
    assert.equal(methodSpec('getPriorityFeeEstimate')?.methodClass, 'fee');
    assert.equal(methodSpec('getMultipleAccounts')?.methodClass, 'standard');
    assert.ok(Object.isFrozen(METHODS));
  });
});
