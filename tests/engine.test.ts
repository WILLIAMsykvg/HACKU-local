/**
 * 规则引擎测试矩阵 —— T01 ~ T21
 *
 * 前 7 条是队伍文档点名的必测项；其余覆盖全部规则与优先级。
 * 运行：npm test   或   node --test tests/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPTIONS,
  canIssueCredential,
  evaluateConsent,
  evaluateQuote,
  validateCredential,
  type EngineOptions,
} from "../src/engine/evaluate.ts";
import { RULE } from "../src/engine/types.ts";
import type { Mandate, Quote, RiskList, UserHistory } from "../src/engine/types.ts";
import {
  NOW,
  makeHistory,
  makeMandate,
  makeQuote,
  makeRiskList,
} from "../src/demo/fixtures.ts";

function judge(
  o: {
    mandate?: Partial<Mandate>;
    quote?: Partial<Quote>;
    history?: Partial<UserHistory>;
    riskList?: Partial<RiskList>;
    now?: Date;
    options?: EngineOptions;
  } = {},
) {
  return evaluateQuote(
    {
      mandate: makeMandate(o.mandate),
      quote: makeQuote(o.quote),
      history: makeHistory(o.history),
      riskList: makeRiskList(o.riskList),
      now: o.now ?? NOW,
    },
    o.options ?? DEFAULT_OPTIONS,
  );
}

// ===========================================================================
// 队伍文档点名的 7 条必测
// ===========================================================================

test("T01 回头客即时通过", () => {
  const d = judge({
    quote: {
      merchant_id: "m_brew",
      merchant_name: "Brew & Co",
      category: "coffee",
      unit_price_hkd: 60,
    },
  });
  assert.equal(d.channel, "instant");
  assert.deepEqual(d.triggeredRules, []);
  assert.equal(d.primaryReasonRule, null);
});

test("T02 首单进冷静期", () => {
  const d = judge({
    quote: {
      merchant_id: "m_tech",
      merchant_name: "TechDeal HK",
      category: "electronics",
      unit_price_hkd: 199,
    },
  });
  assert.equal(d.channel, "cooldown");
  assert.ok(d.triggeredRules.includes(RULE.FIRST_TIME_MERCHANT));
  assert.ok(d.cooldownUntil !== null);
});

test("T03 超零用钱包进冷静期", () => {
  const d = judge({
    quote: {
      merchant_id: "m_brew",
      category: "coffee",
      unit_price_hkd: 520,
    },
  });
  assert.equal(d.channel, "cooldown");
  assert.ok(d.triggeredRules.includes(RULE.POCKET_WALLET_EXCEEDED));
  assert.ok(d.triggeredRules.includes(RULE.ABOVE_COOLDOWN_THRESHOLD));
});

test("T04 1 秒内点同意则暂缓", () => {
  const c = evaluateConsent(800);
  assert.equal(c.accepted, false);
  assert.equal(c.rule, RULE.CONSENT_TOO_FAST);

  // 对照组：正常速度算有效
  assert.equal(evaluateConsent(2400).accepted, true);
});

test("T05 命中高风险名单则拒绝", () => {
  const d = judge({ quote: { fps_id: "9998887" } });
  assert.equal(d.channel, "decline");
  assert.equal(d.primaryReasonRule, RULE.HIGH_RISK_FPS_ID);
});

test("T06 凭证金额与批准内容不符则失败", () => {
  const approved = {
    quote_id: "q_0001",
    merchant_id: "m_brew",
    amount_hkd: 199,
    item_sku: "COF-250",
  };
  const cred = {
    credential_id: "cred_1",
    single_use: true,
    merchant_id: "m_brew",
    amount_hkd: 247, // ← 被调包
    item_sku: "COF-250",
    issued_at: NOW.toISOString(),
    expires_at: NOW.toISOString(),
  };
  const r = validateCredential(approved, cred);
  assert.equal(r.ok, false);
  assert.equal(r.rule, RULE.CREDENTIAL_MISMATCH);
  assert.equal(r.mismatches.length, 1);

  // 一致时通过
  assert.equal(validateCredential(approved, { ...cred, amount_hkd: 199 }).ok, true);
});

test("T07 冷静期未结束不发凭证", () => {
  const d = judge({
    quote: {
      merchant_id: "m_tech",
      merchant_name: "TechDeal HK",
      category: "electronics",
      unit_price_hkd: 199,
    },
  });
  assert.equal(d.channel, "cooldown");

  const early = canIssueCredential({
    decision: d,
    consent: null,
    now: new Date(NOW.getTime() + 10_000), // 冷静期内
  });
  assert.equal(early.ok, false);
  assert.equal(early.rule, RULE.COOLDOWN_NOT_ELAPSED);
  assert.ok(early.remainingMs > 0);
});

// ===========================================================================
// 题目原文点名要演的：结算时运费和税把总额推过上限
// ===========================================================================

test("T08 结算时运费+税把总额推过单笔上限", () => {
  const d = judge({
    quote: {
      merchant_id: "m_brew",
      category: "coffee",
      unit_price_hkd: 780, // 单价本身没超 800
      shipping_hkd: 30,
      service_fee_hkd: 18, // 合计 828 → 超了
    },
  });
  assert.equal(d.channel, "decline");
  assert.equal(d.primaryReasonRule, RULE.PER_TXN_CAP_EXCEEDED);
});

test("T19 引擎用的是结算总额，不是商品单价", () => {
  const d = judge({
    quote: {
      merchant_id: "m_brew",
      category: "coffee",
      unit_price_hkd: 200, // 单价远低于上限
      shipping_hkd: 700, // 但运费把它推过 800
    },
  });
  assert.equal(d.channel, "decline");
  assert.equal(d.primaryReasonRule, RULE.PER_TXN_CAP_EXCEEDED);
});

// ===========================================================================
// 其余规则
// ===========================================================================

test("T09 授权过期 → 拒绝", () => {
  const d = judge({ now: new Date("2026-10-05T00:00:00+08:00") });
  assert.equal(d.channel, "decline");
  assert.equal(d.primaryReasonRule, RULE.MANDATE_EXPIRED);
});

test("T10 商户不在白名单 → 拒绝", () => {
  const d = judge({
    quote: {
      merchant_id: "m_evil",
      merchant_name: "Too Good Deals",
      category: "coffee",
      unit_price_hkd: 199,
    },
  });
  assert.equal(d.channel, "decline");
  assert.ok(d.triggeredRules.includes(RULE.MERCHANT_NOT_ALLOWED));
});

test("T11 滚动 7 天超上限 → 拒绝", () => {
  const d = judge({
    history: {
      purchases_last_7d: [
        { at: "2026-10-01T10:00:00+08:00", total_hkd: 1900 },
      ],
    },
    quote: { merchant_id: "m_brew", category: "coffee", unit_price_hkd: 200 },
  });
  assert.equal(d.channel, "decline");
  assert.ok(d.triggeredRules.includes(RULE.ROLLING_WINDOW_EXCEEDED));
});

test("T12 不可退 → 问一次", () => {
  const d = judge({
    mandate: { trusted_merchants: ["m_brew", "m_tech"] },
    history: {
      category_stats: {
        food: { count: 42, median_hkd: 85 },
        coffee: { count: 18, median_hkd: 42 },
        electronics: { count: 5, median_hkd: 150 },
      },
    },
    quote: {
      merchant_id: "m_tech",
      merchant_name: "TechDeal HK",
      category: "electronics",
      unit_price_hkd: 199,
      refundable: false,
    },
  });
  assert.equal(d.channel, "ask_once");
  assert.ok(d.triggeredRules.includes(RULE.NOT_REFUNDABLE));
});

test("T13 价格异常 → 问一次", () => {
  const d = judge({
    mandate: {
      trusted_merchants: ["m_brew", "m_tech"],
      cooldown_threshold_hkd: 500,
    },
    history: {
      category_stats: { electronics: { count: 5, median_hkd: 85 } },
    },
    quote: {
      merchant_id: "m_tech",
      merchant_name: "TechDeal HK",
      category: "electronics",
      unit_price_hkd: 320, // 3 × 85 = 255
    },
  });
  assert.equal(d.channel, "ask_once");
  assert.ok(d.triggeredRules.includes(RULE.PRICE_ANOMALY));
});

test("T14 新类别 → 问一次", () => {
  const d = judge({
    mandate: { trusted_merchants: ["m_brew", "m_tech"] },
    quote: {
      merchant_id: "m_tech",
      merchant_name: "TechDeal HK",
      category: "electronics",
      unit_price_hkd: 199,
    },
  });
  assert.equal(d.channel, "ask_once");
  assert.ok(d.triggeredRules.includes(RULE.NEW_CATEGORY));
});

test("T15 同意预算用尽 → 从「问一次」降级为「冷静期」", () => {
  const d = judge({
    mandate: {
      trusted_merchants: ["m_brew", "m_tech"],
      interrupts_used_this_week: 3,
      weekly_interrupt_budget: 3,
    },
    quote: {
      merchant_id: "m_tech",
      merchant_name: "TechDeal HK",
      category: "electronics",
      unit_price_hkd: 199,
    },
  });
  assert.equal(d.channel, "cooldown");
  assert.equal(d.downgradedByBudget, true);
  assert.ok(d.triggeredRules.includes(RULE.NEW_CATEGORY));
  assert.ok(d.triggeredRules.includes(RULE.INTERRUPT_BUDGET_EXHAUSTED));
  assert.ok(d.userFacingReason.includes("不再打扰你"));
});

// ===========================================================================
// 优先级 —— 评委一定会问「如果同时满足好几条呢？」
// ===========================================================================

test("T16 优先级：decline 压过 cooldown", () => {
  const d = judge({
    quote: {
      merchant_id: "m_tech",
      category: "electronics",
      fps_id: "9998887",
    },
  });
  assert.equal(d.channel, "decline");
  assert.ok(d.triggeredRules.includes(RULE.FIRST_TIME_MERCHANT)); // cooldown 也命中了
  assert.ok(d.triggeredRules.includes(RULE.HIGH_RISK_FPS_ID));
  assert.equal(d.primaryReasonRule, RULE.HIGH_RISK_FPS_ID);
});

test("T17 优先级：cooldown 压过 ask_once", () => {
  const d = judge({
    history: {
      category_stats: { electronics: { count: 5, median_hkd: 150 } },
    },
    quote: {
      merchant_id: "m_tech",
      category: "electronics",
      unit_price_hkd: 199,
      refundable: false,
    },
  });
  assert.equal(d.channel, "cooldown");
  assert.ok(d.triggeredRules.includes(RULE.FIRST_TIME_MERCHANT));
  assert.ok(d.triggeredRules.includes(RULE.NOT_REFUNDABLE));
  assert.equal(d.primaryReasonRule, RULE.FIRST_TIME_MERCHANT);
});

test("T18 多规则同时触发：全部记录，只讲最重要的两条", () => {
  const d = judge({
    quote: {
      merchant_id: "m_tech",
      category: "electronics",
      unit_price_hkd: 199,
      refundable: false,
    },
  });
  assert.equal(d.channel, "cooldown");
  for (const r of [
    RULE.FIRST_TIME_MERCHANT,
    RULE.NOT_REFUNDABLE,
    RULE.NEW_CATEGORY,
  ]) {
    assert.ok(d.triggeredRules.includes(r), `缺少 ${r}`);
  }
  assert.ok(d.userFacingReason.startsWith("和你过去几单不同："));
  assert.ok(d.userFacingReason.includes("第一次在"));
  assert.ok(d.userFacingReason.includes("不可退"));
});

test("T20 类别偏好「即时」不会压制资金保险丝", () => {
  const d = judge({
    quote: {
      merchant_id: "m_brew",
      category: "food",
      unit_price_hkd: 600,
    },
  });
  assert.equal(d.channel, "cooldown");
  assert.ok(d.triggeredRules.includes(RULE.POCKET_WALLET_EXCEEDED));
  assert.ok(d.triggeredRules.includes(RULE.ABOVE_COOLDOWN_THRESHOLD));
});

test("T21 打扰额度没用完时，仍然会问", () => {
  const d = judge({
    mandate: { trusted_merchants: ["m_brew", "m_tech"], interrupts_used_this_week: 1 },
    quote: {
      merchant_id: "m_tech",
      merchant_name: "TechDeal HK",
      category: "electronics",
      unit_price_hkd: 199,
    },
  });
  assert.equal(d.channel, "ask_once");
  assert.equal(d.downgradedByBudget, false);
});
