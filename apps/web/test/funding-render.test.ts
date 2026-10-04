import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fixtureWallet } from '../src/dev/fixtures.ts';
import { DepositPanel } from '../src/funding/DepositPanel.tsx';
import { EXCHANGES, FEES_CHECKED } from '../src/funding/exchanges.ts';
import { approvingStepUp } from '../src/funding/stepUp.ts';
import { WithdrawPanel } from '../src/funding/WithdrawPanel.tsx';
import { EMPTY_WALLET } from '../src/screens/types.ts';

// A real-shaped bot wallet; sample data never holds one (SAMPLE-QR, samples.test.ts).
const realWallet = { ...fixtureWallet, botAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
const text = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Deposit', () => {
  it('shows the address, a QR code, copy, the balance in SOL and AUD, and the network warning', () => {
    const html = renderToStaticMarkup(h(DepositPanel, { wallet: realWallet, gatePassed: true }));
    const t = text(h(DepositPanel, { wallet: realWallet, gatePassed: true }));
    expect(t).toContain(realWallet.botAddress);
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="QR code of the bot wallet address"/);
    expect(t).toContain('Copy address');
    expect(t).toContain('138.456 SOL');
    expect(t).toContain('A$23,756.28');
    expect(t).toContain('Send only SOL on the Solana network to this address');
  });

  it('offers both exchanges and the steps and costs from the research', () => {
    const t = text(h(DepositPanel, { wallet: fixtureWallet, gatePassed: true }));
    expect(EXCHANGES.map((e) => e.name)).toEqual(['Independent Reserve', 'Kraken']);
    for (const e of EXCHANGES) expect(t).toContain(e.name);
    expect(t).toContain('Buy SOL on the SOL/AUD market');
    expect(t).toContain('0.001 SOL');
    expect(FEES_CHECKED).toMatch(/^\d{1,2} \w{3} 20\d\d$/);
  });

  it('shows no address or QR until the pre-funding gate has passed', () => {
    const html = renderToStaticMarkup(h(DepositPanel, { wallet: fixtureWallet, gatePassed: false }));
    expect(html).not.toContain(fixtureWallet.botAddress!);
    expect(html).not.toContain('<svg');
    // Labels and data only: the gate's state, no line explaining what happens after it (APP-WORDS N2).
    expect(text(h(DepositPanel, { wallet: fixtureWallet, gatePassed: false }))).toContain('Pre-funding gate Not passed');
    expect(text(h(DepositPanel, { wallet: fixtureWallet, gatePassed: false }))).not.toContain('Shown after the gate passes');
  });

  it('shows dashes, not zeros, when the balance is unknown', () => {
    expect(text(h(DepositPanel, { wallet: EMPTY_WALLET, gatePassed: false }))).toContain('Balance —');
  });
});

describe('Withdraw', () => {
  it('prefills the saved wallet and shows what can be sent', () => {
    const html = renderToStaticMarkup(h(WithdrawPanel, { wallet: fixtureWallet, stepUp: approvingStepUp }));
    expect(html).toContain(`value="${fixtureWallet.savedWallet}"`);
    expect(text(h(WithdrawPanel, { wallet: fixtureWallet, stepUp: approvingStepUp }))).toContain('Available to send 137.705995 SOL');
    expect(text(h(WithdrawPanel, { wallet: fixtureWallet, stepUp: approvingStepUp }))).toContain('Request transfer');
    expect(text(h(WithdrawPanel, { wallet: fixtureWallet, stepUp: approvingStepUp }))).toContain('Change saved wallet');
  });

  it('labels and data only: no line explaining the rules (AGENTS.md UI copy); the 24 h notice stays (§19 asks for it)', () => {
    const t = text(h(WithdrawPanel, { wallet: fixtureWallet, stepUp: approvingStepUp }));
    for (const gone of ['the only address Withdraw accepts', 'Balance minus the protected reserve', 'Signing comes later']) expect(t).not.toContain(gone);
    expect(readFileSync(new URL('../src/funding/WithdrawPanel.tsx', import.meta.url), 'utf8')).toContain('A new address takes effect 24 hours after you confirm with your passkey.');
  });

  it('shows a dash for the amount available when the balance is unknown', () => {
    expect(text(h(WithdrawPanel, { wallet: EMPTY_WALLET, stepUp: approvingStepUp }))).toContain('Available to send —');
  });
});

describe('funding controls', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('gives every control on the funding sheets a 44px touch target', () => {
    for (const sel of ['.button', '.input', '.text-link', '.segmented-option']) expect(rule(sel), sel).toMatch(/min-height:\s*44px/);
  });

  it('draws the error text with a checked colour token', () => {
    expect(rule('.field-error')).toMatch(/color:\s*var\(--loss\)/);
  });
});
