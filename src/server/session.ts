/**
 * 一个访客一套演示状态：授权书、强认证时间、设备钥匙、订单、日志。全部在内存里。
 *
 * 这里同时扮演三方：银行（发强认证结论、做验证方）、商户（核对价格库存、购买习惯）、
 * 以及代理所在的服务器。定位结论不在这里签 —— 它在浏览器里用设备自己的钥匙签。
 */

import { createHash, randomUUID } from "node:crypto";

import { runAgent, type AgentEvent } from "../agent/harness.ts";
import type { ShipToLabel } from "../agent/tools.ts";
import { evaluateWithAttestation, type AttestedDecision } from "../attest/decide.ts";
import { issueClaim } from "../attest/issuers.ts";
import { orderHash } from "../attest/orderHash.ts";
import { strengthTier } from "../attest/score.ts";
import { generateIssuerKey } from "../attest/sign.ts";
import type { Bundle, SignedClaim, TrustedIssuers } from "../attest/types.ts";
import { canIssueCredential, evaluateConsent, validateCredential } from "../engine/evaluate.ts";
import type {
  ConsentDecision,
  Credential,
  EvalContext,
  Mandate,
  Quote,
  RiskList,
  UserHistory,
} from "../engine/types.ts";
import { appendEntry, verifyChain, type Actor, type LogEntry } from "../log/chain.ts";
import { chooseCard, loadCards, type CardChoice } from "../pay/cards.ts";
import { issueCredential, settle, type Settlement } from "../pay/settle.ts";
import type { Comparison } from "../shop/compare.ts";
import type { ReferenceResult } from "../shop/reference.ts";
import { t } from "../i18n.ts";
import { fetchListing, type Listing } from "../shop/shopify.ts";
import { CATEGORY_TEXT, STORES, storeById } from "../shop/stores.ts";

export const ENGINE_OPTIONS = { cooldownDurationMs: 30_000 };

/** 银行和商户的签名钥匙：每次启动现生成，公钥在 /api/keys 公开 */
export const SERVER_KEYS = {
  bank: generateIssuerKey(),
  merchant: generateIssuerKey(),
};

/** 预设收货地。坐标只给浏览器做本地比对，服务器不收用户坐标 */
export function shipToPlaces(): Record<ShipToLabel, { label: string; lat: number; lng: number }> {
  return {
    dorm: { label: t("港大宿舍", "HKU dorm"), lat: 22.2830, lng: 114.1371 },
    home: { label: t("家（沙田）", "Home (Sha Tin)"), lat: 22.3817, lng: 114.1880 },
    other_city: { label: t("深圳仓", "Shenzhen warehouse"), lat: 22.5431, lng: 114.0579 },
  };
}

const RISK_LIST: RiskList = {
  fps_ids: ["9998887", "1651234"],
  source: "演示用本地名单（正式版接 Scameter 同类数据）",
  captured_at: "2026-10-03T23:00:00+08:00",
};

/** 商户那边的演示购买记录：只用来跑「是否符合习惯」这条规则，不会离开商户 */
const MERCHANT_HISTORY: Record<string, { count: number; median_hkd: number }> = {
  m_gp_hk: { count: 3, median_hkd: 160 },
};

export type OrderStatus =
  | "awaiting_proof"
  | "awaiting_consent"
  | "cooling"
  | "paid"
  | "declined";

export interface Order {
  id: string;
  created_at: string;
  listing: Listing;
  qty: number;
  cart_url: string;
  ship_to: ShipToLabel;
  agent_reason: string;
  comparison: Comparison | null;
  references: ReferenceResult | null;
  quote: Quote;
  order_hash: string;
  server_claims: SignedClaim[] | null;
  bundle: Bundle | null;
  decision: AttestedDecision | null;
  consent: ConsentDecision | null;
  credential: Credential | null;
  card: CardChoice | null;
  settlement: Settlement | null;
  status: OrderStatus;
  /** 签完结论之后收货地被改过（演示代理被劫持） */
  ship_to_tampered: boolean;
}

