// M04's account reads through M14 (A-M04-01 logic 1): `getMultipleAccounts` at `confirmed`, base64, at the caller's
// priority, optionally pinned to one provider (A-M04-02's re-read on the next provider). The context slot is required:
// a read without one cannot be placed in slot order, so it is refused (never a guessed slot).
import type { Pubkey, Slot } from '@bot/types';
import type { RpcGateway } from '../m14/types.ts';
import type { AccountsReader, RawAccount } from './types.ts';

type RpcAccount = { owner: unknown; data: unknown } | null;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** One RPC account: `{ owner, data: [base64, 'base64'] }`, or null when the account does not exist. */
function accountOf(a: RpcAccount): RawAccount | null | undefined {
  if (a === null) return null;
  if (typeof a !== 'object' || typeof a.owner !== 'string' || !Array.isArray(a.data) || a.data.length !== 2 || a.data[1] !== 'base64'
    || typeof a.data[0] !== 'string' || !BASE64.test(a.data[0])) return undefined;
  return { owner: a.owner, data: new Uint8Array(Buffer.from(a.data[0], 'base64')) };
}

export function gatewayAccountsReader(gateway: RpcGateway, timeoutMs: number): AccountsReader {
  return {
    async read(keys, o) {
      const r = await gateway.call<{ value?: unknown }>('getMultipleAccounts', [[...keys] as Pubkey[], { encoding: 'base64' }],
        { priority: o.priority, role: 'read', commitment: 'confirmed', timeoutMs, ...(o.provider === undefined ? {} : { provider: o.provider }) });
      if (!r.ok) return { ok: false, error: { code: r.error.code, message: r.error.message } };
      const value = r.value.value?.value;
      if (r.value.contextSlot === null) return { ok: false, error: { code: 'E_SHAPE', message: 'no context slot' } };
      if (!Array.isArray(value) || value.length !== keys.length) return { ok: false, error: { code: 'E_SHAPE', message: 'account list does not match the keys' } };
      const accounts: Array<RawAccount | null> = [];
      for (const a of value as RpcAccount[]) {
        const acc = accountOf(a);
        if (acc === undefined) return { ok: false, error: { code: 'E_SHAPE', message: 'account is not base64-encoded' } };
        accounts.push(acc);
      }
      return { ok: true, value: { contextSlot: r.value.contextSlot as Slot, providerLabel: r.value.providerLabel, latencyMs: r.value.latencyMs, accounts } };
    },
  };
}
