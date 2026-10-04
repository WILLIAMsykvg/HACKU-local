# ProofPay: your agent pays, your personal context stays on your phone

> **Payments used to trade privacy for safety. We prove safety locally and leave privacy where it is.**

HacKU 2026 · FinTech Problem 1 "Give a Machine a Wallet – Agentic Commerce" (The Club by HKT) · Team 23 "Local Deployment"

**Live demo:** https://hacku-local-deployment.onrender.com (free tier, about a minute to wake after 15 idle minutes) · **Judges, start here:** [`docs/judge-guide.md`](docs/judge-guide.md) · **Demo video:** [release `demo-video`](https://github.com/WILLIAMsykvg/HACKU-local/releases/tag/demo-video) · **Observed rates and fees:** [`docs/sources.md`](docs/sources.md)

The web app has an **EN / 中文** switch in the top bar. DeepSeek mode needs the access code given on the submission form; scripted mode needs none.

| Real | Simulated | Not built |
|---|---|---|
| Products, prices, stock and cart links from three live Hong Kong Shopify stores (read-only, HKD enforced) · location compared on the device using its real position · Ed25519 signatures and verification · bank-side score recompute · rule engine · one-time credential · Stripe test mode on Mastercard and UnionPay · hash-chained log | Face ID / fingerprint · the location answer is signed by the device itself (a carrier would sign it in production) · merchant purchase history · settlement uses Stripe test mode, no real money | Real issuer integration · real passkeys · placing real orders |

## In one paragraph

A shopping agent finds a real product in real Hong Kong Shopify stores and puts it in the store's real cart — but it has no payment tool and never sees the user's location, purchase history or card. Before any money moves, three issuers each answer one fixed yes/no question and sign it: *is the device near the ship-to address* (computed on the device; coordinates never leave it), *how recently did the holder strongly authenticate* (bank), and *does this order match the store's listing and the buyer's habits* (merchant). The phone combines the signed answers into a score using a public table; the bank recomputes it from the signatures and never trusts the stated number. Attestations can only make a transaction stricter — the rule engine's caps, mandate expiry and cooldowns always win. Every step is written to a hash-chained log.

## Run it

Requires Node.js **≥ 23.6** (runs TypeScript directly).

```bash
npm install
npm run build        # bundle the front end into web/dist
npm start            # http://localhost:8787
npm test             # 64 tests, no network needed
```