type Listener = (event: string, data: unknown) => void;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class Session {
  readonly id = randomUUID();
  lastSeen = Date.now();
  clockOffsetMs = 0;
  mandate: Mandate;
  history: UserHistory;
  authTime: Date | null = null;
  deviceKey: string | null = null;
  log: LogEntry[] = [];
  orders = new Map<string, Order>();
  currentOrderId: string | null = null;
  agentBusy = false;
  llmRuns = 0;
  private listeners = new Set<Listener>();

  constructor() {
    const now = this.now();
    this.mandate = {
      mandate_id: `mnd_${this.id.slice(0, 6)}`,
      user_id: "u_demo",
      currency: "HKD",
      pocket_wallet_hkd: 500,
      cooldown_threshold_hkd: 400,
      per_txn_cap_hkd: 800,
      rolling_7d_cap_hkd: 2000,
      category_policy: { electronics_accessory: "instant", gift: "instant", default: "ask_once" },
      merchant_allowlist: STORES.map((s) => s.merchant_id),
      trusted_merchants: ["m_gp_hk"],
      weekly_interrupt_budget: 3,
      interrupts_used_this_week: 0,
      expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    };
    this.history = {
      user_id: "u_demo",
      category_stats: { electronics_accessory: { count: 4, median_hkd: 180 }, gift: { count: 2, median_hkd: 200 } },
      purchases_last_7d: [],
      last_approval_latency_ms: 2400,
    };
    this.record("user", "MANDATE_SET", {
      per_txn_cap_hkd: this.mandate.per_txn_cap_hkd,
      rolling_7d_cap_hkd: this.mandate.rolling_7d_cap_hkd,
      pocket_wallet_hkd: this.mandate.pocket_wallet_hkd,
      cooldown_threshold_hkd: this.mandate.cooldown_threshold_hkd,
      merchant_allowlist: this.mandate.merchant_allowlist,
      trusted_merchants: this.mandate.trusted_merchants,
      expires_at: this.mandate.expires_at,
      agent_tools: ["search_products", "compare_products", "get_product", "add_to_cart", "submit_payment_plan"],
    });
  }

  now(): Date {
    return new Date(Date.now() + this.clockOffsetMs);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: string, data: unknown): void {
    for (const fn of this.listeners) fn(event, data);
  }

  record(actor: Actor, event: string, fields: Record<string, unknown> = {}): LogEntry {
    const entry = appendEntry(this.log, { at: this.now().toISOString(), actor, event, ...fields });
    this.log.push(entry);
    this.emit("log", entry);
    return entry;
  }

  trusted(): TrustedIssuers {
    return {
      location: this.deviceKey ? [this.deviceKey] : [],
      bank: [SERVER_KEYS.bank.publicKey],
      merchant: [SERVER_KEYS.merchant.publicKey],
    };
  }

  // -------------------------------------------------------------------------
  // 用户
  // -------------------------------------------------------------------------

  strongAuth(deviceKey: string | null): void {
    this.authTime = this.now();
    if (deviceKey) this.deviceKey = deviceKey;
    this.record("bank", "STRONG_AUTH", {
      method: "simulated_biometric",
      auth_time: this.authTime.toISOString(),
      device_key_registered: Boolean(deviceKey),
    });
    this.emit("state", this.publicState());
  }

  setClockOffset(hours: number): void {
    this.clockOffsetMs = Math.round(hours * 3600_000);
    this.record("user", "DEMO_CLOCK_SET", { offset_hours: hours });
    this.emit("state", this.publicState());
  }

  revoke(): void {
    this.mandate = { ...this.mandate, expires_at: this.now().toISOString() };
    this.record("user", "MANDATE_REVOKED", { expires_at: this.mandate.expires_at });
    this.emit("state", this.publicState());
  }

  restoreMandate(): void {
    this.mandate = { ...this.mandate, expires_at: new Date(this.now().getTime() + 24 * 3600_000).toISOString() };
    this.record("user", "MANDATE_RESTORED", { expires_at: this.mandate.expires_at });
    this.emit("state", this.publicState());
  }

  // -------------------------------------------------------------------------
  // 代理
  // -------------------------------------------------------------------------

  async runAgent(o: {
    mode: "scripted" | "llm";
    prompt: string;
    injection: boolean;
    deepseekKey?: string;
    tavilyKey?: string;
    serpKey?: string;
  }): Promise<Order | null> {
    if (this.agentBusy) throw new Error(t("代理正在工作，请等它做完", "The agent is still working; wait for it to finish"));
    this.agentBusy = true;
    if (o.mode === "llm") this.llmRuns++;
    this.record("agent", "AGENT_STARTED", { mode: o.mode, prompt: o.prompt.slice(0, 200), injection: o.injection });
    const startedAt = Date.now();
    try {
      const out = await runAgent({
        mode: o.mode,
        prompt: o.prompt,
        injection: o.injection,
        deepseekKey: o.deepseekKey,
        tavilyKey: o.tavilyKey,
        serpKey: o.serpKey,
        trustedMerchants: this.mandate.trusted_merchants,
        emit: (e: AgentEvent) => {
          this.emit("agent", e);
          if (e.kind === "step") {
            this.record("agent", "AGENT_TOOL_CALL", { tool: e.tool, ok: e.ok });
            if (e.tool === "compare_products" && e.ok) {
              const r = e.result as { pick: { title: string; total_hkd: number } | null; shortlist: unknown[]; rejected: unknown[]; coverage: { merchant_id: string; status: string }[]; references: { via: string; offers: unknown[] } };
              this.record("agent", "PRICE_COMPARED", {
                pick: r.pick ? `${r.pick.title} HK$${r.pick.total_hkd}` : null,
                shortlisted: r.shortlist.length,
                rejected: r.rejected.length,
                coverage: r.coverage.map((c) => `${c.merchant_id}:${c.status}`),
                reference_via: r.references.via,
                reference_offers: r.references.offers.length,
              });
            }
          }
        },
      });
      this.record("agent", "AGENT_FINISHED", {
        mode: o.mode,
        elapsed_ms: Date.now() - startedAt,
        tool_calls: out.tool_calls,
        llm_calls: out.usage?.llm_calls ?? 0,
        prompt_tokens: out.usage?.prompt_tokens ?? 0,
        completion_tokens: out.usage?.completion_tokens ?? 0,
      });
      if (!out.ok || !out.cart || !out.ship_to_label) {
        this.record("agent", "AGENT_STOPPED", { reason: out.reason });
        return null;
      }
      return this.createOrder(out.cart.listing, out.cart.qty, out.cart.cart_url, out.ship_to_label, out.reason, out.comparison, out.references);
    } finally {
      this.agentBusy = false;
    }
  }

  private createOrder(
    listing: Listing,
    qty: number,
    cartUrl: string,
    shipTo: ShipToLabel,
    reason: string,
    comparison: Comparison | null,
    references: ReferenceResult | null,
  ): Order {
    const id = `ord_${randomUUID().slice(0, 8)}`;
    const now = this.now();
    const quote: Quote = {
      quote_id: `q_${id.slice(4)}`,
      merchant_id: listing.merchant_id,
      merchant_name: listing.merchant_name,
      fps_id: "n/a",
      category: storeById(listing.merchant_id)?.category ?? "other",
      item: { title: listing.title, sku: listing.variant_id, qty },
      unit_price_hkd: listing.price_hkd,
      shipping_hkd: 0,
      tax_hkd: 0,
      service_fee_hkd: 0,
      total_hkd: Math.round(listing.price_hkd * qty * 100) / 100,
      refundable: true,
      quote_captured_at: listing.fetched_at,
      terms_url: listing.url,
      terms_snapshot_sha256: sha256(JSON.stringify(listing)),
    };
    const order: Order = {
      id,
      created_at: now.toISOString(),
      listing,
      qty,
      cart_url: cartUrl,
      ship_to: shipTo,
      agent_reason: reason,
      comparison,
      references,
      quote,
      order_hash: orderHash(quote, shipTo),
      server_claims: null,
      bundle: null,
      decision: null,
      consent: null,
      credential: null,
      card: null,
      settlement: null,
      status: "awaiting_proof",
      ship_to_tampered: false,
    };
    this.orders.set(id, order);
    this.currentOrderId = id;
    this.record("agent", "PAYMENT_PLAN_SUBMITTED", {
      order_id: id,
      order_hash: order.order_hash,
      merchant_id: quote.merchant_id,
      item_sku: quote.item.sku,
      qty,
      total_hkd: quote.total_hkd,
      ship_to: shipTo,
      shipping_note: "运费以结账页为准，报价按 0 计",
    });
    this.emit("order", this.publicOrder(order));
    return order;
  }

  // -------------------------------------------------------------------------
  // 发证方（银行、商户）
  // -------------------------------------------------------------------------

  async issueServerClaims(orderId: string): Promise<{ claims: SignedClaim[]; now: string }> {
    const order = this.mustOrder(orderId);
    const now = this.now();
    const hash = order.order_hash;

    const bankAnswer = this.authTime !== null && strengthTier(this.authTime.toISOString(), now) !== null;
    const bank = issueClaim(SERVER_KEYS.bank, {
      orderHash: hash,
      question: "holder_recently_authenticated",
      answer: bankAnswer,
      now,
      authTime: this.authTime ?? undefined,
    });

    const h = MERCHANT_HISTORY[order.quote.merchant_id];
    const habitOk = h !== undefined && h.count >= 1 && order.quote.total_hkd <= 2 * h.median_hkd;
    const habit = issueClaim(SERVER_KEYS.merchant, {
      orderHash: hash,
      question: "consistent_with_history",
      answer: habitOk,
      now,
    });

    let listingOk = false;
    let listingNote = "";
    try {
      const live = await fetchListing(order.listing.url, order.listing.variant_id, { fresh: true });
      listingOk = live.available && live.price_hkd === order.quote.unit_price_hkd && live.variant_id === order.quote.item.sku;
      listingNote = `live price=${live.price_hkd} available=${live.available}`;
    } catch (e) {
      listingNote = t(`核对失败：${(e as Error).message}`, `check failed: ${(e as Error).message}`);
    }
    const listing = issueClaim(SERVER_KEYS.merchant, {
      orderHash: hash,
      question: "quote_matches_listing",
      answer: listingOk,
      now,
    });

    order.server_claims = [bank, habit, listing];
    this.record("bank", "CLAIM_ISSUED", { order_id: orderId, question: "holder_recently_authenticated", answer: bankAnswer });
    this.record("merchant", "CLAIM_ISSUED", { order_id: orderId, question: "consistent_with_history", answer: habitOk });
    this.record("merchant", "CLAIM_ISSUED", { order_id: orderId, question: "quote_matches_listing", answer: listingOk, note: listingNote });
    return { claims: order.server_claims, now: now.toISOString() };
  }

  /** 演示：结论签完之后，代理被劫持把收货地改了 */
  tamperShipTo(orderId: string): Order {
    const order = this.mustOrder(orderId);
    order.ship_to = "other_city";
    order.ship_to_tampered = true;
    this.record("agent", "SHIP_TO_CHANGED_AFTER_SIGNING", { order_id: orderId, ship_to: "other_city" });
    this.emit("order", this.publicOrder(order));
    return order;
  }

  // -------------------------------------------------------------------------
  // 验证方（银行）
  // -------------------------------------------------------------------------

  private evalContext(order: Order): EvalContext {
    return { mandate: this.mandate, quote: order.quote, history: this.history, riskList: RISK_LIST, now: this.now() };
  }

  async submitBundle(orderId: string, bundle: Bundle, stripeKey?: string): Promise<Order> {
    const order = this.mustOrder(orderId);
    if (order.status === "paid") throw new Error(t("这一单已经付过了", "This order has already been paid"));
    order.bundle = bundle;
    const d = evaluateWithAttestation(
      this.evalContext(order),
      { bundle, shipToLabel: order.ship_to, trusted: this.trusted() },
      ENGINE_OPTIONS,
    );
    order.decision = d;

    const att = d.attestation;
    this.record("bank", "ATTESTATION_CHECKED", {
      order_id: orderId,
      ok: att?.ok ?? null,
      fail_code: att && !att.ok ? att.code : null,
      stated_score: bundle.stated_score,
      recomputed_score: att && att.ok ? att.result.score : null,
      tier: att && att.ok ? att.result.tier : null,
      claims: att && att.ok
        ? att.result.statuses.map((s) => ({ role: s.role, question: s.question_id, state: s.state, answer: s.answer }))
        : bundle.claims.map((c) => ({ role: c.claim.role, question: c.claim.question_id })),
    });
    this.record("engine", "DECISION", {
      order_id: orderId,
      engine_channel: d.engineChannel,
      final_channel: d.channel,
      triggered_rules: d.triggeredRules,
      reason: d.userFacingReason,
    });

    if (d.channel === "decline") {
      order.status = "declined";
    } else if (d.channel === "instant") {
      await this.pay(order, null, stripeKey);
    } else {
      if (d.channel === "ask_once") {
        this.mandate = { ...this.mandate, interrupts_used_this_week: this.mandate.interrupts_used_this_week + 1 };
      }
      order.status = d.channel === "cooldown" ? "cooling" : "awaiting_consent";
    }
    this.emit("order", this.publicOrder(order));
    return order;
  }

  async consent(orderId: string, latencyMs: number, stripeKey?: string): Promise<{ order: Order; message: string }> {
    const order = this.mustOrder(orderId);
    if (!order.decision) throw new Error(t("这一单还没有判定", "This order has not been decided yet"));
    if (order.status === "paid" || order.status === "declined") {
      return { order, message: t("这一单已经结束了。", "This order is already closed.") };
    }
    const consent = evaluateConsent(latencyMs);
    order.consent = consent;
    this.record("user", "CONSENT", { order_id: orderId, accepted: consent.accepted, latency_ms: latencyMs });
    const check = canIssueCredential({ decision: order.decision, consent, now: this.now() });
    if (!check.ok) {
      this.emit("order", this.publicOrder(order));
      return { order, message: check.userFacingReason };
    }
    await this.pay(order, consent, stripeKey);
    this.emit("order", this.publicOrder(order));
    return { order, message: t("已发出一次性凭证并结算。", "One-time credential issued and settled.") };
  }

  private async pay(order: Order, consent: ConsentDecision | null, stripeKey?: string): Promise<void> {
    const now = this.now();
    const check = canIssueCredential({ decision: order.decision!, consent, now });
    if (!check.ok) throw new Error(check.userFacingReason);

    const cred = issueCredential(order.quote, now);
    const v = validateCredential(
      { quote_id: order.quote.quote_id, merchant_id: order.quote.merchant_id, amount_hkd: order.quote.total_hkd, item_sku: order.quote.item.sku },
      cred,
    );
    if (!v.ok) throw new Error(v.userFacingReason);
    order.credential = cred;
    this.record("bank", "CREDENTIAL_ISSUED", {
      order_id: order.id,
      credential_id: cred.credential_id,
      merchant_id: cred.merchant_id,
      amount_hkd: cred.amount_hkd,
      single_use: cred.single_use,
      expires_at: cred.expires_at,
    });

    const firstTime = !this.mandate.trusted_merchants.includes(order.quote.merchant_id);
    const choice = chooseCard(loadCards(), { firstTimeMerchant: firstTime });
    order.card = choice;
    const s = await settle(cred, choice.card, stripeKey);
    order.settlement = s;
    order.status = "paid";
    this.record("bank", "PAYMENT_SETTLED", {
      order_id: order.id,
      credential_id: cred.credential_id,
      card: choice.card.label,
      card_reason: choice.reason,
      mode: s.mode,
      settlement_id: s.id,
      status: s.status,
    });

    this.history = {
      ...this.history,
      purchases_last_7d: [...this.history.purchases_last_7d, { at: now.toISOString(), total_hkd: order.quote.total_hkd }],
    };
    if (firstTime) {
      this.mandate = { ...this.mandate, trusted_merchants: [...this.mandate.trusted_merchants, order.quote.merchant_id] };
      this.record("engine", "MERCHANT_TRUSTED", { merchant_id: order.quote.merchant_id, note: "每家商户只慢一次" });
    }
  }

  // -------------------------------------------------------------------------
  // 给前端看的
  // -------------------------------------------------------------------------

  mustOrder(id: string): Order {
    const o = this.orders.get(id);
    if (!o) throw new Error(t(`没有这一单：${id}`, `No such order: ${id}`));
    return o;
  }

  publicOrder(o: Order) {
    return {
      id: o.id,
      created_at: o.created_at,
      status: o.status,
      listing: o.listing,
      qty: o.qty,
      cart_url: o.cart_url,
      ship_to: o.ship_to,
      ship_to_place: shipToPlaces()[o.ship_to],
      ship_to_tampered: o.ship_to_tampered,
      agent_reason: o.agent_reason,
      comparison: o.comparison,
      references: o.references,
      category_text: CATEGORY_TEXT[o.quote.category as keyof typeof CATEGORY_TEXT] ?? o.quote.category,
      quote: o.quote,
      order_hash: o.order_hash,
      bundle: o.bundle,
      decision: o.decision,
      consent: o.consent,
      credential: o.credential,
      card: o.card,
      settlement: o.settlement,
    };
  }

  publicState() {
    const now = this.now();
    return {
      now: now.toISOString(),
      clock_offset_hours: this.clockOffsetMs / 3600_000,
      mandate: this.mandate,
      auth_time: this.authTime?.toISOString() ?? null,
      tier: this.authTime ? strengthTier(this.authTime.toISOString(), now) : null,
      device_key: this.deviceKey,
      keys: { bank: SERVER_KEYS.bank.publicKey, merchant: SERVER_KEYS.merchant.publicKey, location: this.deviceKey },
      ship_to: shipToPlaces(),
      stores: STORES.map((s) => ({ merchant_id: s.merchant_id, name: s.name, domain: s.domain })),
      current_order: this.currentOrderId ? this.publicOrder(this.mustOrder(this.currentOrderId)) : null,
      log: this.log,
      chain: verifyChain(this.log),
      agent_busy: this.agentBusy,
    };
  }
}
