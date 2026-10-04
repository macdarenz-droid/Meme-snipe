# Funding the bot wallet from Australia: AUD to SOL and back

Research date: 2026-10-03. Owner: an individual in Australia. Bot: personal Solana meme-token bot with a $20 trading bankroll in a separate bot wallet (see `docs/ARCHITECTURE.md`, "Wallet and authorization design").

How sure each fact is:
- **[P]**: checked today on the provider's own docs, fee page or public API.
- **[S]**: secondary source only, such as a review site, a search snippet or a third-party help page. Check it before relying on it.
- **[U]**: could not be verified. Do not rely on it.

Prices used below: SOL/AUD about **A$171.58 mid**, from the public tickers of Independent Reserve (bid 171.45, ask 171.72) and BTC Markets (bid 171.48, ask 171.68) at 2026-10-03 11:23 UTC [P]. Prices move. Fees given in SOL are converted at that price.

---

## 1. Short answer

1. **Stripe cannot do this for you.** Stripe's crypto onramp is "only available in the EU and the US (excluding Hawaii)". It takes only `usd` and `eur` as the source currency, and access needs an approved onramp application [P]. There is no AUD and there are no Australian customers. Stripe does not offer a sell-SOL-to-AUD-bank feature for individuals.
2. **The easiest path today needs no third-party bridge.** Use an AUSTRAC-registered Australian exchange with free PayID deposits:
   PayID (bank) → exchange → buy SOL → withdraw SOL to your own wallet → you send the bot's allowance to the bot wallet.
   The reverse is: bot → your allowlisted wallet → exchange → sell → PayID or EFT to your bank.
   - At Independent Reserve a A$20 deposit costs about **A$0.29 (1.4%)**. A A$50 deposit costs about **A$0.46 (0.9%)**. These figures use only fees from IR's own public API [P].
   - SOL usually arrives within minutes [U for exact timing].
3. **An in-app "Deposit/Withdraw" with a card or PayID widget is possible later, but not as a private individual.**
   - Every widget provider that serves AUD (Banxa, Transak, MoonPay, Coinbase, Mercuryo, Onramper) needs a partner account. Going live needs business verification (KYB) or a paid plan.
   - The best fit for an Australian user is **Banxa**: it is Australian, takes PayID for buying and pays out by NPP bank transfer when selling [P]. **Transak** is the fastest to prototype: staging keys come instantly, but AUD is card, Apple Pay or Google Pay only [P].
   - Until then, the in-app "Deposit" button should show the bot wallet address and QR code. "Withdraw" should send only to your allowlisted owner wallet.

---

## 2. Embeddable onramp and offramp widgets (A)

| Provider | AU + AUD | Pay-in methods (AUD) | SOL on Solana | Sell to AUD bank | Fees (published) | Minimum | Who can integrate | Sandbox |
|---|---|---|---|---|---|---|---|---|
| **Stripe Crypto Onramp** | **No.** "Only available in the EU and the US (excluding Hawaii)". Source currency `usd`/`eur` only [P] | n/a | Yes, for US customers [P] | No consumer offramp. Search snippets mention a Treasury stablecoin offramp to AUD for businesses [U] | Quote API returns per-quote fees [P] | n/a | Must submit an onramp application. Stripe reviews most "within 48 hours". The business must set a public name and URL [P] | Yes, after approval [P] |
| **Banxa** (Australian) | Yes [P] | PayID (buy), NPP Direct Entry (buy and sell), cards, Apple Pay, Google Pay [P] | Yes [P] | **Yes**: PayID/Osko, NPP, EFT and card payouts. The payout account must be in your own verified name [P] | Processing fee **1.99%** on card and Apple Pay buys, 0% on other methods and on sells. Network fee on buys. **Spread typically 2–4%** (0–15% range), which includes the optional partner fee [P] | Varies by rail and tier [P]. "A$50 min" appears only for a Bitget integration [S] | Partner onboarding. Sandbox credentials come at onboarding, and production access needs approval. "No sandbox access yet? Talk to our team" [P] | Yes, after contacting Banxa [P] |
| **Transak** | Yes. AUD is supported. Its own page says it is registered in Australia [P] | **Card, Apple Pay, Google Pay** only, according to the public API. No bank or PayID method is listed for AUD [P] | Yes [P] | **Card payout (Visa) only** in AU. Minimum 14, maximum 36,028 (units as returned by the API) [P] | Not published for AUD. The fee table sits on a Notion page that could not be loaded [U] | Card/Apple Pay min 7. Google Pay min 43. The API says `limitCurrency: USD`, `isConverted: true` [P] | Sign up with a **corporate email** and get staging keys immediately. **Production needs KYB** [P] | Yes, instantly [P] |
| **MoonPay** | Yes. MoonPay Aus Pty Ltd is AUSTRAC-registered (announced 2024-09-11) [P] | Card, Apple Pay, Google Pay, bank transfer, **PayID** [P] | Yes [P] | Yes: AU bank transfer, Visa/Mastercard push-to-card. Sell **min A$20** [P] | Buy: "1% bank transfer to 4.5% card". Sell: "from 1%" (bank) to 4.5% (card) [P] | Buy min about US$20 equivalent [S] | Businesses only. "Verify your business (KYB)". Test API keys are available before approval [P] | Yes [P] |
| **Coinbase Onramp/Offramp** | Onramp: "all countries in which Coinbase operates except Japan" [P]. Australia is not confirmed in the Config API [U] | Outside the US the user **must have a Coinbase account**. Guest checkout is US-only and is being deprecated 2026-06-30 [P] | Yes [U for AU] | The Offramp docs example shows US and CA only. AU not confirmed [U] | Not published for AU [U] | n/a | CDP account and backend session tokens, single-use with a 5-minute expiry [P] | Yes [P] |
| **Ramp Network** | **No.** The public API returns `FIAT_CURRENCY_NOT_SUPPORTED` for AUD on both onramp and offramp (2026-10-03) [P] | n/a | Yes, in USD/EUR [P] | No (AUD) [P] | USD: 0.99–3.9%, min fee US$2.81 [P] | USD min US$6.76 [P] | Partner | n/a |
| **Mercuryo** | AUD is in the fiat list. Australia is in the country list [P]. Whether AU residents are served is not confirmed [U] | **Visa/Mastercard only** for AUD [P] | Yes [P] | Not confirmed for AUD [U] | Not published [U] | AUD min **40.45**, max 24,268 [P] | Partner widget ID required [P] | [U] |
| **Onramper** (aggregator) | Depends on the underlying providers | Depends on the provider | Yes | Offramp only on the **Premium** plan [P] | **US$199/month** (Essentials, 6 onramps, no offramp) or **US$599/month** (Premium). 14-day trial [P] | Depends on the provider | Paid subscription. Staging key after signup [S] | Yes [S] |

