# Observed rates and fees

Every number below was read by the team from the provider's own public page on **Sunday 4 October 2026, Hong Kong time**, and saved as a screenshot in [`docs/evidence/`](evidence/). Capture times are the screenshot file times. Rates change; none of this is financial advice.

Worked examples use one **GP 65W GaN Charger at HK$219** from GP Batteries Hong Kong, the price in the local snapshot [`data/catalog.snapshot.json`](../data/catalog.snapshot.json). The live store price can differ.

## Payment rails and card terms

| What | As observed | Source · screenshot | Captured (HKT) | How the demo uses it |
|---|---|---|---|---|
| Stripe card processing, Hong Kong | Standard plan: **3.4% + HK$2.35** per successful transaction, domestic cards | [stripe.com/en-hk/pricing](https://stripe.com/en-hk/pricing) · [`stripe-hk-pricing.png`](evidence/stripe-hk-pricing.png) | 04:45:43 | Paid by the merchant, not the buyer. On HK$219 that is **HK$9.80**. Settlement runs in Stripe **test mode** (`pm_card_mastercard`, `pm_card_unionpay`), so nothing is actually charged. |
| Citi The Club credit card (Mastercard) | Basic Clubpoint Program: **1 Clubpoint per HK$20** eligible spending, stated as a 1% rebate at 5 Clubpoints = HK$1; no cap; Mar 7 2022 – Dec 31 2026. The extra 3% applies only at Citi's designated merchants (cap 1,500 points per cycle) | [citibank.com.hk · Citi The Club card](https://www.citibank.com.hk/english/credit-cards/citi-the-club-card/) · [`citi-the-club-basic-1pct.png`](evidence/citi-the-club-basic-1pct.png) | 04:46:53 | Counted as **1%**. The whitelisted stores are not designated merchants, so the 3% is not applied. On HK$219: 10.95 Clubpoints ≈ HK$2.19. |
| PrimeCredit EarnMORE UnionPay card | "**Up to 2%** cash rebate" on local, overseas and online spending; no registration, no merchant restriction, no minimum spend | [primecredit.com · EarnMORE](https://www.primecredit.com/credit-card/earnmore/) · [`primecredit-earnmore-2pct.png`](evidence/primecredit-earnmore-2pct.png) | 04:47:45 | Counted as **2%**, so the card rule picks this card. On HK$219: up to HK$4.38. "Up to" means caps and exclusions follow the issuer's full terms. |
| FPS via Hang Seng Bank | "24/7 instant and **free** cross-bank transfer"; no rebate | [hangseng.com · FPS](https://www.hangseng.com/en-hk/personal/banking/fps/) · [`hangseng-fps-free.png`](evidence/hangseng-fps-free.png) | 04:48:13 | No fee for the payer. Never used for a first-time merchant, because an instant push payment usually cannot be pulled back. |

The card rule lives in [`src/pay/cards.ts`](../src/pay/cards.ts) and the terms in [`data/cards.json`](../data/cards.json). A rebate only counts if its entry has a `source_url` and a `captured_at`; otherwise the rule ignores rebates and picks a credit card for chargeback protection.

## Agent running cost

| What | As observed | Source · screenshot | Captured (HKT) | How the demo uses it |
|---|---|---|---|---|
| DeepSeek API, `deepseek-flash` (DeepSeek-V4.1-Flash) | Per 1M tokens, off-peak: input **US$0.003** (cache hit) / **US$0.15** (cache miss), output **US$0.60**. Peak is double. Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday; weekends are off-peak all day | [api-docs.deepseek.com · Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) · [`deepseek-pricing.png`](evidence/deepseek-pricing.png) | 04:48:32 | Each agent run logs `AGENT_FINISHED` with elapsed time, LLM calls and token counts ([`src/server/session.ts`](../src/server/session.ts)), so the cost of a run is tokens × the rate above, not an estimate. |

## Not observed, so not used

- **Tavily** (finding product pages) and **SerpAPI** (reference prices): their prices were not captured, so the demo makes no claim about their cost.
- **Shipping**: Shopify product data has no shipping fee. Quotes count shipping as HK$0, and the store's checkout page has the final amount.
- **Clubpoints as cash**: the 5 points = HK$1 ratio is Citi's stated basis for The Club redemptions. It is not cash back, and the demo never lets projected points raise a spending limit.
