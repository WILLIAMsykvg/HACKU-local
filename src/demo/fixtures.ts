/**
 * 演示与测试共用的夹具。
 *
 * 全部数字都是「演示用」的假设值，不是真实费率。
 * 真实费率必须由队伍自己截图并打时间戳（见 docs/rules.md 待决清单）。
 */

import type { Mandate, Quote, RiskList, UserHistory } from "../engine/types.ts";

/** 固定住「现在」，结果才可复现 */
export const NOW = new Date("2026-10-02T17:40:00+08:00");

export const BASE_MANDATE: Mandate = {
  mandate_id: "mnd_001",
  user_id: "u_yeung",
  currency: "HKD",

  pocket_wallet_hkd: 500,
  cooldown_threshold_hkd: 300,
  per_txn_cap_hkd: 800,
  rolling_7d_cap_hkd: 2000,

  category_policy: {
    food: "instant",
    coffee: "instant",
    electronics: "cooldown",
    default: "ask_once",
  },

  merchant_allowlist: ["m_brew", "m_tech", "m_book"],
  trusted_merchants: ["m_brew"],

  weekly_interrupt_budget: 3,
  interrupts_used_this_week: 0,

  expires_at: "2026-10-04T13:00:00+08:00",
};

export const BASE_HISTORY: UserHistory = {
  user_id: "u_yeung",
  category_stats: {
    food: { count: 42, median_hkd: 85 },
    coffee: { count: 18, median_hkd: 42 },
    // electronics 故意不在这里 —— 它是「新类别」
  },
  purchases_last_7d: [
    { at: "2026-10-01T12:03:00+08:00", total_hkd: 120 },
    { at: "2026-10-02T09:15:00+08:00", total_hkd: 88 },
  ],
  last_approval_latency_ms: 2400,
};

export const BASE_RISK_LIST: RiskList = {
  fps_ids: ["9998887", "1651234"],
  source: "演示用本地名单（正式版接 Scameter 同类数据）",
  captured_at: "2026-10-02T17:30:00+08:00",
};

export function makeMandate(o: Partial<Mandate> = {}): Mandate {
  return { ...BASE_MANDATE, ...o };
}

export function makeHistory(o: Partial<UserHistory> = {}): UserHistory {
  return { ...BASE_HISTORY, ...o };
}

export function makeRiskList(o: Partial<RiskList> = {}): RiskList {
  return { ...BASE_RISK_LIST, ...o };
}

/**
 * 造一份商户报价。
 * total_hkd 默认由「单价 × 数量 + 运费 + 税 + 服务费」算出来 ——
 * 这样夹具本身不会出现「看起来合理但其实对不上」的数字。
 */
export function makeQuote(o: Partial<Quote> = {}): Quote {
  const item = { title: "House Blend 250g", sku: "COF-250", qty: 1, ...(o.item ?? {}) };
  const unit = o.unit_price_hkd ?? 199;
  const shipping = o.shipping_hkd ?? 0;
  const tax = o.tax_hkd ?? 0;
  const fee = o.service_fee_hkd ?? 0;
  const computed = unit * item.qty + shipping + tax + fee;

  return {
    quote_id: o.quote_id ?? "q_0001",
    merchant_id: o.merchant_id ?? "m_brew",
    merchant_name: o.merchant_name ?? "Brew & Co",
    fps_id: o.fps_id ?? "1651000",
    category: o.category ?? "coffee",
    item,
    unit_price_hkd: unit,
    shipping_hkd: shipping,
    tax_hkd: tax,
    service_fee_hkd: fee,
    total_hkd: o.total_hkd ?? computed,
    refundable: o.refundable ?? true,
    quote_captured_at: o.quote_captured_at ?? "2026-10-02T17:39:00+08:00",
    terms_url: o.terms_url ?? "https://example.invalid/terms",
    terms_snapshot_sha256: o.terms_snapshot_sha256 ?? "0".repeat(64),
  };
}
