// Card Z03: A-M01-01's canonical-pool rule on DEC-1's mainnet goldens (fixtures/dec1/README.md). C03 found no
// non-canonical pool on chain and derived one; DEC-1's sample holds a real one, so the rule is checked both ways here.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createDecoders, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import { PROGRAMS, pumpPoolAuthorityPda } from '../src/constants.ts';

const ACCOUNTS = (JSON.parse(readFileSync(new URL('../../../fixtures/dec1/accounts.json', import.meta.url), 'utf8')) as
  { accounts: Array<{ label: string; owner: string; dataBase64: string }> }).accounts;
const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });
const pools = ACCOUNTS.filter((a) => a.owner === PROGRAMS.pumpSwap).map((a) => {
  const p = decoders.decodeAccount(a.owner, new Uint8Array(Buffer.from(a.dataBase64, 'base64')));
  return { label: a.label, pool: p.kind === 'pumpswap_pool' ? p : null };
}).filter((x) => x.pool !== null);

describe('A-M01-01 canonical pools on DEC-1 mainnet goldens (Z03)', () => {
  it('pumpPoolAuthorityPda(baseMint) equals pool.creator on the canonical pools and differs on the non-canonical one', async () => {
    const labelled = pools.filter((x) => x.label.includes('canonical PumpSwap pool'));
    assert.equal(labelled.length, 4);
    for (const { label, pool } of labelled) {
      const canonical = (await pumpPoolAuthorityPda(pool?.baseMint as string)) === pool?.creator;
      assert.equal(canonical, !label.startsWith('non-canonical'), label);
    }
  });
});
