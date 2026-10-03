/**
 * 证明层 · 类型定义
 *
 * 每一方只在自己的数据上回答一个固定的是非题并签名。
 * 手机把结论合成分数交出去，验证方用同一张公开表重算。
 * 结论只能让交易更严，不能突破授权书和引擎的上限。
 */

import type { Channel } from "../engine/types.ts";

export type IssuerRole = "location" | "bank" | "merchant";

export type QuestionId =
  /** 定位：此刻是否在收货地 5 公里内（设备自证，正式版由运营商签） */
  | "near_ship_to"
  /** 银行：本人最近一次强认证的时间（答案为真时带 auth_time） */
  | "holder_recently_authenticated"
  /** 商户：这一单是否符合此人在本店的购买习惯 */
  | "consistent_with_history"
  /** 商户：这一单的商品、价格、库存是否与本店此刻公开的数据一致 */
  | "quote_matches_listing";

export interface Claim {
  order_hash: string;
  role: IssuerRole;
  question_id: QuestionId;
  answer: boolean;
  /** 只有银行结论有：最近一次强认证的时间（ISO）。不含任何生物特征 */
  auth_time?: string;
  issued_at: string;
  expires_at: string;
}

export interface SignedClaim {
  claim: Claim;
  /** Ed25519 公钥，JWK 的 x（base64url，32 字节） */
  issuer_key: string;
  /** 对 canonicalize(claim) 的 UTF-8 字节签名，base64url */
  signature: string;
}

export interface Bundle {
  order_hash: string;
  claims: SignedClaim[];
  stated_score: number;
}

/** 验证方信任的发证方公钥，按角色登记 */
export type TrustedIssuers = Record<IssuerRole, readonly string[]>;

export type StrengthTier = "strong" | "medium" | "weak";

/** 整包失败的理由码。不占用引擎的 R-00 至 R-15 */
export const ATTEST_FAIL = {
  DUPLICATE: "A-01",
  UNTRUSTED_KEY: "A-02",
  BAD_SIGNATURE: "A-03",
  ORDER_MISMATCH: "A-04",
  UNKNOWN_QUESTION: "A-05",
  SCORE_MISMATCH: "A-06",
  LISTING_MISMATCH: "A-07",
} as const;

export type AttestFailCode = (typeof ATTEST_FAIL)[keyof typeof ATTEST_FAIL];

export interface ClaimStatus {
  role: IssuerRole;
  question_id: QuestionId;
  /** counted：有效且计分；missing：没交；expired：过期或未生效，按缺失计 */
  state: "counted" | "missing" | "expired";
  answer: boolean | null;
  points: number;
}

export interface ScoreResult {
  score: number;
  /** 分数给出的通道 */
  score_channel: Exclude<Channel, "decline">;
  /** 强认证档位；银行结论缺失、为假或超过 24 小时时为 null */
  tier: StrengthTier | null;
  /** 档位、价格核对等给出的最低通道（取其中最严） */
  floor_channel: Exclude<Channel, "decline">;
  /** 证明层整体给出的通道 = score_channel 和 floor_channel 中更严的 */
  channel: Exclude<Channel, "decline">;
  statuses: ClaimStatus[];
  /** 给用户看的那一句话（证明层让交易变严时才有意义） */
  reason: string;
}

export type VerifyOutcome =
  | { ok: true; result: ScoreResult }
  | { ok: false; code: AttestFailCode; reason: string };
