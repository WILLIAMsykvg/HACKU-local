/**
 * 规则引擎 · 类型定义
 *
 * 三条不变量（见 docs/rules.md 第 9 节）：
 *  1. 引擎不调用模型。
 *  2. 引擎不读时间以外的外部状态 —— 所有输入都通过参数传入（now 也是参数）。
 *  3. 每一次判定都必须产出一条日志。
 */

/** 判定通道。越靠后越严。 */
export type Channel = "instant" | "ask_once" | "cooldown" | "decline";

export const SEVERITY: Record<Channel, number> = {
  instant: 0,
  ask_once: 1,
  cooldown: 2,
  decline: 3,
};

/** 规则 ID。用 const 对象而不是 enum —— Node 的类型擦除不支持 enum。 */
export const RULE = {
  MANDATE_EXPIRED: "R-00",
  MERCHANT_NOT_ALLOWED: "R-01",
  HIGH_RISK_FPS_ID: "R-02",
  CATEGORY_BLOCKED: "R-03",
  PER_TXN_CAP_EXCEEDED: "R-04",
  POCKET_WALLET_EXCEEDED: "R-05",
  FIRST_TIME_MERCHANT: "R-06",
  ABOVE_COOLDOWN_THRESHOLD: "R-07",
  NOT_REFUNDABLE: "R-08",
  PRICE_ANOMALY: "R-09",
  NEW_CATEGORY: "R-10",
  INTERRUPT_BUDGET_EXHAUSTED: "R-11",
  CONSENT_TOO_FAST: "R-12",
  ROLLING_WINDOW_EXCEEDED: "R-13",
  CREDENTIAL_MISMATCH: "R-14",
  COOLDOWN_NOT_ELAPSED: "R-15",
} as const;

export type RuleId = (typeof RULE)[keyof typeof RULE];

/** 三条保险丝 */
export type Fuse = "凭证" | "资金" | "判断" | "同意";

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export interface Mandate {
  mandate_id: string;
  user_id: string;
  currency: string;

  /** 零用钱包：代理平时只能动这么多，也是「最坏损失」的上限 */
  pocket_wallet_hkd: number;
  /** 超过这个数 → 冷静期 */
  cooldown_threshold_hkd: number;
  /** 硬上限：超过 = 不在授权范围内 */
  per_txn_cap_hkd: number;
  /** 滚动 7 天硬上限 */
  rolling_7d_cap_hkd: number;

  /** 用户按类别自己调快慢 */
  category_policy: Record<string, Channel | "blocked">;

  merchant_allowlist: string[];
  /** 「每家商户只慢一次」—— 在这里的商户可即时 */
  trusted_merchants: string[];

  /** 每人每周有限的打扰额度 */
  weekly_interrupt_budget: number;
  interrupts_used_this_week: number;

  expires_at: string;
}

export interface QuoteItem {
  title: string;
  sku: string;
  qty: number;
}

export interface Quote {
  quote_id: string;
  merchant_id: string;
  merchant_name: string;
  /** 转数快识别码，用于查高风险名单 */
  fps_id: string;
  category: string;

  item: QuoteItem;

  unit_price_hkd: number;
  shipping_hkd: number;
  tax_hkd: number;
  service_fee_hkd: number;
  /** ★ 引擎必须用这个重算，不能用 unit_price */
  total_hkd: number;

  refundable: boolean;

  quote_captured_at: string;
  terms_url: string;
  terms_snapshot_sha256: string;
}

export interface CategoryStat {
  count: number;
  median_hkd: number;
}

export interface PastPurchase {
  at: string;
  total_hkd: number;
}

export interface UserHistory {
  user_id: string;
  category_stats: Record<string, CategoryStat>;
  purchases_last_7d: PastPurchase[];
  /** 上一次点同意的反应时间 */
  last_approval_latency_ms: number;
}

/** 高风险转数快识别码名单（演示用本地名单，正式版接 Scameter 同类数据） */
export interface RiskList {
  fps_ids: string[];
  /** 名单来源与抓取时间 —— 用来防止「编造数据」 */
  source: string;
  captured_at: string;
}

export interface EvalContext {
  mandate: Mandate;
  quote: Quote;
  history: UserHistory;
  riskList: RiskList;
  now: Date;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

export interface RuleHit {
  id: RuleId;
  note: string;
}

export interface QuoteDecision {
  channel: Channel;
  /** 所有命中的规则（不只最严那条） */
  triggeredRules: RuleId[];
  primaryReasonRule: RuleId | null;
  /** 给用户看的那一句话 */
  userFacingReason: string;
  /** 每条命中规则的机器可读说明，写进日志 */
  logNotes: Record<string, string>;
  /** channel === "cooldown" 时才有 */
  cooldownUntil: string | null;
  /** 是否因为打扰额度用尽而从 ask_once 降级 */
  downgradedByBudget: boolean;
}

export interface ConsentDecision {
  /** 这次同意算不算数 */
  accepted: boolean;
  rule: RuleId | null;
  userFacingReason: string;
  approvalLatencyMs: number;
}

/** 已批准的条款 —— 凭证必须与它逐字一致 */
export interface ApprovedTerms {
  quote_id: string;
  merchant_id: string;
  amount_hkd: number;
  item_sku: string;
}

export interface Credential {
  credential_id: string;
  /** 一次性 */
  single_use: boolean;
  /** 锁死一家商户 */
  merchant_id: string;
  /** 锁死一个金额 */
  amount_hkd: number;
  item_sku: string;
  issued_at: string;
  expires_at: string;
}

export interface CredentialCheck {
  ok: boolean;
  rule: RuleId | null;
  /** 哪几个字段对不上 */
  mismatches: string[];
  userFacingReason: string;
}
