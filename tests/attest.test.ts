/**
 * 证明层测试 —— A01 ~ A21
 *
 * 正常路径、四种攻击（重放、挑着交、改分数、改收货地）、只紧不松、
 * 强认证档位衰减、证明不成立时绝不发凭证。
 * 密钥在测试里现生成，now 固定。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { canIssueCredential, evaluateQuote } from "../src/engine/evaluate.ts";
import type { EvalContext, Mandate, Quote } from "../src/engine/types.ts";
import { NOW, makeHistory, makeMandate, makeQuote, makeRiskList } from "../src/demo/fixtures.ts";
import { evaluateWithAttestation } from "../src/attest/decide.ts";
import { composeBundle, issueClaim } from "../src/attest/issuers.ts";
import { orderHash } from "../src/attest/orderHash.ts";
import { generateIssuerKey, signClaim } from "../src/attest/sign.ts";
import { ATTEST_FAIL, type Bundle, type SignedClaim, type TrustedIssuers } from "../src/attest/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

const KEYS = {
  location: generateIssuerKey(),
  bank: generateIssuerKey(),
  merchant: generateIssuerKey(),
};

const TRUSTED: TrustedIssuers = {
  location: [KEYS.location.publicKey],
  bank: [KEYS.bank.publicKey],
  merchant: [KEYS.merchant.publicKey],
};

/** 回头客、咖啡、HK$60：引擎本身给 instant，方便看证明层的影响 */
function ctxFor(o: { quote?: Partial<Quote>; mandate?: Partial<Mandate>; now?: Date } = {}): EvalContext {
  return {
    mandate: makeMandate(o.mandate),
    quote: makeQuote({ merchant_id: "m_brew", category: "coffee", unit_price_hkd: 60, ...o.quote }),
    history: makeHistory(),
    riskList: makeRiskList(),
    now: o.now ?? NOW,
  };
}

interface ClaimOpts {
  /** null 表示这一份不交 */
  near?: boolean | null;
  /** 距上次强认证多久；null 表示银行不交 */
  authAgoMs?: number | null;
  history?: boolean | null;
  listing?: boolean | null;
  issuedAt?: Date;
}

function claimsFor(hash: string, o: ClaimOpts = {}): SignedClaim[] {
  const now = o.issuedAt ?? NOW;
  const out: SignedClaim[] = [];
  const near = o.near === undefined ? true : o.near;
  const authAgo = o.authAgoMs === undefined ? 30 * MIN : o.authAgoMs;
  const history = o.history === undefined ? true : o.history;
  const listing = o.listing === undefined ? true : o.listing;

  if (near !== null) {
    out.push(issueClaim(KEYS.location, { orderHash: hash, question: "near_ship_to", answer: near, now }));
  }
  if (authAgo !== null) {
    out.push(
      issueClaim(KEYS.bank, {
        orderHash: hash,
        question: "holder_recently_authenticated",
        answer: true,
        now,
        authTime: new Date(NOW.getTime() - authAgo),
      }),
    );
  }
  if (history !== null) {
    out.push(issueClaim(KEYS.merchant, { orderHash: hash, question: "consistent_with_history", answer: history, now }));
  }
  if (listing !== null) {
    out.push(issueClaim(KEYS.merchant, { orderHash: hash, question: "quote_matches_listing", answer: listing, now }));
  }
  return out;
}

function run(ctx: EvalContext, bundle: Bundle | null, shipTo = "dorm") {
  return evaluateWithAttestation(ctx, { bundle, shipToLabel: shipTo, trusted: TRUSTED });
}

function bundleFor(ctx: EvalContext, o: ClaimOpts = {}, shipTo = "dorm"): Bundle {
  const hash = orderHash(ctx.quote, shipTo);
  return composeBundle(hash, claimsFor(hash, o), ctx.now);
}

function failCode(d: ReturnType<typeof run>) {
  assert.ok(d.attestation && !d.attestation.ok, "期望证明不成立");
  return d.attestation.code;
}

function okResult(d: ReturnType<typeof run>) {
  assert.ok(d.attestation && d.attestation.ok, `期望证明成立：${JSON.stringify(d.attestation)}`);
  return d.attestation.result;
}

// ===========================================================================
// 正常路径
// ===========================================================================

test("A01 三方都为真、分数如实 → 证明层 instant，最终 instant", () => {
  const ctx = ctxFor();
  const d = run(ctx, bundleFor(ctx));
  const r = okResult(d);
  assert.equal(r.score, 100);
  assert.equal(r.channel, "instant");
  assert.equal(d.channel, "instant");
});

test("A02 只有银行一份 → 40 分，ask_once（一方也能用）", () => {
  const ctx = ctxFor();
  const d = run(ctx, bundleFor(ctx, { near: null, history: null, listing: null }));
  const r = okResult(d);
  assert.equal(r.score, 40);
  assert.equal(r.channel, "ask_once");
  assert.equal(d.channel, "ask_once");
});

