/**
 * 规则表 —— 规则是「数据」，不是散落在代码里的 if。
 * 这样日志能写出规则编号，路演能指着它讲，测试能逐条覆盖。
 *
 * 见 docs/rules.md 第 3 节。
 */

import {
  RULE,
  type Channel,
  type EvalContext,
  type Fuse,
  type RuleHit,
  type RuleId,
} from "./types.ts";

export interface RuleDef {
  id: RuleId;
  name: string;
  fuse: Fuse;
  /** 命中时要求的通道 */
  channel: Channel;
  why: string;
  check: (ctx: EvalContext) => RuleHit | null;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function hkd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}HK$${Math.abs(n).toLocaleString("en-HK")}`;
}

/** 取某类别的策略；没配就取 default；再没有就 ask_once */
export function categoryPolicy(ctx: EvalContext): Channel | "blocked" {
  const p = ctx.mandate.category_policy[ctx.quote.category];
  if (p !== undefined) return p;
  return ctx.mandate.category_policy["default"] ?? "ask_once";
}

/** 用户在这个类别上的历史 */
export function statFor(ctx: EvalContext) {
  return ctx.history.category_stats[ctx.quote.category];
}

export function spentLast7d(ctx: EvalContext): number {
  return ctx.history.purchases_last_7d.reduce((sum, p) => sum + p.total_hkd, 0);
}

// ---------------------------------------------------------------------------
// 规则定义
//
// 设计约定：
//  · decline 是「不在授权范围内」—— 硬边界。
//  · cooldown 是「在范围内，但要等等」—— 资金保险丝。
//  · ask_once 是「有异常，问一次」—— 判断保险丝。
//  · 用户在某个类别选了 instant，只压制「问一次」这一类（R-08/09/10），
//    绝不压制 R-00 ~ R-07 与 R-13。安全上限不能被类别偏好削弱。
// ---------------------------------------------------------------------------

export const RULES: RuleDef[] = [
  {
    id: RULE.MANDATE_EXPIRED,
    name: "授权已过期",
    fuse: "凭证",
    channel: "decline",
    why: "授权过期之后，代理没有任何可执行的权限。",
    check: (ctx) => {
      const expires = Date.parse(ctx.mandate.expires_at);
      if (!Number.isFinite(expires) || ctx.now.getTime() <= expires) return null;
      return {
        id: RULE.MANDATE_EXPIRED,
        note: `now=${ctx.now.toISOString()} > expires_at=${ctx.mandate.expires_at}`,
      };
    },
  },
  {
    id: RULE.MERCHANT_NOT_ALLOWED,
    name: "商户不在白名单",
    fuse: "凭证",
    channel: "decline",
    why: "代理只能在用户允许的商户花钱。",
    check: (ctx) => {
      const id = ctx.quote.merchant_id;
      const ok =
        ctx.mandate.merchant_allowlist.includes(id) ||
        ctx.mandate.trusted_merchants.includes(id);
      if (ok) return null;
      return {
        id: RULE.MERCHANT_NOT_ALLOWED,
        note: `merchant=${id} 不在 allowlist=${JSON.stringify(ctx.mandate.merchant_allowlist)} 也不在 trusted=${JSON.stringify(ctx.mandate.trusted_merchants)}`,
      };
    },
  },
  {
    id: RULE.HIGH_RISK_FPS_ID,
    name: "命中高风险名单",
    fuse: "资金",
    channel: "decline",
    why: "付款前用商户的转数快识别码对高风险名单。",
    check: (ctx) => {
      if (!ctx.riskList.fps_ids.includes(ctx.quote.fps_id)) return null;
      return {
        id: RULE.HIGH_RISK_FPS_ID,
        note: `fps_id=${ctx.quote.fps_id} 命中名单（source=${ctx.riskList.source}, captured_at=${ctx.riskList.captured_at}）`,
      };
    },
  },
  {
    id: RULE.CATEGORY_BLOCKED,
    name: "类别被禁",
    fuse: "判断",
    channel: "decline",
    why: "用户明确说过这个类别不买。",
    check: (ctx) => {
      if (categoryPolicy(ctx) !== "blocked") return null;
      return {
        id: RULE.CATEGORY_BLOCKED,
        note: `category_policy[${ctx.quote.category}]="blocked"`,
      };
    },
  },
  {
    id: RULE.PER_TXN_CAP_EXCEEDED,
    name: "单笔超硬上限",
    fuse: "凭证",
    channel: "decline",
    why: "结算总额（含运费、税、服务费）超过用户设的单笔上限。",
    check: (ctx) => {
      const total = ctx.quote.total_hkd;
      const cap = ctx.mandate.per_txn_cap_hkd;
      if (total <= cap) return null;
      return {
        id: RULE.PER_TXN_CAP_EXCEEDED,
        note: `total=${total} > per_txn_cap=${cap}（超 ${total - cap}）· unit_price=${ctx.quote.unit_price_hkd} shipping=${ctx.quote.shipping_hkd} tax=${ctx.quote.tax_hkd} service_fee=${ctx.quote.service_fee_hkd}`,
      };
    },
  },
  {
    id: RULE.ROLLING_WINDOW_EXCEEDED,
    name: "滚动 7 天超上限",
    fuse: "凭证",
    channel: "decline",
    why: "把这一单算进去，7 天累计会超过用户设的上限。",
    check: (ctx) => {
      const spent = spentLast7d(ctx);
      const cap = ctx.mandate.rolling_7d_cap_hkd;
      if (spent + ctx.quote.total_hkd <= cap) return null;
      return {
        id: RULE.ROLLING_WINDOW_EXCEEDED,
        note: `last7d=${spent} + total=${ctx.quote.total_hkd} > rolling_7d_cap=${cap}`,
      };
    },
  },
  {
    id: RULE.POCKET_WALLET_EXCEEDED,
    name: "超出零用钱包",
    fuse: "资金",
    channel: "cooldown",
    why: "代理平时只能动一个小额零用钱包。超出就要停下来。",
    check: (ctx) => {
      const total = ctx.quote.total_hkd;
      const wallet = ctx.mandate.pocket_wallet_hkd;
      if (total <= wallet) return null;
      return {
        id: RULE.POCKET_WALLET_EXCEEDED,
        note: `total=${total} > pocket_wallet=${wallet}`,
      };
    },
  },
  {
    id: RULE.FIRST_TIME_MERCHANT,
    name: "第一次光顾该商户",
    fuse: "资金",
    channel: "cooldown",
    why: "「每家商户只慢一次」—— 通过之后进信任名单，之后即时。",
    check: (ctx) => {
      if (ctx.mandate.trusted_merchants.includes(ctx.quote.merchant_id)) return null;
      return {
        id: RULE.FIRST_TIME_MERCHANT,
        note: `merchant=${ctx.quote.merchant_id} 不在 trusted=${JSON.stringify(ctx.mandate.trusted_merchants)}`,
      };
    },
  },
  {
    id: RULE.ABOVE_COOLDOWN_THRESHOLD,
    name: "超过冷静期门槛",
    fuse: "资金",
    channel: "cooldown",
    why: "金额超过用户设的门槛，冷静期内不发出凭证 —— 骗子最常用的「限时 10 分钟」因此失效。",
    check: (ctx) => {
      const total = ctx.quote.total_hkd;
      const threshold = ctx.mandate.cooldown_threshold_hkd;
      if (total <= threshold) return null;
      return {
        id: RULE.ABOVE_COOLDOWN_THRESHOLD,
        note: `total=${total} > cooldown_threshold=${threshold}`,
      };
    },
  },
  {
    id: RULE.NOT_REFUNDABLE,
    name: "不可退",
    fuse: "判断",
    channel: "ask_once",
    why: "不可退是异常特征之一。",
    check: (ctx) => {
      if (categoryPolicy(ctx) === "instant") return null; // 用户说了这个类别不用问
      if (ctx.quote.refundable !== false) return null;
      return { id: RULE.NOT_REFUNDABLE, note: "refundable=false" };
    },
  },
  {
    id: RULE.PRICE_ANOMALY,
    name: "价格异常",
    fuse: "判断",
    channel: "ask_once",
    why: "远高于用户平时在这个类别的中位数。",
    check: (ctx) => {
      if (categoryPolicy(ctx) === "instant") return null;
      const stat = statFor(ctx);
      if (!stat || stat.count < 3) return null;
      const limit = 3 * stat.median_hkd;
      if (ctx.quote.total_hkd <= limit) return null;
      return {
        id: RULE.PRICE_ANOMALY,
        note: `total=${ctx.quote.total_hkd} > 3 × median=${stat.median_hkd}（样本 ${stat.count} 单）`,
      };
    },
  },
  {
    id: RULE.NEW_CATEGORY,
    name: "新类别",
    fuse: "判断",
    channel: "ask_once",
    why: "用户以前没买过这个类别。",
    check: (ctx) => {
      if (categoryPolicy(ctx) === "instant") return null;
      const stat = statFor(ctx);
      if (stat && stat.count > 0) return null;
      return {
        id: RULE.NEW_CATEGORY,
        note: `category_stats[${ctx.quote.category}] 不存在或 count=0`,
      };
    },
  },
  {
    id: RULE.INTERRUPT_BUDGET_EXHAUSTED,
    name: "打扰额度用尽",
    fuse: "判断",
    channel: "ask_once", // 注意：这是一条「降级」规则，见 evaluate.ts
    why: "每人每周只有有限次打扰额度。代理必须把打扰花在最值得问的地方 —— 额度用尽时，把「问你一次」降级成「进冷静期」。",
    check: (ctx) => {
      const used = ctx.mandate.interrupts_used_this_week;
      const budget = ctx.mandate.weekly_interrupt_budget;
      if (used < budget) return null;
      return {
        id: RULE.INTERRUPT_BUDGET_EXHAUSTED,
        note: `interrupts_used=${used} >= budget=${budget}`,
      };
    },
  },
];

/** 只在「报价 → 通道」阶段评估的规则（R-12 / R-14 / R-15 在别的阶段） */
export const QUOTE_STAGE_RULES: ReadonlySet<RuleId> = new Set(
  RULES.map((r) => r.id),
);

const BY_ID: ReadonlyMap<RuleId, RuleDef> = new Map(RULES.map((r) => [r.id, r]));

export function ruleById(id: RuleId): RuleDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`未知规则：${id}`);
  return def;
}
