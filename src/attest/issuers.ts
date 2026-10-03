/**
 * 发证方签结论，以及手机把结论打包。
 *
 * 发证方只拿自己那份数据回答固定问题。这里不读文件、不读定位、不读时钟，
 * 答案和时间一律由调用方传入。
 */

import { questionDef } from "./questions.ts";
import { computeScore } from "./score.ts";
import { signClaim, type IssuerKey } from "./sign.ts";
import type { Bundle, Claim, QuestionId, SignedClaim } from "./types.ts";

export interface IssueInput {
  orderHash: string;
  question: QuestionId;
  answer: boolean;
  now: Date;
  /** 只有银行结论需要 */
  authTime?: Date;
}

export function issueClaim(key: IssuerKey, o: IssueInput): SignedClaim {
  const q = questionDef(o.question);
  if (!q) throw new Error(`未知问题：${o.question}`);
  const claim: Claim = {
    order_hash: o.orderHash,
    role: q.role,
    question_id: q.id,
    answer: o.answer,
    issued_at: o.now.toISOString(),
    expires_at: new Date(o.now.getTime() + q.validity_ms).toISOString(),
  };
  if (q.id === "holder_recently_authenticated" && o.answer && o.authTime) {
    claim.auth_time = o.authTime.toISOString();
  }
  return signClaim(claim, key);
}

/** 手机：把收到的结论原样交出，附上按公开表算出的分数 */
export function composeBundle(orderHash: string, claims: SignedClaim[], now: Date): Bundle {
  return { order_hash: orderHash, claims, stated_score: computeScore(claims, now) };
}
