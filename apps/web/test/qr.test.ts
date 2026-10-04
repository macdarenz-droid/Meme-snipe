import jsQR from 'jsqr';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { fixtureWallet } from '../src/dev/fixtures.ts';
import { DepositPanel } from '../src/funding/DepositPanel.tsx';
import { encodeQr, type QrMatrix } from '../src/funding/qr.ts';

/** Draws the module grid as white-and-black RGBA pixels with a four-module quiet zone, as a scanner sees it. */
function toImage(m: QrMatrix, scale = 8, quiet = 4) {
  const side = (m.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }),
  );
  return { data, side };
}

const decode = (text: string): string | null => {
  const { data, side } = toImage(encodeQr(text));
  return jsQR(data, side, side)?.data ?? null;
};

// Real-format Solana addresses: the system program (32 characters), a wrapped SOL mint (43), a long address (44), and a 33 character one.
const ADDRESSES = [
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  '4Nd1mYQ7sXcWZ4yq1fB9cT8uJ3VhKzRrPpX2eLwG6',
];
// A real-shaped bot wallet for the panel; sample data never holds one (SAMPLE-QR, samples.test.ts).
const wallet = { ...fixtureWallet, botAddress: ADDRESSES[2]! };

describe('QR code', () => {
  it('decodes back to exactly the address, for addresses of 32 to 44 characters', () => {
    const lengths = new Set(ADDRESSES.map((a) => a.length));
    expect(Math.min(...lengths)).toBe(32);
    expect(Math.max(...lengths)).toBe(44);
    for (const a of ADDRESSES) expect(decode(a), a).toBe(a);
  });

  it('decodes a different value when one character of the address changes', () => {
    const a = wallet.botAddress;
    const changed = a.slice(0, 20) + (a[20] === 'A' ? 'B' : 'A') + a.slice(21);
    expect(decode(changed)).toBe(changed);
    expect(decode(changed)).not.toBe(decode(a));
  });

  it('uses error correction level M or higher in byte mode', () => {
    // Format information, copy beside the top-left finder: bits 14 and 13 are m[8][0] and m[8][1], stored xor 0x5412.
    // Level indicator: L = 01, M = 00, Q = 11, H = 10.
    const m = encodeQr(wallet.botAddress);
    const level = ((m[8]![0] ? 1 : 0) ^ 1) * 2 + ((m[8]![1] ? 1 : 0) ^ 0);
    expect(level).not.toBe(0b01);
    expect(level).toBe(0b00);
    const { data, side } = toImage(m);
    expect(jsQR(data, side, side)?.chunks[0]?.type).toBe('byte');
  });

  it('draws the same address in the text, the QR code and the copy button', () => {
    const html = renderToStaticMarkup(h(DepositPanel, { wallet, gatePassed: true }));
    const shown = /data-testid="bot-address">([^<]+)</.exec(html)?.[1];
    const copied = /data-copy="([^"]+)"/.exec(html)?.[1];
    const path = /<path d="([^"]+)" fill="#000000"/.exec(html)?.[1] ?? '';
    // Rebuild the matrix from the SVG path: each run is "M x y h w v1 h-w z" with the quiet zone offset of 4.
    const size = Number(/viewBox="0 0 (\d+) /.exec(html)?.[1]);
    const m: QrMatrix = Array.from({ length: size - 8 }, () => new Array<boolean>(size - 8).fill(false));
    for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1/g)) for (let i = 0; i < Number(w); i++) m[Number(y) - 4]![Number(x) - 4 + i] = true;
    const { data, side } = toImage(m);
    const decoded = jsQR(data, side, side)?.data;
    expect(shown).toBe(wallet.botAddress);
    expect(copied).toBe(shown);
    expect(decoded).toBe(shown);
  });

  it('shows no copy value and no QR before the gate passes', () => {
    const html = renderToStaticMarkup(h(DepositPanel, { wallet: fixtureWallet, gatePassed: false }));
    expect(html).not.toContain('data-copy');
    expect(html).not.toContain('<path');
  });
});
