/**
 * 判定器 —— 纯函数。不调用模型，不读外部状态，now 也是参数。
 *
 * 三个入口：
 *   evaluateQuote()        报价 → 通道          （R-00 ~ R-11, R-13）
 *   evaluateConsent()      用户同意 → 算不算数   （R-12）
 *   canIssueCredential()   能不能发凭证          （R-15）
 *   validateCredential()   凭证对不对            （R-14）
 */

import { t } from "../i18n.ts";
import { RULES, ruleById } from "./rules.ts";
import { buildReason } from "./reasons.ts";
import {
  RULE,
  SEVERITY,
  type ApprovedTerms,
  type Channel,
  type ConsentDecision,
  type Credential,
  type CredentialCheck,
  type EvalContext,
  type QuoteDecision,
  type RuleHit,
  type RuleId,
} from "./types.ts";

export interface EngineOptions {
  /** 冷静期时长（毫秒）。演示用 60 秒；正式版应按情形分级。 */
  cooldownDurationMs: number;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  cooldownDurationMs: 60_000,
};

/** 同意若快于这个时间，视为没看 */
export const MIN_CONSENT_LATENCY_MS = 1000;

// ---------------------------------------------------------------------------
// 入口 1：报价 → 通道
// ---------------------------------------------------------------------------

export function evaluateQuote(
  ctx: EvalContext,
  options: EngineOptions = DEFAULT_OPTIONS,
): QuoteDecision {
  // 1. 全部规则都跑一遍 —— 不是「命中第一条就停」
  const hits: RuleHit[] = [];
  for (const rule of RULES) {
    const hit = rule.check(ctx);
    if (hit) hits.push(hit);
  }

  const triggeredRules = hits.map((h) => h.id);

  const logNotes: Record<string, string> = {};
  for (const h of hits) logNotes[h.id] = h.note;

  // 2. 基础通道 = 最严的那一条
  let channel: Channel = "instant";
  for (const h of hits) {
    const def = ruleById(h.id);
    if (SEVERITY[def.channel] > SEVERITY[channel]) channel = def.channel;
  }

  // 3. R-11 降级：打扰额度用尽时，把 ask_once 降成 cooldown
  //    只有「本来就要问你」时才降级 —— R-11 单独命中不构成一次打扰请求
  const hasRealAsk = hits.some(
    (h) =>
      h.id !== RULE.INTERRUPT_BUDGET_EXHAUSTED &&
      ruleById(h.id).channel === "ask_once",
  );
  const budgetExhausted = hits.some(
    (h) => h.id === RULE.INTERRUPT_BUDGET_EXHAUSTED,
  );

  let downgradedByBudget = false;
  if (channel === "ask_once" && hasRealAsk && budgetExhausted) {
    channel = "cooldown";
    downgradedByBudget = true;
  }

  // 4. primary reason = 最严 + 编号最小的那条
  const ranked = rankHits(hits);
  const primaryReasonRule = ranked.length > 0 ? ranked[0]!.id : null;

  const cooldownUntil =
    channel === "cooldown"
      ? new Date(ctx.now.getTime() + options.cooldownDurationMs).toISOString()
      : null;

  return {
    channel,
    triggeredRules,
    primaryReasonRule,
    userFacingReason: buildReason(ranked, ctx, {
      downgradedByBudget,
      cooldownMs: options.cooldownDurationMs,
    }),
    logNotes,
    cooldownUntil,
    downgradedByBudget,
  };
}