Development: `npm run dev` (server, restarts on change) + `npm run dev:web` (front end, http://localhost:5173).

Optional environment variables go in `.env` at the root (excluded by `.gitignore`):

| Name | Purpose | Without it |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek-mode agent | Scripted mode only |
| `TAVILY_API_KEY` | Live search within the allow-listed stores | Local snapshot `data/catalog.snapshot.json` |
| `SERPAPI_KEY` | Web-wide reference prices via Google Shopping (Hong Kong) | Tavily snippets, or none |
| `STRIPE_SECRET_KEY` | `sk_test_…`, Stripe test-mode settlement | Simulated settlement |
| `DEMO_ACCESS_CODE` | Access code for DeepSeek mode on a public deployment | No code needed |
| `PORT` | Port | 8787 |

## How one transaction works

1. **Agent** (`src/agent/`) has exactly five tools: search the allow-listed stores, compare, re-check live price and stock, put the item in the store's real cart, hand the plan to the phone and the bank. No payment tool; an item that wasn't compared can't go in the cart. Scripted mode is fixed for the demo; in DeepSeek mode the model decides, with at most 10 tool calls per order.
2. **Real stores** (`src/shop/`): only public Hong Kong Shopify data — price, stock, variants and cart links. No orders placed, no payment details entered, nothing bypassed; requests to each store are rate-limited.
3. **Comparison** (`src/shop/compare.ts`, public rules): drop out-of-stock, over-budget and wrong-spec items and say why; rank the rest by total price; within HK$10, prefer a store the user has used before (one fewer question); paid placement never changes the rank. Includes a per-store coverage report and a web-wide reference price (look, don't buy).
4. **Issuers** (`src/attest/`) each answer one fixed question, signed with Ed25519:

   | Issuer | Fixed question | In the demo |
   |---|---|---|
   | Location | Is the device within 5 km of the ship-to address right now? | **Compared in the browser using the device's real position**, signed with the device's own key (WebCrypto). Coordinates never leave the device. In production a carrier would sign it |
   | Bank | When did the holder last strongly authenticate? | Simulated fingerprint / Face ID button. Strength fades: strong within 2 h, medium 12 h, weak 24 h, then gone |
   | Merchant | Do item, price and stock match the store right now? | **Re-reads the store's public data on the spot.** A mismatch means no credential |
   | Merchant | Does this order fit the buyer's habits at this store? | The rule is real; the purchase history is demo data |

5. **Phone** passes the answers on unchanged, with a score computed from the public table (`src/attest/questions.ts`).
6. **Bank** (`src/attest/verify.ts`) checks each one: one answer per question, key on the trusted list, valid signature, signed for this order (the order hash covers merchant, item, quantity, amount and ship-to), question in the public table, price and stock consistent, score recomputes. An expired answer counts as missing (0 points).
7. **Rule engine** (`src/engine/`, spec in `docs/rules.md`) decides as usual: per-transaction cap, 7-day cap, first-purchase cooling-off, a consent click within 1 second doesn't count… **Final channel = the stricter of the engine and the proof layer.** A failed proof always declines; no credential is issued.
8. **Payment** (`src/pay/`): once approved, a one-time credential locked to this merchant and amount is issued. Card choice is a rule, not a model: never FPS for a first-time merchant (it can't be pulled back); rebates count only with a source and capture time. Settlement uses Stripe test mode or is simulated.
9. **Log** (`src/log/chain.ts`): every step goes into a hash chain — first what the agent was allowed to do, then where it was stopped. No coordinates, purchase details or keys.

## Attacks you can try in the demo

| Attack | Result |
|---|---|
| A product page hides an instruction; the agent changes the ship-to to a Shenzhen warehouse | Location answers "no"; asks you once and says why |
| Change the ship-to after the answers are signed | Order hash doesn't match; declined |
| Replay the previous order's answers | Order hash doesn't match; declined |
| Drop the answers that say "no" | Missing counts as 0; stricter, not looser |
| Change the score to 100 | Bank recompute differs; declined |
| Buy 4 (HK$876) | Over the HK$800 per-transaction cap; declined whatever the score |
| Move the clock 13 hours past strong authentication | Authorisation weakens; cooling-off |
| Revoke the mandate in one tap | Mandate expired; declined |

## Invariants

1. The engine and proof layer never call a model; no test needs the network.
2. The engine and proof layer read no external state; `now` is a parameter.
3. Every decision writes one log entry.
4. The proof layer can only make a transaction stricter.
5. The agent has no payment tool.

## Layout

```
src/
  engine/   rule engine (R-00 to R-15)
  attest/   proof layer: fixed questions, signing, scoring, verification, engine hookup
  agent/    agent: DeepSeek calls, five tools, outer loop, scripted mode
  shop/     allow-listed stores, Shopify public data, Tavily search, local snapshot
  pay/      card-choice rule, one-time credential, Stripe test mode
  server/   node:http server, one demo state per visitor
  log/      canonicalisation, hash chain
web/        front end (Vite, React, Tailwind); reuses scoring and canonicalisation from src/
tests/      engine T01–T21 · chain C01–C07 · attest A01–A21 · pay-agent P01–P15 (incl. comparison)
data/       local product snapshot, card terms (rebate figures only from our own screenshots)
docs/       judge guide, engine spec, plan, sources
```

## Known limits

- If the phone is compromised, a device-signed location can be faked. In production a carrier signs it; even faked, it can't get past the mandate's caps.
- Shopify product data has no shipping fee, so quotes count shipping as HK$0; the checkout page is authoritative.
- Score-table weights are set by hand, not trained.
- If the user is present, everything matches and they knowingly approve a scam, the system lets it through. We guarantee the cap, not zero loss.
- All rates, rebates and point values must be screenshotted and timestamped by the team; nothing is estimated.

## Credits

- Open-source libraries: React, Vite, Tailwind CSS, TypeScript (all MIT). The engine, proof layer and server use only Node built-ins.
- Services: DeepSeek API (agent), Tavily Search API (finding product pages), SerpAPI (Google Shopping reference prices), Shopify stores' public `/products/*.js`, `/products.json` and `/cart/*` endpoints, Stripe test mode.
- Allow-listed stores: THINKTHING STUDIO (www.thinkthingstudio.com), GP Batteries Hong Kong (hk.gpbatteries.com), StephyDesignHK (www.stephydesignhk.com); store country and currency checked via `/meta.json`.
- The comparison design draws on [NorthCinder](https://github.com/AIXploits/northcinder): recommendation reasons, rejection reasons, coverage report, and seen prices confirmed through the merchant's own interface before buying.