// ===========================================================================
// 攻击
// ===========================================================================

test("A03 重放：拿上一单的结论来交这一单 → 订单编号对不上，decline", () => {
  const ctx = ctxFor();
  const oldHash = orderHash(makeQuote({ quote_id: "q_0000", merchant_id: "m_brew", category: "coffee", unit_price_hkd: 60 }), "dorm");
  const replayed = composeBundle(orderHash(ctx.quote, "dorm"), claimsFor(oldHash), ctx.now);
  const d = run(ctx, replayed);
  assert.equal(failCode(d), ATTEST_FAIL.ORDER_MISMATCH);
  assert.equal(d.channel, "decline");
});

test("A04 挑着交：丢掉为假的定位结论", () => {
  const ctx = ctxFor();
  const hash = orderHash(ctx.quote, "dorm");
  const withoutLocation = claimsFor(hash, { near: false }).filter((c) => c.claim.role !== "location");

  // 丢掉之后谎称 100 分 → 重算对不上
  const lying = run(ctx, { order_hash: hash, claims: withoutLocation, stated_score: 100 });
  assert.equal(failCode(lying), ATTEST_FAIL.SCORE_MISMATCH);

  // 如实写 60 分 → 通过，但缺的那份按 0 分，走 ask_once
  const honest = run(ctx, composeBundle(hash, withoutLocation, ctx.now));
  const r = okResult(honest);
  assert.equal(r.score, 60);
  assert.equal(honest.channel, "ask_once");
});

test("A05 签名都是真的，但把分数改高 → decline", () => {
  const ctx = ctxFor();
  const hash = orderHash(ctx.quote, "dorm");
  const claims = claimsFor(hash, { near: false });
  const d = run(ctx, { order_hash: hash, claims, stated_score: 100 });
  assert.equal(failCode(d), ATTEST_FAIL.SCORE_MISMATCH);
  assert.equal(d.channel, "decline");
});

test("A06 代理被劫持改收货地 → 旧结论的订单编号对不上，decline", () => {
  const ctx = ctxFor();
  const signedForDorm = bundleFor(ctx, {}, "dorm");
  const d = run(ctx, signedForDorm, "other_city");
  assert.equal(failCode(d), ATTEST_FAIL.ORDER_MISMATCH);
  assert.equal(d.channel, "decline");
});

test("A07 同一题交两份 → decline", () => {
  const ctx = ctxFor();
  const hash = orderHash(ctx.quote, "dorm");
  const claims = claimsFor(hash);
  claims.push(issueClaim(KEYS.location, { orderHash: hash, question: "near_ship_to", answer: true, now: NOW }));
  const d = run(ctx, composeBundle(hash, claims, ctx.now));
  assert.equal(failCode(d), ATTEST_FAIL.DUPLICATE);
});

test("A08 过期的结论按缺失计 0 分，不按真", () => {
  const ctx = ctxFor();
  const hash = orderHash(ctx.quote, "dorm");
  const stale = issueClaim(KEYS.location, {
    orderHash: hash,
    question: "near_ship_to",
    answer: true,
    now: new Date(NOW.getTime() - 11 * MIN),
  });
  const claims = [stale, ...claimsFor(hash, { near: null })];
  const d = run(ctx, composeBundle(hash, claims, ctx.now));
  const r = okResult(d);
  assert.equal(r.score, 60);
  assert.equal(r.statuses.find((s) => s.question_id === "near_ship_to")?.state, "expired");
  assert.equal(d.channel, "ask_once");
});

// ===========================================================================
// 只紧不松
// ===========================================================================

test("A09 引擎给 cooldown（首单），证明层 instant → 最终仍是 cooldown", () => {
  const ctx = ctxFor({ quote: { merchant_id: "m_tech", category: "electronics", unit_price_hkd: 199 } });
  const d = run(ctx, bundleFor(ctx));
  assert.equal(okResult(d).channel, "instant");
  assert.equal(d.engineChannel, "cooldown");
  assert.equal(d.channel, "cooldown");
});

test("A10 引擎给 decline（超单笔上限），证明层不能抬回去", () => {
  const ctx = ctxFor({ quote: { unit_price_hkd: 900 } });
  const d = run(ctx, bundleFor(ctx));
  assert.equal(okResult(d).channel, "instant");
  assert.equal(d.channel, "decline");
});

// ===========================================================================
// 强认证档位随时间衰减
// ===========================================================================

test("A11 强认证 30 分钟前 → strong，instant", () => {
  const ctx = ctxFor();
  const d = run(ctx, bundleFor(ctx, { authAgoMs: 30 * MIN }));
  assert.equal(okResult(d).tier, "strong");
  assert.equal(d.channel, "instant");
});