/** 最严的在前；同严的按编号升序 */
export function rankHits(hits: RuleHit[]): RuleHit[] {
  return hits.slice().sort((a, b) => {
    const diff = SEVERITY[ruleById(b.id).channel] - SEVERITY[ruleById(a.id).channel];
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// 入口 2：用户同意 → 算不算数（R-12）
// ---------------------------------------------------------------------------

export function evaluateConsent(latencyMs: number): ConsentDecision {
  if (latencyMs < MIN_CONSENT_LATENCY_MS) {
    return {
      accepted: false,
      rule: RULE.CONSENT_TOO_FAST,
      approvalLatencyMs: latencyMs,
      userFacingReason: t(
        `你只用了 ${latencyMs} 毫秒就点了同意 —— 这看不出你有没有看过内容。先暂缓，不会被当成一次有效的同意。`,
        `You approved after only ${latencyMs} ms, which doesn't show you read it. On hold; it doesn't count as consent.`,
      ),
    };
  }
  return {
    accepted: true,
    rule: null,
    approvalLatencyMs: latencyMs,
    userFacingReason: t(`同意已记录（你花了 ${latencyMs} 毫秒）。`, `Consent recorded (you took ${latencyMs} ms).`),
  };
}

// ---------------------------------------------------------------------------
// 入口 3：现在能不能发出凭证（R-15）
// ---------------------------------------------------------------------------

export interface IssueCheck {
  ok: boolean;
  rule: RuleId | null;
  userFacingReason: string;
  /** 冷静期剩余毫秒；0 表示已结束 */
  remainingMs: number;
}

export function canIssueCredential(input: {
  decision: QuoteDecision;
  consent: ConsentDecision | null;
  now: Date;
}): IssueCheck {
  const { decision, consent, now } = input;

  // 被拒绝的，永远不发
  if (decision.channel === "decline") {
    return {
      ok: false,
      rule: decision.primaryReasonRule,
      userFacingReason: t(`这笔不会发出凭证 —— ${decision.userFacingReason}`, `No credential for this one: ${decision.userFacingReason}`),
      remainingMs: 0,
    };
  }

  // 冷静期内不发凭证
  if (decision.channel === "cooldown" && decision.cooldownUntil) {
    const remaining = Date.parse(decision.cooldownUntil) - now.getTime();
    if (remaining > 0) {
      return {
        ok: false,
        rule: RULE.COOLDOWN_NOT_ELAPSED,
        userFacingReason: t(
          `冷静期还没结束（还剩约 ${Math.ceil(remaining / 1000)} 秒）。这段时间里代理可以继续比价、查商户，但不会发出凭证。`,
          `The cooling-off period isn't over (about ${Math.ceil(remaining / 1000)} s left). The agent can keep comparing and checking the store, but no credential is issued.`,
        ),
        remainingMs: remaining,
      };
    }
  }

  // 用户点了「太快」的同意
  if (consent && !consent.accepted) {
    return {
      ok: false,
      rule: consent.rule,
      userFacingReason: consent.userFacingReason,
      remainingMs: 0,
    };
  }

  // 需要一次有效同意（问过一次，或冷静期刚结束）
  const needsConsent =
    decision.channel === "ask_once" || decision.channel === "cooldown";
  if (needsConsent && (!consent || !consent.accepted)) {
    return {
      ok: false,
      rule: null,
      userFacingReason:
        decision.channel === "cooldown"
          ? t("冷静期结束了，现在需要你确认一次，才会发出凭证。", "The cooling-off period is over. Confirm once and the credential is issued.")
          : t("这次需要你先点一次同意，才会发出凭证。", "This one needs your OK before a credential is issued."),
      remainingMs: 0,
    };
  }

  return {
    ok: true,
    rule: null,
    userFacingReason: t(
      "可以发出一次性凭证：锁死一家商户、一个金额、一次性使用。",
      "A one-time credential can be issued: locked to one store, one amount, one use.",
    ),
    remainingMs: 0,
  };
}

// ---------------------------------------------------------------------------
// 入口 4：凭证与批准内容是否逐字一致（R-14）
// ---------------------------------------------------------------------------

export function validateCredential(
  approved: ApprovedTerms,
  cred: Credential,
): CredentialCheck {
  const mismatches: string[] = [];

  if (cred.merchant_id !== approved.merchant_id) {
    mismatches.push(
      `merchant: 批准的是 ${approved.merchant_id}，凭证上是 ${cred.merchant_id}`,
    );
  }
  if (cred.amount_hkd !== approved.amount_hkd) {
    mismatches.push(
      `amount: 批准的是 ${approved.amount_hkd}，凭证上是 ${cred.amount_hkd}`,
    );
  }
  if (cred.item_sku !== approved.item_sku) {
    mismatches.push(
      `sku: 批准的是 ${approved.item_sku}，凭证上是 ${cred.item_sku}`,
    );
  }
  if (cred.single_use !== true) {
    mismatches.push("凭证不是一次性的");
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      rule: RULE.CREDENTIAL_MISMATCH,
      mismatches,
      userFacingReason: t(
        "凭证和批准的内容对不上，这笔不会结算。批准的商户、金额、商品被签在一起，批准之后不能调包。",
        "The credential doesn't match what you approved, so it won't settle. Store, amount and item are bound together and can't be swapped after approval.",
      ),
    };
  }

  return {
    ok: true,
    rule: null,
    mismatches: [],
    userFacingReason: t("凭证与批准内容逐字一致。", "The credential matches the approval exactly."),
  };
}
