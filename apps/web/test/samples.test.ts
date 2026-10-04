// SAMPLE-QR: sample data (the preview's Samples tab, fixtures.ts) must never show an address money can be sent to.
// The old sample bot wallet decoded to 32 bytes, a valid Solana address nobody controls, with a scannable QR code.
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SampleScope } from '../src/components/Sample.tsx';
import { fixtureWallet } from '../src/dev/fixtures.ts';
import { DepositPanel } from '../src/funding/DepositPanel.tsx';
import { isAddress } from '../src/funding/withdraw.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 to bytes, as a wallet decodes an address; null when a character is not base58. */
const base58 = (s: string): number[] | null => {
  let n = 0n;
  for (const c of s) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) return null;
    n = n * 58n + BigInt(d);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return bytes;
};

const REAL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const QR = /<svg[^>]*aria-label="QR code of the bot wallet address"/;

describe('sample data never shows a real address (SAMPLE-QR)', () => {
  it('the decoder reads real addresses as 32 bytes', () => {
    expect(base58(REAL)).toHaveLength(32);
    expect(base58('11111111111111111111111111111111')).toHaveLength(32);
  });

  it('the sample bot wallet and saved wallet are not addresses: not base58, never 32 bytes', () => {
    for (const a of [fixtureWallet.botAddress!, fixtureWallet.savedWallet!]) {
      expect(a).toHaveLength(44);
      expect(isAddress(a), a).toBe(false);
      expect(base58(a), a).toBeNull();
    }
  });

  it('the deposit panel of the Samples tab shows the sample text and no QR code; its sheet sits inside sample data', () => {
    const html = renderToStaticMarkup(h(SampleScope, null, h(DepositPanel, { wallet: fixtureWallet, gatePassed: true })));
    expect(html).toContain(fixtureWallet.botAddress!);
    expect(html).not.toMatch(QR);
    expect(html).not.toContain('<path');
    const page = readFileSync(new URL('../src/dev/Fixtures.tsx', import.meta.url), 'utf8');
    const sheet = page.indexOf('<FundingSheet');
    expect(sheet).toBeGreaterThan(page.indexOf('<SampleScope>'));
    expect(sheet).toBeLessThan(page.indexOf('</SampleScope>'));
  });

  it('inside sample data no QR code even for a real-shaped address; outside it, one for a real address only', () => {
    const real = { ...fixtureWallet, botAddress: REAL };
    expect(renderToStaticMarkup(h(SampleScope, null, h(DepositPanel, { wallet: real, gatePassed: true })))).not.toMatch(QR);
    expect(renderToStaticMarkup(h(DepositPanel, { wallet: real, gatePassed: true }))).toMatch(QR);
    expect(renderToStaticMarkup(h(DepositPanel, { wallet: fixtureWallet, gatePassed: true }))).not.toMatch(QR);
  });
});
