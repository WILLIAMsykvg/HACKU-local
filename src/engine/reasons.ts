/**
 * 话术 —— 规则编号 → 用户看得懂的那句话。
 *
 * 设计原则（来自 docs/rules.md 与题目原文）：
 *  · 「决策规则要让用户看得懂」
 *  · 「真正异常时只显示那一个差别」
 *  · 所以：一条命中 → 完整句；两条以上 → 只讲最重要的两条，用「而且」连起来。
 */

import { hkd, statFor, spentLast7d } from "./rules.ts";
import { RULE, type EvalContext, type RuleHit, type RuleId } from "./types.ts";

/** 短句 —— 用于「和你过去几单不同：……，而且……」 */
export function shortClause(id: RuleId, ctx: EvalContext): string {
  const m = ctx.mandate;
  const q = ctx.quote;
  switch (id) {
    case RULE.MANDATE_EXPIRED:
      return `这次授权在你设的 ${m.expires_at} 已经过期`;
    case RULE.MERCHANT_NOT_ALLOWED:
      return `「${q.merchant_name}」不在你允许的名单里`;
    case RULE.HIGH_RISK_FPS_ID:
      return `「${q.merchant_name}」的转数快识别码在高风险名单上`;
    case RULE.CATEGORY_BLOCKED:
      return `你说过「${q.category}」这个类别不买`;
    case RULE.PER_TXN_CAP_EXCEEDED:
      return `结算要 ${hkd(q.total_hkd)}，超过你设的单笔上限 ${hkd(m.per_txn_cap_hkd)}`;
    case RULE.ROLLING_WINDOW_EXCEEDED:
      return `加上这单，你 7 天内会花到 ${hkd(spentLast7d(ctx) + q.total_hkd)}，超过上限 ${hkd(m.rolling_7d_cap_hkd)}`;
    case RULE.POCKET_WALLET_EXCEEDED:
      return `${hkd(q.total_hkd)} 超过你零用钱包里的 ${hkd(m.pocket_wallet_hkd)}`;
    case RULE.FIRST_TIME_MERCHANT:
      return `这是第一次在「${q.merchant_name}」买`;
    case RULE.ABOVE_COOLDOWN_THRESHOLD:
      return `${hkd(q.total_hkd)} 超过你设的 ${hkd(m.cooldown_threshold_hkd)} 门槛`;
    case RULE.NOT_REFUNDABLE:
      return "这次不可退";
    case RULE.PRICE_ANOMALY: {
      const stat = statFor(ctx);
      return `这次要 ${hkd(q.total_hkd)}，你平时这个类别大概花 ${hkd(stat?.median_hkd ?? 0)}`;
    }
    case RULE.NEW_CATEGORY:
      return `你以前没买过「${q.category}」这个类别`;
    case RULE.INTERRUPT_BUDGET_EXHAUSTED:
      return `本周已经问过你 ${m.interrupts_used_this_week} 次了，这周不再打扰你`;
    case RULE.CONSENT_TOO_FAST:
      return "你点得太快了";
    case RULE.CREDENTIAL_MISMATCH:
      return "凭证上的商户或金额，和你批准的不一样";
    case RULE.COOLDOWN_NOT_ELAPSED:
      return "冷静期还没结束";
    default:
      return "有一个条件不符合";
  }
}

/** 完整句 —— 只有一条命中时用 */
export function fullSentence(id: RuleId, ctx: EvalContext): string {
  const m = ctx.mandate;
  const q = ctx.quote;
  switch (id) {
    case RULE.PER_TXN_CAP_EXCEEDED:
      return (
        `结算总额 ${hkd(q.total_hkd)} 超过你设的单笔上限 ${hkd(m.per_txn_cap_hkd)}。` +
        `（商品 ${hkd(q.unit_price_hkd)} × ${q.item.qty} ＋ 运费 ${hkd(q.shipping_hkd)} ＋ 税 ${hkd(q.tax_hkd)} ＋ 服务费 ${hkd(q.service_fee_hkd)}）` +
        `超出 ${hkd(q.total_hkd - m.per_txn_cap_hkd)}，所以代理没有把这笔发出去。`
      );
    default:
      return `这次不能照常执行：${shortClause(id, ctx)}。`;
  }
}

export interface ReasonOptions {
  downgradedByBudget?: boolean;
  /** 冷静期还有多久（毫秒），用于 cooldown 通道 */
  cooldownMs?: number;
}

export function buildReason(
  ranked: RuleHit[],
  ctx: EvalContext,
  options: ReasonOptions = {},
): string {
  if (ranked.length === 0) {
    return "这次一切正常，直接执行。";
  }

  const primary = ranked[0]!;
  let text: string;

  if (ranked.length === 1) {
    text = fullSentence(primary.id, ctx);
  } else {
    const second = ranked[1]!;
    text =
      "和你过去几单不同：" +
      shortClause(primary.id, ctx) +
      "，而且" +
      stripLeadingThis(shortClause(second.id, ctx)) +
      "。";
  }

  if (options.downgradedByBudget) {
    text += ` 本该问你一次，但${shortClause(RULE.INTERRUPT_BUDGET_EXHAUSTED, ctx)} —— 所以改成进冷静期，不打扰你。`;
  }

  return text;
}

/** 把第二条的子句开头「这次」去掉，让「而且这次不可退」读起来自然 */
function stripLeadingThis(s: string): string {
  return s.startsWith("这次") ? s.slice(2) : s;
}
