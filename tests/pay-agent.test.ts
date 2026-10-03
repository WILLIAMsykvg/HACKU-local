/**
 * 选卡规则与脚本代理的解析 —— P01 ~ P06
 *
 * 不联网：只测纯函数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBudget, parseQty, scriptedQuery } from "../src/agent/harness.ts";
import { chooseCard, type PaymentCard } from "../src/pay/cards.ts";
import { compareOffers } from "../src/shop/compare.ts";
import { isSameProduct, parseHkd } from "../src/shop/reference.ts";
import { tokens } from "../src/shop/search.ts";
import type { Listing } from "../src/shop/shopify.ts";

function card(o: Partial<PaymentCard> & Pick<PaymentCard, "card_id" | "network">): PaymentCard {
  return {
    label: o.card_id,
    issuer: null,
    online_rebate_percent: null,
    rule_text: null,
    source_url: null,
    captured_at: null,
    screenshot: null,
    ...o,
  };
}

const MC = card({ card_id: "mc", network: "mastercard" });
const UP = card({ card_id: "up", network: "unionpay" });
const FPS = card({ card_id: "fps", network: "fps" });

test("P01 第一次光顾的商户不走转数快", () => {
  const c = chooseCard([FPS, MC], { firstTimeMerchant: true });
  assert.equal(c.card.card_id, "mc");
  assert.ok(c.considered.some((x) => x.card_id === "fps" && x.note.includes("追不回")));
});

test("P02 没有核实过的回赠数据时不按回赠选，用信用卡", () => {
  const c = chooseCard([FPS, UP, MC], { firstTimeMerchant: false });
  assert.notEqual(c.card.network, "fps");
  assert.ok(c.reason.includes("不按回赠选"));
});

test("P03 回赠数字没有出处（网址或截图时间）就当作没有", () => {
  const unsourced = card({ card_id: "up", network: "unionpay", online_rebate_percent: 9 });
  const c = chooseCard([MC, unsourced], { firstTimeMerchant: false });
  assert.equal(c.card.card_id, "mc");
});

test("P04 有出处的回赠条款时选回赠最高的，并写明出处和时间", () => {
  const sourced = card({
    card_id: "up",
    network: "unionpay",
    online_rebate_percent: 2,
    source_url: "https://example.invalid/terms",
    captured_at: "2026-10-04T00:30:00+08:00",
  });
  const c = chooseCard([MC, sourced], { firstTimeMerchant: false });
  assert.equal(c.card.card_id, "up");
  assert.ok(c.reason.includes("https://example.invalid/terms"));
  assert.ok(c.reason.includes("2026-10-04T00:30:00+08:00"));
});

test("P05 脚本代理从一句话里取出预算和搜索词", () => {
  assert.equal(parseBudget("帮我买一个 HK$300 以内的 65W 充电器"), 300);
  assert.equal(parseBudget("预算 250 蚊"), 250);
  assert.equal(parseBudget("帮我买充电器"), undefined);
  assert.equal(scriptedQuery("帮我买一个 HK$300 以内的 65W 充电器"), "65W USB-C charger");
  assert.equal(scriptedQuery("买条 USB-C 数据线"), "USB-C cable");
});

test("P06 数量只认 1 到 5，瓦数不会被当成数量", () => {
  assert.equal(parseQty("帮我买 4 个 65W 充电器"), 4);
  assert.equal(parseQty("帮我买一个 65W 充电器"), 1);
  assert.equal(parseQty("买 9 个"), 1);
  assert.equal(parseQty("买 2 份礼物"), 2);
});

test("P07 礼品类的搜索词保留中文，不加 USB-C", () => {
  assert.equal(scriptedQuery("帮我挑一份 HK$250 以内的丝巾礼物"), "絲巾");
  assert.equal(scriptedQuery("送朋友的礼物"), "禮盒");
});

test("P08 中文按两个字切词，简体能对上繁体", () => {
  const t = tokens("丝巾礼盒");
  assert.ok(t.includes("絲巾"));
  assert.ok(t.includes("禮盒"));
});

test("P13 参考价：品牌对上才算同款", () => {
  const ours = "GP 65W GaN Charger 3-ports USB-C & USB-A";
  assert.equal(isSameProduct(ours, "GP 65W USB-C 及 USB-A GaN三接口快速充電器"), true);
  assert.equal(isSameProduct(ours, "GP 超霸 65W USB-C 及 USB-A GaN三接口快速充電器"), true);
  assert.equal(isSameProduct(ours, "Xiaomi 我的快速充电器 Gan技术 65w"), false);
  assert.equal(isSameProduct(ours, "Ugreen CD316 65W 3-Port PD GaN Fast Charger"), false);
});

test("P09 从摘要里解析港币价格", () => {
  assert.equal(parseHkd("售價 HK$1,299.00 免運")?.value, 1299);
  assert.equal(parseHkd("HKD 219")?.value, 219);
  assert.equal(parseHkd("US$29"), null);
});

// ===========================================================================
// 比价
// ===========================================================================

function listing(o: Partial<Listing> & Pick<Listing, "merchant_id" | "title" | "price_hkd">): Listing {
  return {
    merchant_name: o.merchant_id,
    domain: `${o.merchant_id}.example`,
    handle: o.title,
    product_type: "",
    variant_id: `v_${o.title}`,
    variant_title: "Default",
    available: true,
    url: `https://${o.merchant_id}.example/products/${encodeURIComponent(o.title)}`,
    fetched_at: "2026-10-04T01:00:00+08:00",
    source: "live",
    ...o,
  };
}

const STORES_FOR_TEST = [
  { merchant_id: "m_a", name: "A" },
  { merchant_id: "m_b", name: "B" },
  { merchant_id: "m_c", name: "C" },
];

test("P10 比价：淘汰缺货、超预算、规格不符的，并写明原因", () => {
  const cmp = compareOffers(
    [
      listing({ merchant_id: "m_a", title: "65W Charger", price_hkd: 219 }),
      listing({ merchant_id: "m_a", title: "65W Charger Pro", price_hkd: 399 }),
      listing({ merchant_id: "m_b", title: "30W Charger", price_hkd: 149 }),
      listing({ merchant_id: "m_b", title: "65W Mini", price_hkd: 199, available: false }),
    ],
    { query: "65W charger", max_price_hkd: 300, must_include: ["65W"], qty: 1 },
    { trustedMerchants: [], stores: STORES_FOR_TEST },
  );
  assert.equal(cmp.pick?.listing.title, "65W Charger");
  assert.equal(cmp.rejected.length, 3);
  assert.ok(cmp.rejected.find((r) => r.listing.title === "65W Charger Pro")?.missed[0]?.includes("超过预算"));
  assert.ok(cmp.rejected.find((r) => r.listing.title === "30W Charger")?.missed[0]?.includes("65W"));
  assert.ok(cmp.rejected.find((r) => r.listing.title === "65W Mini")?.missed.includes("缺货"));
});

test("P11 比价：价格差不到 HK$10 时熟客店优先，差得多就选便宜的", () => {
  const close = compareOffers(
    [listing({ merchant_id: "m_a", title: "X", price_hkd: 215 }), listing({ merchant_id: "m_b", title: "Y", price_hkd: 219 })],
    { query: "", qty: 1 },
    { trustedMerchants: ["m_b"], stores: STORES_FOR_TEST },
  );
  assert.equal(close.pick?.listing.merchant_id, "m_b");

  const far = compareOffers(
    [listing({ merchant_id: "m_a", title: "X", price_hkd: 180 }), listing({ merchant_id: "m_b", title: "Y", price_hkd: 219 })],
    { query: "", qty: 1 },
    { trustedMerchants: ["m_b"], stores: STORES_FOR_TEST },
  );
  assert.equal(far.pick?.listing.merchant_id, "m_a");
  assert.ok(far.pick?.reasons[0]?.includes("39"));
});

test("P12 比价：覆盖报告照实列出每家店", () => {
  const cmp = compareOffers(
    [listing({ merchant_id: "m_a", title: "65W", price_hkd: 219 }), listing({ merchant_id: "m_b", title: "30W", price_hkd: 149 })],
    { query: "", must_include: ["65W"], qty: 1 },
    { trustedMerchants: [], stores: STORES_FOR_TEST, failedMerchants: ["m_c"] },
  );
  const by = Object.fromEntries(cmp.coverage.map((c) => [c.merchant_id, c.status]));
  assert.deepEqual(by, { m_a: "matched", m_b: "no_match", m_c: "failed" });
});
