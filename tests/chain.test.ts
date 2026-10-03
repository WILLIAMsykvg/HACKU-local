/**
 * 签名日志测试 —— 哈希链、防篡改、HMAC。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GENESIS,
  appendEntry,
  canonicalize,
  signPayload,
  verifyChain,
  verifySignature,
  type LogEntry,
} from "../src/log/chain.ts";

function buildChain(): LogEntry[] {
  let chain: LogEntry[] = [];
  const push = (e: Parameters<typeof appendEntry>[1]) => {
    chain = [...chain, appendEntry(chain, e)];
  };
  push({
    at: "2026-10-02T17:39:00+08:00",
    actor: "merchant",
    event: "QUOTE_RECEIVED",
    quote_id: "q_0001",
    total_hkd: 247,
  });
  push({
    at: "2026-10-02T17:39:00+08:00",
    actor: "engine",
    event: "DECISION",
    quote_id: "q_0001",
    decision: { channel: "decline", triggeredRules: ["R-04"], primaryReasonRule: "R-04" },
  });
  push({
    at: "2026-10-02T17:39:01+08:00",
    actor: "user",
    event: "DECLINED_BY_USER",
    quote_id: "q_0001",
  });
  return chain;
}

test("C01 稳定序列化：键顺序不同，哈希相同", () => {
  const a = { b: 2, a: 1, nested: { y: 1, x: 2 } };
  const b = { nested: { x: 2, y: 1 }, a: 1, b: 2 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test("C02 链头是 GENESIS，序号从 0 开始", () => {
  const chain = buildChain();
  assert.equal(chain.length, 3);
  assert.equal(chain[0]!.seq, 0);
  assert.equal(chain[0]!.prev_hash, GENESIS);
  assert.equal(chain[1]!.prev_hash, chain[0]!.entry_hash);
  assert.equal(chain[2]!.prev_hash, chain[1]!.entry_hash);
});

test("C03 完整链校验通过", () => {
  const r = verifyChain(buildChain());
  assert.equal(r.ok, true);
  assert.equal(r.brokenAt, null);
});

test("C04 改动任意一条的内容 → 断链", () => {
  const chain = buildChain();
  const tampered = chain.map((e, i) =>
    i === 1 ? { ...e, total_hkd: 999_999 } : e,
  );
  const r = verifyChain(tampered);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 1);
});

test("C05 删除中间一条 → 断链", () => {
  const chain = buildChain();
  const removed = [chain[0]!, chain[2]!];
  const r = verifyChain(removed);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 1);
});

test("C06 改动 prev_hash → 断链", () => {
  const chain = buildChain();
  const tampered = chain.map((e, i) =>
    i === 2 ? { ...e, prev_hash: "f".repeat(64) } : e,
  );
  assert.equal(verifyChain(tampered).ok, false);
});

test("C07 HMAC 签名：正确密钥通过，错误密钥失败", () => {
  const payload = {
    quote_id: "q_0001",
    merchant_id: "m_brew",
    amount_hkd: 199,
    item_sku: "COF-250",
  };
  const secret = "demo-approval-signing-secret";
  const sig = signPayload(payload, secret);

  assert.equal(verifySignature(payload, sig, secret), true);
  assert.equal(verifySignature(payload, sig, "another-secret"), false);

  // 被改过的批准数据，签名对不上
  const edited = { ...payload, amount_hkd: 9999 };
  assert.equal(verifySignature(edited, sig, secret), false);
});
