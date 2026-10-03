# Judge guide

HacKU 2026 · FinTech Problem 1 "Give a Machine a Wallet – Agentic Commerce" (The Club by HKT) · Team 23 "Local Deployment"

**One line:** a shopping agent buys from real Hong Kong Shopify stores, but it has no payment tool and never sees your location, history or card. Before money moves, location, bank and merchant each sign one fixed yes/no answer; your phone combines them, the bank recomputes the score itself, and the answers can only make a payment stricter, never looser than the limits you set.

| | |
|---|---|
| Live demo | https://hacku-local-deployment.onrender.com (free tier: the first visit after 15 idle minutes takes about a minute to wake up) |
| Repository | https://github.com/WILLIAMsykvg/HACKU-local |
| Video · deck | linked on the submission form |
| Run locally | `npm install && npm run build && npm start`, then http://localhost:8787 (Node ≥ 23.6). `npm test` runs 64 tests with no network. |

Use the **EN** switch in the top bar for English. Each visitor gets their own demo state, and **Reset this demo** (Under the hood → Demo controls) starts over.

## Five scenes, one click each

Open the **Experience** view and use **Guided demo** on the left. Each scene runs against the real stores, real signatures and a real recompute. The right-hand card **What happened behind the scenes** ticks through the five steps; **Under the hood** (top bar) shows every step and the log.

| # | Scene | What you should see on the phone | Log events to look for (Under the hood → Hash-chained log) |
|---|---|---|---|
| 1 | **An ordinary day** — buy a 65W charger under HK$300 | Comparison card across three stores, the pick is the cheapest one at a store you have used before. Green tick, **Paid to** the chosen store, with the card, the reason it was picked and the Stripe test-mode ID | `PRICE_COMPARED` → `ATTESTATION_CHECKED ok=true` → `DECISION final_channel="instant"` → `CREDENTIAL_ISSUED` → `PAYMENT_SETTLED mode="stripe_test"` |
| 2 | **The agent gets fooled** — the product page hides an instruction to ship to a Shenzhen warehouse | Orange note **Hidden text on the page**; the phone answers **No** to *near the ship-to address* and asks you once, naming that one reason. **Not me** ends it with no payment | `PAYMENT_PLAN_SUBMITTED` with the Shenzhen ship-to → `ATTESTATION_CHECKED` (`near_ship_to` answer false) → `DECISION final_channel="ask_once"`. No `CREDENTIAL_ISSUED` follows |
| 3 | **Someone tries to skip that check** — same hijack, and the score sent by the phone is raised from 60 to 100 | Red cross, **Not paid**: the bank recomputed 60 from the signed answers and rejected the bundle | `ATTESTATION_CHECKED ok=false fail_code="A-06" stated_score=100` → `DECISION final_channel="decline"` |
| 4 | **Over your limit** — buy 4 chargers, HK$876 | **Not paid**: over the HK$800 per-transaction cap. The proof score (80 in our run) doesn't matter; the rule engine's cap wins | `DECISION final_channel="decline" triggered_rules=["R-04", …]` |
| 5 | **The next morning** — 13 hours after the last Face ID | The badge at the top of the phone drops to **Weak auth**; the same order now goes to **Take a moment first** with a countdown before it can be confirmed | `DEMO_CLOCK_SET offset_hours=13` → `DECISION final_channel="cooldown"` |

## Attacks you can run yourself

Switch to **Under the hood**. In **Your phone**, after the agent hands over a cart, the red **Attacks** box lets you tamper with the bundle before it goes to the bank. The **Bank** panel then shows which of its seven checks failed.

| Attack | Where | Expected result |
|---|---|---|
| Drop the answers that say "no" | Attacks → *Drop the "no" answers* | Missing answers count as 0, so the order gets stricter, not looser |
| Raise the score to 100 | Attacks → *Change the score to 100* | Bank check *Recompute the score* fails, `A-06`, declined |
| Replay the previous order's answers | Attacks → *Replay the last order* (needs one completed order) | Bank check *Signed for this order* fails, `A-04`, declined |
| Change the ship-to after signing | Attacks → *Agent changes ship-to after signing* | Order hash no longer matches, `A-04`, declined |
| Revoke the mandate | Demo controls → *Revoke mandate* | `R-00` mandate expired, declined |
| Click consent within 1 second | Consent card on any "ask once" order | `R-12`, not counted, no credential |

## Where the evidence is

- **Hash-chained log:** Under the hood → *Hash-chained log* → **Verify the whole chain**. The raw log and the chain check are also at `/api/log` on the live site. The log never contains coordinates, purchase history or keys.
- **Rules:** [`docs/rules.md`](rules.md) (R-00 to R-15) and the public score table [`src/attest/questions.ts`](../src/attest/questions.ts).
- **Observed rates and fees, with capture times and screenshots:** [`docs/sources.md`](sources.md).
- **What is real and what is simulated:** the table at the top of [`README.md`](../README.md).

## Scoring map

| Criterion | Where to look |
|---|---|
| Problem fit (25%) | One person (a university student in Hong Kong), one decision (electronics under HK$800, shipped to the dorm). What the agent can and cannot do: README "How one transaction works", step 1. One full transaction: scene 1. Stopped: scenes 2–5 |
| Technical implementation (25%) | Live Shopify reads with HKD enforced, Ed25519 signatures with the location answer signed on the device (WebCrypto), bank-side recompute, rule engine, one-time credential, Stripe test mode on Mastercard and UnionPay, 64 offline tests |
| Security and trust (15%) | Authentication: Face ID (simulated) that weakens over time. Authorisation: mandate plus signed answers bound to the order hash. Consent: one question, with the one reason. Audit: hash chain. Failure handling: missing answers count as worst case, any verification failure means no credential |
| Experience for Gen Z (20%) | No SMS code, no bank redirect. One question only when something is actually off, in plain words. The agent tells you when the same item is cheaper elsewhere |
| Payment-rail feasibility (15%) | The verifier sits at the card issuer (Mastercard, UnionPay) or the payer's bank app (FPS). The card rule never uses FPS for a first-time merchant. Plan, section 6: [`docs/计划书.md`](计划书.md) |

## Known limits

- Bank and merchant answers are signed by demo issuers; the location answer is signed by the device itself (in production a carrier would sign it). A compromised phone can fake location, but it still cannot go past the mandate's caps.
- Merchant purchase history is demo data. The score weights are set by hand, not trained.
- Shopify product data has no shipping fee, so quotes count shipping as HK$0.
- If you are present, everything matches and you knowingly approve a scam, the system lets it through. It guarantees the cap, not zero loss.
