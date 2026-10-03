/**
 * 发一次性凭证并结算。
 *
 * 有 STRIPE_SECRET_KEY（sk_test_ 开头）时，用 Stripe 测试模式真的创建并确认一次 PaymentIntent，
 * 金额与凭证一致，币种 HKD，不扣真钱。没有 key 或调用失败时退回模拟结算，并标明「模拟」。
 */

import { randomUUID } from "node:crypto";

import type { Credential, Quote } from "../engine/types.ts";
import type { PaymentCard } from "./cards.ts";

export const CREDENTIAL_TTL_MS = 10 * 60_000;

export function issueCredential(quote: Quote, now: Date): Credential {
  return {
    credential_id: `cred_${randomUUID().slice(0, 8)}`,
    single_use: true,
    merchant_id: quote.merchant_id,
    amount_hkd: quote.total_hkd,
    item_sku: quote.item.sku,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + CREDENTIAL_TTL_MS).toISOString(),
  };
}

export interface Settlement {
  mode: "stripe_test" | "simulated";
  id: string;
  status: string;
  note: string;
}

/** Stripe 官方提供的测试付款方式 ID */
const TEST_PAYMENT_METHOD: Record<PaymentCard["network"], string | null> = {
  mastercard: "pm_card_mastercard",
  unionpay: "pm_card_unionpay",
  fps: null,
};

export async function settle(cred: Credential, card: PaymentCard, stripeKey: string | undefined): Promise<Settlement> {
  const pm = TEST_PAYMENT_METHOD[card.network];
  if (!stripeKey || !stripeKey.startsWith("sk_test_") || !pm) {
    return {
      mode: "simulated",
      id: `sim_${cred.credential_id}`,
      status: "succeeded",
      note: !pm ? "转数快在演示里用模拟结算。" : "没有配置 Stripe 测试密钥，使用模拟结算。",
    };
  }

  const body = new URLSearchParams({
    amount: String(Math.round(cred.amount_hkd * 100)),
    currency: "hkd",
    payment_method: pm,
    confirm: "true",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
    description: `HacKU demo · ${cred.merchant_id} · ${cred.item_sku}`,
    "metadata[credential_id]": cred.credential_id,
    "metadata[merchant_id]": cred.merchant_id,
  });

  try {
    const res = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": cred.credential_id,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { id?: string; status?: string; error?: { message?: string } };
    if (!res.ok || !data.id) {
      return {
        mode: "simulated",
        id: `sim_${cred.credential_id}`,
        status: "succeeded",
        note: `Stripe 测试模式调用失败（${data.error?.message ?? res.status}），改用模拟结算。`,
      };
    }
    return {
      mode: "stripe_test",
      id: data.id,
      status: data.status ?? "unknown",
      note: `Stripe 测试模式：用 ${card.label} 的测试付款方式结算，不涉及真钱。`,
    };
  } catch (e) {
    return {
      mode: "simulated",
      id: `sim_${cred.credential_id}`,
      status: "succeeded",
      note: `Stripe 连不上（${(e as Error).message}），改用模拟结算。`,
    };
  }
}