What this means:
- **Stripe is out.**
- **Ramp is out** because AUD is not supported.
- **Mercuryo** is card-only, with a minimum of about A$40.
- **Onramper's** subscription costs far more than the A$20 bankroll.
- **Banxa** and **MoonPay** are the only widgets with verified PayID buying and AUD bank payouts. Banxa's typical 2–4% spread costs about A$0.40–0.80 on A$20. MoonPay's card fee of 4.5% is about A$0.90 before spread. Both cost more than an exchange (Section 3).

---

## 3. Australian exchanges (B)

| Exchange | AUD in (PayID/bank) | SOL/AUD trading fee | SOL withdrawal fee / min | AUD out | AUSTRAC | Address allowlist |
|---|---|---|---|---|---|---|
| **Independent Reserve** | Osko/PayID **free**, EFT free, AU cards 0% [P] | **0.5%**, falling to 0.02% with volume [P]. Min order **0.004 SOL** [P] | **0.001 SOL** (about A$0.17) [P] | PayID/NPP **A$1.50** (min A$0.01). EFT **free, min A$50** [P] | Status not captured from the register [U] | **Mandatory address book.** You declare you own the wallet, and transfers to other people's wallets are not supported [P] |
| **Kraken (Bit Trade Australia)** | PayID/Osko **free, min A$5**. Card or Apple Pay: 0.25 + 3.75% [P] | Pro tier 1: **0.40% maker / 0.80% taker**. Instant buy: **1% + spread** [P] | **0.005 SOL** (about A$0.86), min 0.011 SOL [P] | Free, min A$5 [S] | [U] | New addresses need confirmation (email link, or automatic on a trusted device). Global Settings Lock is available [S, from Kraken support pages] |
| **CoinJar** | PayID/Osko/NPP **free**. Card or Apple Pay purchase 2% [P] | App: **1%** buy/sell. Exchange: **0.10%** taker/maker at the A$0–100k tier [P] | "Dynamic fee", recalculated every 15 minutes [P]. The amount is unknown [U] | Bank **free** [P] | **Says on its own site it is a registered VASP** (CoinJar Australia Pty Ltd, ACN 648 570 807) [P] | Travel Rule details are needed per address from 1 July 2026 [S] |
| **CoinSpot** | PayID **free**, direct deposit free, card free, cash 2.5% [P] | Instant buy/sell/swap **1%**. Markets 0.1% [P] | "Flat transaction fee", shown only on the wallet page after login [P]. The amount is unknown [U] | Bank **free** [P] | [U] | [U] |
| **Swyftx** | PayID/bank free [S]. API field `min_deposit: 30` for AUD [P], but what it means is not confirmed [U] | **0.6%**, tiered down to 0.1% [S]. Spread not checked [U] | **0.001 SOL**, min 0.01 SOL on the Solana network [P] | Free [S]. API `min_withdrawal: 4` [P] | [U] | [U] |
| **BTC Markets** | AUD deposit fee 0, min A$1 [P]. PayID/Osko free [S] | **0.85%** at the lowest tier [S]. Min order 0.002 SOL [P] | **0.01 SOL** (about A$1.72). **Min withdrawal 0.1 SOL (about A$17) and min SOL deposit 0.1 SOL** [P] | Fee 0, min A$1 [P] | [U] | Travel Rule page exists [S] |

How fast money moves:
- PayID/Osko deposits are near-instant at Kraken [P].
- Banxa says a first PayID payment "may take up to 24–48 hours" to be released by your bank [S].
- SOL withdrawals settle in seconds on-chain once the exchange sends them. Exchange processing time was not measured [U].

**The AUSTRAC register could not be checked.** AUSTRAC's site returned 503 or stream errors today. Before signing up, the owner should search the public **Virtual Asset Service Provider register** on austrac.gov.au and confirm the exchange is listed. Under the reformed regime, existing digital currency exchanges became registered VASPs from 31 March 2026 [S].

