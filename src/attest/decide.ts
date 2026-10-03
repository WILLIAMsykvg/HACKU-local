/**
 * 把证明层接到引擎上。只紧不松：
 *   最终通道 = 引擎通道 与 证明层通道 中更严的那个。
 *   引擎说 decline，证明层抬不回去；证明层只能把 instant 推向 ask_once、cooldown。
 *
 * 证明不成立（验签失败、分数对不上、价格对不上……）一律 decline，不发凭证。
 * 若返回 cooldown，canIssueCredential 会在冷静期结束加一次同意后放行，
 * 等于被篡改的证明包等一分钟就能付款。
 */

import { DEFAULT_OPTIONS, evaluateQuote, type EngineOptions } from "../engine/evaluate.ts";
import { t } from "../i18n.ts";
import type { EvalContext, QuoteDecision } from "../engine/types.ts";
import { orderHash } from "./orderHash.ts";
import { stricter } from "./score.ts";
import type { Bundle, TrustedIssuers, VerifyOutcome } from "./types.ts";
import { verifyBundle } from "./verify.ts";

export interface AttestationInput {
  bundle: Bundle | null;
  shipToLabel: string;
  trusted: TrustedIssuers;
}

export interface AttestedDecision extends QuoteDecision {
  /** 引擎自己给出的通道，便于日志和页面对照 */
  engineChannel: QuoteDecision["channel"];
  orderHash: string;
  attestation: VerifyOutcome | null;
}

export function evaluateWithAttestation(
  ctx: EvalContext,
  input: AttestationInput,
  options: EngineOptions = DEFAULT_OPTIONS,
): AttestedDecision {
  const engine = evaluateQuote(ctx, options);
  const hash = orderHash(ctx.quote, input.shipToLabel);
  const base = { ...engine, engineChannel: engine.channel, orderHash: hash };

  if (input.bundle === null) {
    return { ...base, attestation: null };
  }

  const outcome = verifyBundle(input.bundle, {
    orderHash: hash,
    trusted: input.trusted,
    now: ctx.now,
    merchantTrusted: ctx.mandate.trusted_merchants.includes(ctx.quote.merchant_id),
    qty: ctx.quote.item.qty,
  });

  if (!outcome.ok) {
    return {
      ...base,
      channel: "decline",
      userFacingReason: t(`这几份证明对不上，所以不发凭证：${outcome.reason}`, `The proofs don't check out, so no credential is issued. ${outcome.reason}`),
      logNotes: { ...engine.logNotes, [outcome.code]: outcome.reason },
      cooldownUntil: null,
      attestation: outcome,
    };
  }

  const r = outcome.result;
  let channel = stricter(engine.channel, r.channel);
  let downgradedByBudget = engine.downgradedByBudget;

  // 证明层要求「问一次」时也要占打扰额度；额度用尽就和引擎一样降成冷静期
  if (
    channel === "ask_once" &&
    r.channel === "ask_once" &&
    ctx.mandate.interrupts_used_this_week >= ctx.mandate.weekly_interrupt_budget
  ) {
    channel = "cooldown";
    downgradedByBudget = true;
  }

  const raisedByAttestation = channel !== engine.channel;
  const cooldownUntil =
    channel === "cooldown"
      ? (engine.cooldownUntil ??
        new Date(ctx.now.getTime() + options.cooldownDurationMs).toISOString())
      : null;

  return {
    ...base,
    channel,
    downgradedByBudget,
    cooldownUntil,
    userFacingReason: raisedByAttestation ? r.reason : engine.userFacingReason,
    logNotes: {
      ...engine.logNotes,
      ATTEST: `score=${r.score} score_channel=${r.score_channel} tier=${r.tier ?? "none"} floor=${r.floor_channel} attest_channel=${r.channel}`,
    },
    attestation: outcome,
  };
}
