/**
 * 验证方：验签、对订单编号、对时效、重算分数。纯函数，now 是参数。
 *
 * 检查顺序（第一项整包失败就停）：
 *  1. 每一题至多一份
 *  2. 公钥在这个角色的信任名单里
 *  3. 签名对得上 canonicalize(claim)
 *  4. 结论的订单编号等于这一单的编号
 *  5. 问题和角色是固定表里的那一对
 *  6. 商户说价格或库存对不上 → 不发凭证
 *  7. 重算分数，与 stated_score 一致
 * 时效不在其中：过期的那一份按缺失计 0 分，不算整包失败。
 */

import { t } from "../i18n.ts";
import { questionDef } from "./questions.ts";
import { claimStatuses, computeScore, scoreClaims, type FloorContext } from "./score.ts";
import { verifyClaimSignature } from "./sign.ts";
import { ATTEST_FAIL, type Bundle, type TrustedIssuers, type VerifyOutcome } from "./types.ts";

export interface VerifyContext extends FloorContext {
  /** 验证方按这一单自己算出的编号 */
  orderHash: string;
  trusted: TrustedIssuers;
}

export function verifyBundle(bundle: Bundle, ctx: VerifyContext): VerifyOutcome {
  const seen = new Set<string>();
  for (const sc of bundle.claims) {
    const k = `${sc.claim.role}/${sc.claim.question_id}`;
    if (seen.has(k)) {
      return {
        ok: false,
        code: ATTEST_FAIL.DUPLICATE,
        reason: t(`同一个问题交了两份结论（${k}）。每单每题只接受一份。`, `Two answers were sent for the same question (${k}). Only one per question per order is accepted.`),
      };
    }
    seen.add(k);
  }

  for (const sc of bundle.claims) {
    if (!ctx.trusted[sc.claim.role]?.includes(sc.issuer_key)) {
      return {
        ok: false,
        code: ATTEST_FAIL.UNTRUSTED_KEY,
        reason: t(`「${sc.claim.role}」这份结论的签名钥匙不在信任名单里。`, `The ${sc.claim.role} answer is signed with a key that is not on the trusted list.`),
      };
    }
    if (!verifyClaimSignature(sc)) {
      return {
        ok: false,
        code: ATTEST_FAIL.BAD_SIGNATURE,
        reason: t(`「${sc.claim.role}」这份结论的签名对不上，内容被改过。`, `The ${sc.claim.role} answer's signature doesn't match: its content was changed.`),
      };
    }
    if (sc.claim.order_hash !== ctx.orderHash) {
      return {
        ok: false,
        code: ATTEST_FAIL.ORDER_MISMATCH,
        reason: t(
          `「${sc.claim.role}」这份结论签的不是这一单（订单编号对不上）。可能是重放了别的订单，或者收货地、金额被改过。`,
          `The ${sc.claim.role} answer was signed for a different order (the order hash doesn't match). Another order was replayed, or the ship-to or amount was changed.`,
        ),
      };
    }
    const q = questionDef(sc.claim.question_id);
    if (!q || q.role !== sc.claim.role) {
      return {
        ok: false,
        code: ATTEST_FAIL.UNKNOWN_QUESTION,
        reason: t(
          `「${sc.claim.role}」回答了一个不在公开表里的问题（${sc.claim.question_id}）。`,
          `The ${sc.claim.role} issuer answered a question that is not in the public table (${sc.claim.question_id}).`,
        ),
      };
    }
  }

  if (bundle.order_hash !== ctx.orderHash) {
    return {
      ok: false,
      code: ATTEST_FAIL.ORDER_MISMATCH,
      reason: t("证明包声明的订单编号和这一单对不上。", "The bundle's order hash doesn't match this order."),
    };
  }

  const listing = claimStatuses(bundle.claims, ctx.now).find(
    (s) => s.question_id === "quote_matches_listing",
  );
  if (listing?.state === "counted" && listing.answer === false) {
    return {
      ok: false,
      code: ATTEST_FAIL.LISTING_MISMATCH,
      reason: t("商户核对后说：这一单的商品、价格或库存和店里此刻的不一样。", "The store checked: this order's item, price or stock differs from the store right now."),
    };
  }

  const recomputed = computeScore(bundle.claims, ctx.now);
  if (recomputed !== bundle.stated_score) {
    return {
      ok: false,
      code: ATTEST_FAIL.SCORE_MISMATCH,
      reason: t(
        `手机交上来的分数是 ${bundle.stated_score}，按公开表重算是 ${recomputed}。分数对不上。`,
        `The phone stated a score of ${bundle.stated_score}; recomputed from the public table it is ${recomputed}. The scores don't match.`,
      ),
    };
  }

  return { ok: true, result: scoreClaims(bundle.claims, ctx) };
}
