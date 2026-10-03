/**
 * 固定问题表。问题、阈值、有效期、分值都写死在这里，并且公开。
 *
 * 不从请求里读阈值：否则可以用「1 公里内？2 公里内？3 公里内？」一圈圈逼出位置。
 * 改阈值必须改代码，并写进公开表。
 */

import type { IssuerRole, QuestionId } from "./types.ts";

export interface QuestionDef {
  id: QuestionId;
  role: IssuerRole;
  text: string;
  /** 结论自签发起的有效期 */
  validity_ms: number;
  /** 答案为真时的分值；为假、缺失、过期都是 0 */
  points: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 定位的距离阈值（公里）。演示值 */
export const NEAR_SHIP_TO_KM = 5;

export const QUESTIONS: readonly QuestionDef[] = [
  {
    id: "near_ship_to",
    role: "location",
    text: `此刻是否在收货地 ${NEAR_SHIP_TO_KM} 公里内`,
    validity_ms: 10 * MIN,
    points: 40,
  },
  {
    id: "holder_recently_authenticated",
    role: "bank",
    text: "本人最近一次用指纹或面容强认证的时间",
    validity_ms: 2 * MIN,
    points: 40,
  },
  {
    id: "consistent_with_history",
    role: "merchant",
    text: "这一单是否符合此人在本店的购买习惯",
    validity_ms: 24 * HOUR,
    points: 20,
  },
  {
    id: "quote_matches_listing",
    role: "merchant",
    text: "这一单的商品、价格、库存是否与本店此刻公开的数据一致",
    validity_ms: 10 * MIN,
    // 不计分：对不上直接不发凭证，缺失则至少问一次
    points: 0,
  },
];

export function questionDef(id: QuestionId): QuestionDef | undefined {
  return QUESTIONS.find((q) => q.id === id);
}

/** 强认证档位的边界（距 auth_time 的毫秒数，左闭右开） */
export const TIER_BOUNDS = {
  strong: 2 * HOUR,
  medium: 12 * HOUR,
  weak: 24 * HOUR,
} as const;

/** 分数到通道 */
export const SCORE_THRESHOLDS = {
  instant: 80,
  ask_once: 40,
} as const;