**Travel Rule (from 1 July 2026)** [S, confirmed by IR's own article]:
- Every withdrawal needs beneficiary details.
- Self-hosted wallets must be declared as your own.
- IR does not accept deposits from wallets owned by another person.

Both the owner wallet and the bot wallet belong to the owner, so this works. Declare them truthfully.

---

## 4. Wallet apps with built-in ramps (C)

- **Phantom.** Phantom compares quotes from Meso, Coinbase Pay, Robinhood Connect, Stripe, Unlimit, Topper, Transak and Blockchain.com (blog dated 2024-08-20). It says payment options are available "across 150+ countries" [P]. Which providers appear for an Australian user is decided in the app by location [U]. Of that list:
  - Stripe is US/EU only [P].
  - Transak serves AUD [P].
  - Coinbase needs a Coinbase account [P].
  - Phantom's own swap fee of 0.85% is from a secondary source [S].
- **Solflare.** Solflare's "Buy" goes through **Onramper**, and it has a MoonPay guide [S]. In AU that would mainly route to MoonPay, Banxa or Transak [U].
- **Verdict.** This is convenient for a one-off card top-up. It costs about 2–5% versus about 1% at an exchange (Sections 2 and 3). It does not solve selling back to AUD better than an exchange does.

---

## 5. Total cost for a A$20–A$50 bankroll

Deposit means: AUD by PayID → buy SOL → withdraw SOL to your wallet. The cost is measured against the A$171.58 mid price. Network fee for owner→bot wallet: 5,000 lamports, which is negligible.

| Route | A$20 deposit | A$50 deposit | Notes |
|---|---|---|---|
| Independent Reserve | **≈A$0.29 (1.4%)** | **≈A$0.46 (0.9%)** | All inputs [P] |
| Swyftx | ≈A$0.29 (1.5%) | ≈A$0.47 (0.9%) | 0.6% fee [S], spread not included [U], A$30 API minimum [U] |
| Kraken Pro (taker / maker) | ≈A$1.02 / A$0.94 (5.1% / 4.7%) | ≈A$1.26 / A$1.06 | The 0.005 SOL withdrawal fee dominates |
| BTC Markets | ≈A$1.90 (9.5%) | ≈A$2.17 (4.3%) | 0.01 SOL withdrawal fee. 0.1 SOL minimum withdrawal is about A$17 |
| CoinJar Exchange | ≈A$0.06 + unknown SOL withdrawal fee | ≈A$0.14 + unknown | Dynamic fee [U] |
| CoinSpot instant buy | ≈A$0.20 + unknown SOL withdrawal fee | ≈A$0.50 + unknown | [U] |
| Banxa widget (PayID) | ≈A$0.40–0.80 + network fee | ≈A$1.00–2.00 | Typical 2–4% spread [P] |
| MoonPay widget (card) | ≈A$0.90 + spread + network fee | ≈A$2.25 + spread | 4.5% card fee [P] |

Withdraw means: bot → owner wallet → exchange → sell → AUD to bank.

| Route | Selling A$20 of SOL | Selling A$50 of SOL |
|---|---|---|
| Kraken Pro (taker) | ≈A$0.16 (0.8%) | ≈A$0.40 |
| Independent Reserve | ≈A$1.62 (8.1%) with PayID A$1.50. EFT is free but has a A$50 minimum | ≈A$1.79 by PayID. By EFT, ≈A$0.29 only if the proceeds are ≥ A$50 |
| BTC Markets | ≈A$0.18. But **SOL deposits under 0.1 SOL are below its minimum** | ≈A$0.45 |
| MoonPay sell | Min A$20, 1%+ to bank [P] | ≈A$0.50+ |

Minimums that matter for this bankroll:
- BTC Markets: 0.1 SOL minimum for SOL deposits and withdrawals.
- Mercuryo: about A$40 minimum.
- MoonPay: A$20 sell minimum and about US$20 buy minimum.
- IR: A$50 minimum for free EFT.
- Kraken: A$5 minimum PayID deposit.

---

## 6. Recommendation 1: the easiest path today (no code)

**Use Independent Reserve.** It has the cheapest deposit we could fully verify from primary sources, a 0.004 SOL minimum order, and a mandatory address book.

**Alternative: Kraken.** Its AUD withdrawals are free, but it costs about A$0.86 per SOL withdrawal.

Steps:
1. Create an owner wallet in Phantom or Solflare. This is your main self-custody wallet. Its seed phrase never goes into the bot (`ARCHITECTURE.md`).
2. Search the AUSTRAC VASP register for the exchange. Open an account and complete ID checks (KYC).
3. **Address book:** add your owner wallet address and declare that you own it (Travel Rule). Add the bot wallet only if you want direct top-ups. It is also yours, so declare it the same way.
4. Deposit A$20–A$50 by PayID. This is free and usually instant. A first-ever payment can be held by your bank.
5. Buy SOL on the SOL/AUD market. The fee is 0.5%; use a limit order at the ask.
6. Withdraw SOL to your **owner wallet**. The fee is 0.001 SOL.
7. From your owner wallet, send the bot's allowance to the bot wallet. Network fee: 5,000 lamports.

Expected result: about A$19.71 of SOL from A$20.

Withdraw steps:
1. In the app, use "Withdraw", which sends only to your allowlisted owner wallet.
2. Send from the owner wallet to your IR SOL deposit address.
3. Sell SOL for AUD.
4. Withdraw by EFT if the amount is ≥ A$50 (free). Otherwise use PayID (A$1.50).
5. Or use Kraken for small cash-outs (free AUD withdrawals, A$5 minimum).

---

## 7. Recommendation 2: in-app "Deposit" and "Withdraw" buttons

**Phase 1, now, with no partner needed:**
- **Deposit** shows the bot wallet address, a QR code, a copy button and the current balance. It links out to the exchange, or to the owner's wallet app to send funds. This needs no provider agreement and no KYB, and it keeps all card and bank flows out of the app.
- **Withdraw** builds a transfer from the bot wallet **only to an allowlisted owner address**, with a separate authenticated confirmation.

**Phase 2, if a registered business (ABN or company) exists:**
- **Primary choice: Banxa.** It is Australian, takes **PayID for buying** and pays out by **NPP bank transfer when selling**. Fees are 0% processing on bank rails plus a 2–4% spread [P].
  - Onboarding: partner account, then sandbox credentials, then testing, then Banxa approval for production. Access starts via "Talk to our team" [P].
  - The no-backend "referral" integration builds a URL [P].
- **Fallback: Transak.** Staging keys come immediately after a corporate-email signup; production needs KYB [P].
  - For AUD it is card, Apple Pay or Google Pay only. Selling pays out to a Visa card only [P].
  - You can set a partner fee in the dashboard [P].
- **MoonPay** is also viable (PayID, AU bank payout). It requires business KYB. Test keys are available before approval [P].

Integration rules:
- Pre-fill the **owner wallet** address, not the bot wallet. Lock the address field if the provider allows it.
- Read order status from provider webhooks, verified server-side. Never let a webhook trigger signing.
- Store provider keys only on the server. Never put them in the frontend.

---

## 8. Security design (applies to every option)

- **Signing is separate from payments.** No card, bank or provider SDK runs in the signer process or has access to it. The signer only builds and signs Solana transactions under its policy (`ARCHITECTURE.md`).
- **Inbound funds land with the owner** (exchange account or owner wallet). The owner then funds the bot wallet up to the configured allowance, which is A$20 for now. The bot never pulls funds.
- **Outbound allowlist.** The signer's policy hard-codes one or two owner addresses. Changing them needs out-of-band owner authentication plus a time delay (for example 24h) and a notification. Any other destination is refused and logged.
- **No exchange API keys in the bot.** If they are ever needed, use read-only keys with no withdrawal permission.
- **Exchange-side protection.** Turn on 2FA and the address book. On Kraken, use the Global Settings Lock. Keep the exchange address book limited to the owner wallet.
- **Keep the deposit address out of the bot's allowlist.** Use the owner wallet as the only bot destination, because exchange deposit addresses can change and Travel Rule checks apply to them.
- **Check before sending.** Before any transfer, run a pre-flight check: the destination is on the allowlist, the amount is within the reserve, and enough SOL remains for fees and rent.

---

## 9. Australian obligations

**ATO (tax).** Source: ATO crypto pages, via search snippets [S]. ato.gov.au returned 403 to direct fetches.
- **Each swap is a CGT event.** Swapping SOL for a meme token, or a token back to SOL, counts. Every bot trade is a disposal valued in AUD at that time. Selling SOL for AUD is also a disposal.
- **Transfers between your own wallets are not disposals.** Exchange → owner wallet → bot wallet is not a CGT event. **A network fee paid in crypto during a transfer is a small disposal.**
- **Fees** such as brokerage or commission go into the cost base.
- **Capital losses** offset only capital gains, now or in future years. They cannot be deducted from other income.
- **The 50% CGT discount** needs 12 months of holding, so it will rarely apply to bot trades.
- **Business or investor?** If the activity is organised, repetitive and profit-seeking enough to be "carrying on a business", profits are ordinary income and costs are deductible. The ATO weighs repetition, volume, regularity, business-like organisation and capital. An automated bot raises this question. Ask a registered tax agent.
- **Records to keep for 5 years.** For every transaction: date, AUD value at that time, what it was for, the other party (a wallet address is enough), exchange records, wallet records and keys, and related costs such as software and agent fees.
  - The bot's trade journal should store: transaction signature, UTC timestamp, token mint, amounts, SOL/AUD and token/AUD price source, fees paid (SOL and priority), and the counterparty or pool address.
- **The ATO data-matches exchange records** [S].

**AUSTRAC.**
- The owner trading their own money does not provide a "designated service" and does not need to register.
- Registration is required before providing virtual asset services to others. These include exchanging, safekeeping or **transferring virtual assets on behalf of customers**. Doing so without registration is illegal [S].
- **If this app is ever opened to other users and holds or moves their funds, it would need VASP registration.** Keep it personal.
- The Travel Rule (Section 3) affects exchange withdrawals.

---

## 10. Open items to verify

- AUSTRAC register entries for Independent Reserve, Kraken, CoinSpot, Swyftx and BTC Markets (the site was unavailable today).
- SOL withdrawal fees for CoinJar and CoinSpot (shown only after login).
- Transak AUD fee table. Banxa and MoonPay AUD minimum buy amounts.
- Which Phantom providers appear for an Australian IP address.
- Coinbase Onramp and Offramp availability in AU (Config API needs a key).
- Swyftx `min_deposit: 30`: what it means, and the Swyftx spread.

---

## Sources

Stripe
- https://docs.stripe.com/crypto/onramp (application required; "We review most onramp applications within 48 hours")
- https://docs.stripe.com/crypto/onramp/embedded ("only available in the EU and the US (excluding Hawaii)"; `usd`/`eur` only)
- https://docs.stripe.com/crypto/onramp/stripe-hosted (currencies "available in the US and EU"; SOL listed)
- https://docs.stripe.com/crypto

Widgets
- Banxa: https://docs.banxa.com/products/hosted-checkout/docs/reference/supported-payment-methods.md · https://support.banxa.com/en/support/solutions/articles/44002465167-what-are-banxa-s-fees- · https://banxa.com/coins/sell-solana-australia · https://docs.banxa.com/products/hosted-checkout/docs/getting-started/access-and-setup
- Transak: public API https://api.transak.com/api/v2/currencies/fiat-currencies (AUD entry) · https://transak.com/buy/sol/australia · https://docs.transak.com/guides/how-to-create-partner-dashboard-account.md · https://docs.transak.com/guides/partner-faqs.md
- MoonPay: https://www.moonpay.com/newsroom/australia · https://www.moonpay.com/en-au/buy · https://www.moonpay.com/en-au/sell · https://support.moonpay.com/en/articles/694185-partner-onboarding-overview-from-signup-to-going-live · minimum (secondary): https://support.uniswap.org/hc/en-us/articles/11581208974861
- Coinbase: https://docs.cdp.coinbase.com/onramp/additional-resources/payment-methods · https://docs.cdp.coinbase.com/onramp/coinbase-hosted-onramp/overview · https://docs.cdp.coinbase.com/onramp/offramp/configurations
- Ramp Network: public API https://api.ramp.network/api/host-api/v3/assets?currencyCode=AUD (returns FIAT_CURRENCY_NOT_SUPPORTED) and ?currencyCode=USD
- Mercuryo: public API https://api.mercuryo.io/v1.6/lib/currencies (AUD card-only, min 40.45) and /lib/countries
- Onramper: https://onramper.com/pricing · https://knowledge.onramper.com/pricing (secondary)

Exchanges
- Independent Reserve: public API https://api.independentreserve.com/Public/GetDepositFees, /GetFiatWithdrawalFees, /GetCryptoWithdrawalFees2, /GetOrderMinimumVolumes, /GetMarketSummary · https://www.independentreserve.com/fees · https://www.independentreserve.com/blog/knowledge-base/how-to-deposit-and-withdraw-crypto-using-an-external-crypto-wallet-australia
- Kraken: https://support.kraken.com/articles/360000767986-cryptocurrency-withdrawal-fees-and-minimums · https://support.kraken.com/au/articles/360000381846-cash-deposit-options-fees-minimums-and-processing-times · https://www.kraken.com/features/fee-schedule · https://support.kraken.com/articles/7631228462484-adding-and-confirming-a-new-cryptocurrency-withdrawal-address
- CoinJar: https://www.coinjar.com/au/fees · public API https://data.exchange.coinjar.com/products/SOLAUD/ticker · https://www.coinjar.com/au/blog/how-the-travel-rule-affects-your-coinjar-transfers
- CoinSpot: https://www.coinspot.com.au/fees
- Swyftx: public API https://api.swyftx.com.au/markets/assets/ · fees (secondary): https://www.finder.com.au/cryptocurrency/exchanges/swyftx-exchange-review
- BTC Markets: public API https://api.btcmarkets.net/v3/assets, /v3/withdrawal-fees, /v3/markets, /v3/markets/SOL-AUD/ticker · fees (secondary): https://finder.com.au/cryptocurrency/exchanges/btc-markets-review · https://support.btcmarkets.net/hc/en-us/articles/16442384336783-Travel-Rule

Wallets
- https://phantom.com/learn/blog/buying-crypto-in-phantom-just-got-faster-and-easier
- https://help.solflare.com/en/articles/9081349-onramper-fiat-to-crypto-payment-provider-issues

Regulators
- AUSTRAC: https://www.austrac.gov.au/news-and-media/article/virtual-asset-service-provider-register-goes-public · https://www.austrac.gov.au/industry-and-business/your-industry/virtual-asset-service-providers/virtual-asset-service-providers-overview (unavailable today; summarised via search)
- ATO: https://www.ato.gov.au/individuals-and-families/investments-and-assets/crypto-asset-investments/keeping-crypto-records · https://www.ato.gov.au/individuals-and-families/investments-and-assets/crypto-asset-investments/transactions-acquiring-and-disposing-of-crypto-assets/crypto-to-crypto-exchange-or-swap · https://www.ato.gov.au/individuals-and-families/investments-and-assets/crypto-asset-investments/how-to-work-out-and-report-cgt-on-crypto · https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/income-and-deductions-for-business/crypto-assets-and-business/crypto-assets-used-in-business (403 to direct fetch; content via search snippets)


---

## Verification

Strict fact-check run 2026-10-03 (about 11:30-12:00 UTC) against each option's own docs, public API or fee page. "Verdict" is one of: **confirmed** (matches the source), **corrected** (a stated fact was wrong, overstated or needs a caveat; the fix is given), **unverifiable** (could not be checked from a primary source today). Items above that this section corrects should be read as superseded by it.

### Stripe verdict: confirmed

The verdict "No" is confirmed from Stripe's own docs.

- **Region.** The embedded onramp page says verbatim: "The embedded onramp is only available in the EU and the US (excluding Hawaii)." The Stripe-hosted page (crypto.link.com) says its currencies "are available in the US and EU". Neither mentions Australia. The customer KYC form asks for an SSN, which is also US-shaped.
- **Currency.** `source_currency` is documented as "`usd` and `eur` only for now" (embedded page, and again in the quotes API table: "We currently only support `usd` and `eur`"). No AUD.
- **Approval.** "To access the Stripe onramp, including testing environments, you must ... submit your onramp application." Stripe says: "We review most onramp applications within 48 hours." The API is in public preview. Sessions fail with `crypto_onramp_unsupportable_customer` / `crypto_onramp_unsupported_country` if the customer's IP country is not supported.
- **SOL.** Native SOL on the Solana network is a supported destination, for US and EU customers (so it is not the blocker; geography and currency are).
- **No offramp for individuals.** The Stripe crypto docs describe buying crypto only. No sell-to-bank product for individuals appears anywhere in the onramp docs. This is absence of evidence, not a Stripe statement that it does not exist.
- **The Treasury snippet is contradicted by Stripe's current docs.** A search summary claimed Treasury users can off-ramp USDC/EURC to "BRL, AUD, GBP, and NGN" bank accounts. The current docs (docs.stripe.com/treasury/transfer-send and /treasury/stablecoins) say otherwise:
  - Stablecoin payout currencies are USD, EUR, MXN, BRL, GBP, ARS, COP, PHP, NGN. **AUD is not listed.** Australia (AU) is not in the list of countries for stablecoin payouts to bank accounts.
  - A stablecoin balance is **OUSD or USDC only**. Native SOL cannot be deposited; only USDC on Solana (and other chains) can.
  - It is for **businesses**. In the currency-support table, "AU legal entities" can hold USD, GBP, EUR, AUD but **USDC is "Unsupported"**. AU is not in the private-preview country list for stablecoin balances.
  - Treasury itself is "Private preview" in Australia (request access), for businesses.
  - So there is no Stripe path from SOL to an Australian bank account, for an individual or for a business entity in AU as of today. The snippet should be dropped from the report, not just labelled unconfirmed.

### Per-option verdicts

| # | Option | Verdict | Summary |
|---|---|---|---|
| 1 | Stripe Crypto Onramp | confirmed | All stated facts match Stripe's docs (see above). |
| 2 | Banxa | corrected | Core facts confirmed. Payout-in-own-name, card payout and PayID cost need caveats. |
| 3 | Transak | confirmed | Matches its public API and partner docs. Units are USD. |
| 4 | MoonPay | corrected | PayID, "A$20" and AU bank payout are not supported by its pages. |
| 5 | Coinbase | unverifiable | AU unconfirmed, as stated. One doc line is now stale. |
| 6 | Ramp Network | confirmed | API rejects AUD. |
| 7 | Mercuryo | confirmed | Matches its API. AU residents served is still unconfirmed. |
| 8 | Onramper | confirmed | Prices and plan features match. Trial is a "limited-time offer". |
| 9 | Independent Reserve | corrected (minor) | Fees confirmed. The A$0.29/A$0.46 figures include half the order-book spread. |
| 10 | Kraken | confirmed | All checked fees match. AUD withdrawal terms are secondary only. |
| 11 | CoinJar | confirmed | Matches its fee page. SOL fee still unknown. |
| 12 | CoinSpot | confirmed | Matches its fee page. SOL fee still unknown. |
| 13 | Swyftx | confirmed | API values match. Fee and PayID claims are secondary. Two min-withdrawal fields disagree. |
| 14 | BTC Markets | confirmed | API values match. 0.85% is from a search snippet of its fee page. |
| 15 | Phantom / Solflare | confirmed | Provider lists match. AU availability and the 2-5% range are unverifiable. |

### Details

**2. Banxa (corrected)**
- Confirmed: fee page says 1.99% processing on "Cards & Apple Pay", no processing fee on other methods, no processing fee on sells. Network fee applies to buys only. Spread: Banxa spread "typically 2-4% (range 0-15% for buys; 0-10% for sells)", partner spread typically 0-1%, plus a recovery spread. Docs list "PayID (Australia)" as a native-API headless method and "PayID - AUD" as a common off-ramp payout. Banxa's "Buy Solana in Australia" page lists cards, Apple Pay, Google Pay, PayID and NPP, and says Banxa is AUSTRAC-registered. Search snippets of Banxa AU pages say sell payouts go to AUD via PayID/Osko or EFT. Partner Dashboard gives sandbox credentials; production is enabled by Banxa "once you have completed testing and received approval" (needs at least one sandbox buy order, a full checkout and a handled webhook). "Talk to our team" appears for those without sandbox access. Off-ramp "must be enabled and configured for your partner account" by contacting Banxa.
- Not confirmed: "Payout account must be in your verified name" is not stated on any Banxa page read. It is standard practice among AU exchanges but should be labelled [U] for Banxa. A "card" payout for sells is not confirmed (only PayID/Osko/EFT/NPP appeared). "NPP bank transfer" appears for buys; for sells the docs say PayID. The "simple link-based (no-backend) option" was not checked.
- Caveat on cost: Banxa's own Solana page says PayID costs "around 1%" against "3-5%" for cards. That conflicts with "0% fee + 2-4% spread" (the A$0.40-0.80 on A$20 in the claim is spread only, and excludes the network fee). Realistic all-in range for PayID: about 1% to 4%+, to be measured with a live quote.
- Minimums: still unconfirmed.

**3. Transak (confirmed)**
- Public API `fiat-currencies`, AUD entry: `isAllowed: true`, supporting country AU. Payment options: `credit_debit_card`, `apple_pay`, `google_pay` only. No bank or PayID method. Card: min 7, max 8,647. Apple Pay: min 7, max 8,647. Google Pay: min 43, max 4,323. All with `limitCurrency: USD`, `isConverted: true`, so these are USD amounts, not AUD.
- Payout: card option only (`isPayOutAllowed: true`, `visaPayoutCountries: [AU, KI]`, `mastercardPayoutCountries: []`). Payout min **14 USD**, max 36,028 USD. Apple Pay and Google Pay have `isPayOutAllowed: false`. "Min 14" in the claim is USD.
- Integration (docs.transak.com): sign up at dashboard.transak.com with a corporate email; staging API key immediately; production key after KYB (forms.transak.com/kyb); an extra partner fee percentage can be set in dashboard Settings.
- AUD fee table: still not published, as stated.

**4. MoonPay (corrected)**
- Confirmed: MOONPAY AUS PTY LTD is registered with AUSTRAC (stated on its pages; newsroom post dated 2024-09-11). SOL can be bought and sold. Buy: "credit or debit card, bank transfer, Apple Pay, Google Pay". Fees: "as low as 1% for bank transfers and 4.5% for Visa cards". Bank-transfer buys take "1-3 business days" per its AU buy page; card buys "as little as 5 minutes". Push-to-Card (Visa) sell lists Australia among its countries. Partner side: business-only (KYB); test API keys exist before approval; live keys unlock once KYB and product are approved.
- **Corrected: PayID.** None of MoonPay's en-au pages (home, buy, buy/sol, sell) or its support articles mention PayID, Osko or NPP. The 2024 announcement only says the registration "may" let MoonPay offer Osko and PayID later. Treat PayID buying as **unconfirmed**, not [P].
- **Corrected: minimum.** Buy and sell pages both say "$20" with no currency. One search snippet of the sell page said "AU$30". The currency and amount are unresolved; do not state "A$20".
- **Corrected: AU bank payout.** The sell page says "paid straight to your bank account or Visa card" and "using the local currency of your bank account"; only Visa push-to-card is explicitly tied to Australia. An Australian bank-transfer payout is **unconfirmed**.
- Sell fee: "from 1%" is only the generic "as low as 1% for bank transfers" line, not an AU-specific sell fee.

**5. Coinbase (unverifiable)**
- Confirmed: onramp works in "all countries in which Coinbase operates except Japan". Cards are supported in "US and 90+ additional countries (including EU, UK, CA)". Guest checkout (debit card, Apple Pay) is US-resident only. Session tokens are single-use and expire after 5 minutes. The Offramp config example lists US (CRYPTO_WALLET, FIAT_WALLET, ACH_BANK_ACCOUNT) and CA (CARD) only.
- Not confirmed: Australia or AUD appears nowhere in the pages read. "Outside the US the user needs a Coinbase account" is an inference, not a quoted statement.
- Stale line: the docs say guest checkout "will be deprecated on June 30, 2026". That date has passed (today is 2026-10-03), so the line "being deprecated 2026-06-30" in section 2 should read "was due to be discontinued 2026-06-30".

**6. Ramp Network (confirmed)**
- `GET /api/host-api/v3/assets?currencyCode=AUD` returns HTTP 400 `SERVICES.HOST_API.FIAT_CURRENCY_NOT_SUPPORTED`. `currencyCode=USD` works (minFeePercent 0.99, maxFeePercent 3.9). The test is on currency; I did not separately check whether AU is on Ramp's country list.

**7. Mercuryo (confirmed)**
- `/v1.6/lib/currencies`: AUD present; payment methods are `card` (Visa, Mastercard) only; limits min 40.45, max 24,268.35. `/lib/countries` includes Australia (`au`), but that is a generic country list, so whether Australian residents are served is still unconfirmed, as stated.

**8. Onramper (confirmed)**
- Pricing page: Essentials $199/month ($1,800/year, 6 onramps); Premium $599/month ($5,750/year, "All 30+ onramps"); White-Label custom. Offramp is in Premium and White-Label; Essentials has only peer-to-peer (Binance P2P). The 14-day free trial is advertised as a "limited-time offer", so it may not be available later.

**9. Independent Reserve (corrected, minor)**
- Confirmed from its public API and pages: Osko deposit fee 0, EFT 0, credit card 0%. Fiat withdrawal: Osko/PayID A$1.50 (min A$0.01); wire transfer (AUD) fee 0, min A$50. SOL withdrawal fee **0.001 SOL** (API and fee page). Smallest SOL order **0.004 SOL**. Trading fee "starts at 0.5% and can go as low as 0.02%". The address book is mandatory: "You will not be able to withdraw to wallets that are not owned by you"; transfers to other people's wallets are not supported; the Travel Rule applies from 1 July 2026; first withdrawal to a new address may need an email confirmation within 60 minutes.
- Correction: the cost figures A$0.29 (A$20) and A$0.46 (A$50) include about half the live order-book spread (bid 171.49 / ask 171.79 at 11:30 UTC, about 0.09% each side). Published fees alone are **A$0.27 on A$20** (0.5% = A$0.10, plus 0.001 SOL = A$0.17) and **A$0.42 on A$50**. The percentages (about 1.4% and 0.9%) hold either way. Section 1's wording "only fees from IR's own public API" should say "fees plus half the spread".
- AUSTRAC status: not checked.

**10. Kraken / Bit Trade Australia (confirmed)**
- Confirmed: AUD PayID/Osko deposit "Free", minimum 5 AUD. Card / Apple Pay / Google Pay: 0.25 AUD + 3.75%. Kraken Pro tier 1: maker 0.40%, taker 0.80%. App instant buy/sell: "1% trading fee on instant and recurring trades and a 1.5% fee on custom orders", plus spread. **SOL withdrawal fee 0.005 SOL, minimum 0.011 SOL** (Kraken's withdrawal-fees page, "Last updated: December 31, 2025", so it can change). The A$1.02 on A$20 matches 0.005 SOL (A$0.86) plus 0.80% taker (A$0.16); it is A$0.94 at maker 0.40% and A$1.06 on the 1% instant buy.
- Secondary only: AUD withdrawal "free, A$5 minimum" appears in a search snippet; Kraken's own PayID/Osko page read today shows only deposit limits (A$10,000 daily, A$40,000 monthly). New-address confirmation was not re-checked here.

**11. CoinJar (confirmed)**
- Fee page: PayID/Osko/NPP deposits and bank-transfer deposits and withdrawals "No fee". Card, Apple Pay and Google Pay purchases 2%. Exchange tier A$0-100k: 0.10% taker and maker. App buy/sell 1%. Crypto sends use a "Dynamic fee" recalculated every 15 minutes, so the SOL fee remains unknown. The site states CoinJar is "a registered Virtual Asset Service Provider (VASP) with ... AUSTRAC". Minimums unconfirmed.

**12. CoinSpot (confirmed)**
- Fee page: PayID free, direct deposit free, card free, cash 2.5%. Market orders 0.1%, instant buy/sell 1%. AUD bank withdrawal free (PayPal 2%). Outbound crypto uses "a standard flat transaction (mining) fee ... listed in the wallet page"; no SOL amount on the public page. The CoinSpot home page text does not mention AUSTRAC, so the section 3 "[U]" for AUSTRAC stands.

**13. Swyftx (confirmed, with a flag)**
- `api.swyftx.com.au/markets/assets/`: AUD `min_deposit` 30, `min_withdrawal` 4. SOL on the Solana network: `withdrawFee` 0.001, `withdrawMin` 0.01. **Flag:** the SOL asset-level field `min_withdrawal` is 0.02, which disagrees with the network-level 0.01; which one the app enforces is unknown.
- Secondary only (finder.com.au and news snippets; swyftx.com's fee page returned no readable content): trading fee 0.6% (down to 0.1% with VIP tiers), AUD deposits by bank transfer, PayID or Osko free, AUD withdrawals free. The A$0.29 on A$20 (0.6% = A$0.12 plus A$0.17) is arithmetic on these figures before spread.
- If the AUD `min_deposit` of 30 means A$30, a A$20 deposit would be refused. Unconfirmed either way.

**14. BTC Markets (confirmed)**
- `api.btcmarkets.net/v3/assets`: AUD deposit and withdrawal minimum 1, fees 0. SOL minimum deposit 0.1 and minimum withdrawal 0.1, withdrawal fee **0.01 SOL**, deposit fee 0. `/v3/markets`: SOL-AUD minimum order 0.002 SOL. 0.1 SOL is about A$17.2, so the "too close to a A$20 bankroll" point stands. Fee 0.85% at the lowest tier (A$0.01-500 of 30-day volume) and free PayID/Osko/NPP deposits come from search snippets of its fee and support pages (a direct fetch of /fees returned 403). A$1.90 on A$20 = 0.85% (A$0.17) + 0.01 SOL (A$1.72) = A$1.89.

**15. Phantom / Solflare (confirmed)**
- Phantom's blog lists "Meso, Coinbase Pay, Robinhood Connect, Stripe, Unlimit, Topper, Transak, and Blockchain.com", with Apple Pay, Google Pay, card or bank transfer, "across 150+ countries". The post is old and undated in the fetched text, so the provider list may be stale, and it says nothing specific about Australia. Note that Stripe's listing cannot serve Australians (see Stripe verdict). Solflare's help article names Onramper and MoonPay (card), mentions only UK geo-restrictions, and says nothing about Australia.
- Unverifiable: which providers show in Australia, and the "about 2-5%" cost range (an estimate, not a published figure).

### Fixes to apply to the sections above

Status, checked 2026-10-04: none of these is applied yet; all seven stay open. The app's Deposit and Withdraw screens (`apps/web/src/funding/exchanges.ts`) show the A$0.29 and A$0.46 Independent Reserve figures, which include half the spread (fix 5).

1. Section 2, Stripe row: delete the Treasury snippet; replace with "Stripe Treasury stablecoin payouts do not support AUD or Australia, hold USDC only (not SOL), and are business-only".
2. Section 2, MoonPay row: PayID buying becomes [U]; minimum becomes "$20, currency unstated"; AU bank-transfer payout becomes [U] (Visa push-to-card lists Australia).
3. Section 2, Banxa row: mark "payout account in your own verified name" and card payout [U]; add that Banxa's own page says PayID costs "around 1%" all-in.
4. Section 2, Coinbase row: guest-checkout deprecation date (2026-06-30) is in the past.
5. Sections 1 and 3, Independent Reserve: say A$0.29 and A$0.46 include half the spread; fees alone are A$0.27 and A$0.42.
6. Section 3, Swyftx row: note the 0.01 versus 0.02 SOL minimum-withdrawal mismatch.
7. All Transak figures (7, 43, 14) are USD amounts.