test("A12 强认证 3 小时前 → medium：熟悉商户买一件仍直接过，买两件要问一次", () => {
  const one = ctxFor();
  const d1 = run(one, bundleFor(one, { authAgoMs: 3 * HOUR }));
  assert.equal(okResult(d1).tier, "medium");
  assert.equal(d1.channel, "instant");

  const two = ctxFor({ quote: { item: { title: "House Blend 250g", sku: "COF-250", qty: 2 } } });
  const d2 = run(two, bundleFor(two, { authAgoMs: 3 * HOUR }));
  assert.equal(okResult(d2).floor_channel, "ask_once");
  assert.equal(d2.channel, "ask_once");
});

test("A13 强认证 13 小时前 → weak，至少 cooldown，并给出冷静期结束时间", () => {
  const ctx = ctxFor();
  const d = run(ctx, bundleFor(ctx, { authAgoMs: 13 * HOUR }));
  assert.equal(okResult(d).tier, "weak");
  assert.equal(d.channel, "cooldown");
  assert.ok(d.cooldownUntil !== null);
});

test("A14 强认证 25 小时前 → 银行按缺失计 0 分，没有档位", () => {
  const ctx = ctxFor();
  const d = run(ctx, bundleFor(ctx, { authAgoMs: 25 * HOUR }));
  const r = okResult(d);
  assert.equal(r.tier, null);
  assert.equal(r.score, 60);
  assert.equal(r.statuses.find((s) => s.role === "bank")?.state, "expired");
  assert.equal(d.channel, "ask_once");
});

// ===========================================================================
// 证明不成立时绝不发凭证
// ===========================================================================

test("A15 证明不成立 → 即使有一次有效同意、即使过了很久，也不发凭证", () => {
  const ctx = ctxFor();
  const hash = orderHash(ctx.quote, "dorm");
  const d = run(ctx, { order_hash: hash, claims: claimsFor(hash), stated_score: 999 });
  const issue = canIssueCredential({
    decision: d,
    consent: { accepted: true, rule: null, approvalLatencyMs: 2400, userFacingReason: "" },
    now: new Date(NOW.getTime() + 24 * HOUR),
  });
  assert.equal(issue.ok, false);
});

test("A16 用不在信任名单里的钥匙签定位 → decline", () => {
  const ctx = ctxFor();
  const hash = orderHash(ctx.quote, "dorm");
  const attacker = generateIssuerKey();
  const forged = issueClaim(attacker, { orderHash: hash, question: "near_ship_to", answer: true, now: NOW });
  const claims = [forged, ...claimsFor(hash, { near: null })];
  const d = run(ctx, composeBundle(hash, claims, ctx.now));
  assert.equal(failCode(d), ATTEST_FAIL.UNTRUSTED_KEY);
});

test("A17 签完之后把答案从否改成是 → 验签失败", () => {
  const ctx = ctxFor();
  const hash = orderHash(ctx.quote, "dorm");
  const claims = claimsFor(hash, { near: false });
  const loc = claims.find((c) => c.claim.role === "location")!;
  loc.claim = { ...loc.claim, answer: true };
  const d = run(ctx, composeBundle(hash, claims, ctx.now));
  assert.equal(failCode(d), ATTEST_FAIL.BAD_SIGNATURE);
});

test("A18 商户核对价格或库存对不上 → decline", () => {
  const ctx = ctxFor();
  const d = run(ctx, bundleFor(ctx, { listing: false }));
  assert.equal(failCode(d), ATTEST_FAIL.LISTING_MISMATCH);
  assert.equal(d.channel, "decline");
});

test("A19 不交证明包 → 和原引擎完全一样", () => {
  const ctx = ctxFor({ quote: { merchant_id: "m_tech", category: "electronics", unit_price_hkd: 199 } });
  const d = run(ctx, null);
  const e = evaluateQuote(ctx);
  assert.equal(d.channel, e.channel);
  assert.deepEqual(d.triggeredRules, e.triggeredRules);
  assert.equal(d.userFacingReason, e.userFacingReason);
  assert.equal(d.attestation, null);
});

test("A20 证明层要求问一次，但打扰额度已用尽 → 降成冷静期", () => {
  const ctx = ctxFor({ mandate: { interrupts_used_this_week: 3 } });
  const d = run(ctx, bundleFor(ctx, { near: null, history: null, listing: null }));
  assert.equal(okResult(d).channel, "ask_once");
  assert.equal(d.channel, "cooldown");
  assert.equal(d.downgradedByBudget, true);
});

test("A21 商户钥匙去回答定位的问题 → 不在公开表里，decline", () => {
  const ctx = ctxFor();
  const hash = orderHash(ctx.quote, "dorm");
  const wrongPair = signClaim(
    {
      order_hash: hash,
      role: "merchant",
      question_id: "near_ship_to",
      answer: true,
      issued_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 10 * MIN).toISOString(),
    },
    KEYS.merchant,
  );
  const claims = [wrongPair, ...claimsFor(hash, { near: null })];
  const d = run(ctx, composeBundle(hash, claims, ctx.now));
  assert.equal(failCode(d), ATTEST_FAIL.UNKNOWN_QUESTION);
});
