/**
 * 公开加分表、强认证档位、分数到通道。纯函数，now 是参数。
 *
 * 手机用 computeScore 算出 stated_score；验证方用同一个函数重算。
 * 档位和价格核对给出的「最低通道」只由验证方算，不进 stated_score。
 */

import { SEVERITY, type Channel } from "../engine/types.ts";
import { t } from "../i18n.ts";
import { QUESTIONS, SCORE_THRESHOLDS, TIER_BOUNDS } from "./questions.ts";
import type {
  ClaimStatus,
  ScoreResult,
  SignedClaim,
  StrengthTier,
} from "./types.ts";

type SoftChannel = Exclude<Channel, "decline">;

export function stricter<C extends Channel>(a: C, b: C): C {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

export function strengthTier(authTime: string | undefined, now: Date): StrengthTier | null {
  if (!authTime) return null;
  const t = Date.parse(authTime);
  if (!Number.isFinite(t)) return null;
  const age = now.getTime() - t;
  if (age < 0) return null;
  if (age < TIER_BOUNDS.strong) return "strong";
  if (age < TIER_BOUNDS.medium) return "medium";
  if (age < TIER_BOUNDS.weak) return "weak";
  return null;
}

export function scoreChannel(score: number): SoftChannel {
  if (score >= SCORE_THRESHOLDS.instant) return "instant";
  if (score >= SCORE_THRESHOLDS.ask_once) return "ask_once";
  return "cooldown";
}

function inWindow(sc: SignedClaim, now: Date): boolean {
  const from = Date.parse(sc.claim.issued_at);
  const to = Date.parse(sc.claim.expires_at);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const t = now.getTime();
  return t >= from && t <= to;
}

/** 逐题给出状态。同一题若有多份，只看第一份（重复由验证方另行拒绝） */
export function claimStatuses(claims: readonly SignedClaim[], now: Date): ClaimStatus[] {
  return QUESTIONS.map((q) => {
    const sc = claims.find((c) => c.claim.question_id === q.id && c.claim.role === q.role);
    if (!sc) {
      return { role: q.role, question_id: q.id, state: "missing", answer: null, points: 0 };
    }
    let valid = inWindow(sc, now);
    if (valid && q.id === "holder_recently_authenticated" && sc.claim.answer) {
      valid = strengthTier(sc.claim.auth_time, now) !== null;
    }
    if (!valid) {
      return { role: q.role, question_id: q.id, state: "expired", answer: sc.claim.answer, points: 0 };
    }
    return {
      role: q.role,
      question_id: q.id,
      state: "counted",
      answer: sc.claim.answer,
      points: sc.claim.answer ? q.points : 0,
    };
  });
}

/** 手机和验证方共用：只依赖结论本身和 now */
export function computeScore(claims: readonly SignedClaim[], now: Date): number {
  return claimStatuses(claims, now).reduce((sum, s) => sum + s.points, 0);
}

export interface FloorContext {
  now: Date;
  /** 商户是否在用户的信任名单里 */
  merchantTrusted: boolean;
  qty: number;
}

function tierText(tier: StrengthTier): string {
  return {
    strong: t("2 小时内", "within the last 2 hours"),
    medium: t("2 到 12 小时前", "2 to 12 hours ago"),
    weak: t("12 到 24 小时前", "12 to 24 hours ago"),
  }[tier];
}

export function scoreClaims(claims: readonly SignedClaim[], ctx: FloorContext): ScoreResult {
  const statuses = claimStatuses(claims, ctx.now);
  const score = statuses.reduce((sum, s) => sum + s.points, 0);
  const sChannel = scoreChannel(score);

  const bank = statuses.find((s) => s.question_id === "holder_recently_authenticated")!;
  const bankClaim = claims.find((c) => c.claim.question_id === "holder_recently_authenticated");
  const tier =
    bank.state === "counted" && bank.answer
      ? strengthTier(bankClaim?.claim.auth_time, ctx.now)
      : null;

  const floorReasons: { channel: SoftChannel; text: string }[] = [];

  if (tier === "medium" && !(ctx.merchantTrusted && ctx.qty === 1)) {
    floorReasons.push({
      channel: "ask_once",
      text: t(
        `你上次用指纹或面容确认是${tierText("medium")}，这一单是新商户或不止一件，所以先问你一次。`,
        `You last confirmed with fingerprint or face ${tierText("medium")}, and this is a new store or more than one item, so you're asked once.`,
      ),
    });
  }
  if (tier === "weak") {
    floorReasons.push({
      channel: "cooldown",
      text: t(
        `你上次用指纹或面容确认是${tierText("weak")}，授权已经变弱，先进冷静期；再确认一次就恢复。`,
        `You last confirmed with fingerprint or face ${tierText("weak")}. Your authorisation has weakened, so this goes to cooling-off first; confirm again to restore it.`,
      ),
    });
  }

  const listing = statuses.find((s) => s.question_id === "quote_matches_listing")!;
  if (listing.state !== "counted") {
    floorReasons.push({
      channel: "ask_once",
      text: t("商户没有核对这一单的价格和库存，所以请你自己确认一次。", "The store didn't confirm this order's price and stock, so please confirm it yourself once."),
    });
  }

  let floor: SoftChannel = "instant";
  for (const r of floorReasons) floor = stricter(floor, r.channel);
  const channel = stricter(sChannel, floor);

  const top = floorReasons.filter((r) => r.channel === channel).map((r) => r.text);
  if (sChannel === channel && sChannel !== "instant") {
    const lacking = statuses
      .filter((s) => s.points === 0 && s.question_id !== "quote_matches_listing")
      .map((s) => describeLack(s));
    top.unshift(t(`证明分数 ${score}：${lacking.join("；")}。`, `Proof score ${score}: ${lacking.join("; ")}.`));
  }

  return {
    score,
    score_channel: sChannel,
    tier,
    floor_channel: floor,
    channel,
    statuses,
    reason: top.length > 0 ? top.join(" ") : t("三方证明齐全，这一单可以直接执行。", "All three parties' answers are in, so this order can go ahead."),
  };
}

function describeLack(s: ClaimStatus): string {
  const who: Record<string, string> = {
    near_ship_to: t("定位", "location"),
    holder_recently_authenticated: t("本人确认", "holder confirmation"),
    consistent_with_history: t("购买习惯", "buying habits"),
  };
  const name = who[s.question_id] ?? s.question_id;
  if (s.state === "missing") return t(`${name}没有提供`, `${name} not provided`);
  if (s.state === "expired") return t(`${name}已过期`, `${name} expired`);
  if (s.question_id === "near_ship_to") return t("你此刻不在收货地附近", "you're not near the ship-to address right now");
  if (s.question_id === "consistent_with_history") return t("这一单和你在这家店的习惯不一致", "this order doesn't fit your habits at this store");
  return t(`${name}的回答是否`, `${name} answered no`);
}
