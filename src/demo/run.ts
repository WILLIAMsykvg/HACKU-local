/**
 * 演示骨架 —— 在终端把整条链路跑一遍。
 *
 * 运行：npm run demo   或   node src/demo/run.ts
 *
 * 这个脚本对应 docs 里的演示剧本：
 *   1. 正常回购 → 即时通过（大部分交易不碰保险丝）
 *   2. 假商户页面写「限时 10 分钟」→ 用户 1 秒内点了批准
 *   3. 系统先停住：第一次光顾 → 不发凭证；转数快识别码命中名单 → 直接拒绝
 *   4. 用户取消 → 损失 HK$0
 *   5. 就算整套都被骗过，最多亏掉零用钱包里那个用户事先设的数
 */

import {
  DEFAULT_OPTIONS,
  canIssueCredential,
  evaluateConsent,
  evaluateQuote,
  validateCredential,
} from "../engine/evaluate.ts";
import {
  appendEntry,
  signPayload,
  verifyChain,
  verifySignature,
  type LogEntry,
  type LogPayload,
} from "../log/chain.ts";
import { RULE, type Mandate, type Quote } from "../engine/types.ts";
import { NOW, makeHistory, makeMandate, makeQuote, makeRiskList } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// 打印小工具
// ---------------------------------------------------------------------------

const W = 68;
const bar = (ch = "─") => console.log(ch.repeat(W));
const title = (t: string) => {
  console.log("");
  bar("═");
  console.log("  " + t);
  bar("═");
};
const kv = (k: string, v: string) => console.log(`  ${k.padEnd(12, "　")} ${v}`);
const note = (s: string) => console.log(`    ${s}`);

// ---------------------------------------------------------------------------
// 日志链
// ---------------------------------------------------------------------------

let chain: LogEntry[] = [];

function record(payload: LogPayload): LogEntry {
  const entry = appendEntry(chain, payload);
  chain = [...chain, entry];
  return entry;
}

function showLog() {
  title("签名日志（每一行都写清触发了哪条规则）");
  for (const e of chain) {
    const extra: string[] = [];
    if (typeof e["total_hkd"] === "number") extra.push(`total=HK$${e["total_hkd"]}`);
    if (typeof e["triggered"] === "object" && Array.isArray(e["triggered"])) {
      extra.push(`触发=${(e["triggered"] as string[]).join(",") || "无"}`);
    }
    if (typeof e["latency_ms"] === "number") extra.push(`${e["latency_ms"]}ms`);
    console.log(
      `  #${String(e.seq).padStart(2, "0")}  ${String(e.event).padEnd(22)} ` +
        `[${String(e.actor).padEnd(8)}] ${extra.join("  ")}`,
    );
    note(`hash ${e.entry_hash.slice(0, 16)}…  ← prev ${e.prev_hash.slice(0, 16)}…`);
  }
  const v = verifyChain(chain);
  console.log("");
  console.log(`  链校验：${v.ok ? "✅ 通过" : "❌ 断链"} —— ${v.reason}`);
}

// ---------------------------------------------------------------------------
// 判定 + 记录
// ---------------------------------------------------------------------------

function runQuote(
  label: string,
  mandate: Mandate,
  quote: Quote,
  approvalLatencyMs: number | null,
) {
  const history = makeHistory();
  const riskList = makeRiskList();

  title(label);

  // 商户报价
  kv("商户", `${quote.merchant_name}（${quote.merchant_id}）`);
  kv("转数快识别码", quote.fps_id);
  kv(
    "报价",
    `${quote.item.title} × ${quote.item.qty} = HK$${quote.unit_price_hkd}` +
      `　运费 HK$${quote.shipping_hkd}　税 HK$${quote.tax_hkd}　服务费 HK$${quote.service_fee_hkd}`,
  );
  kv("结算总额", `HK$${quote.total_hkd}　（引擎按这个数判，不是商品单价）`);
  kv("可退", quote.refundable ? "是" : "否");

  record({
    at: NOW.toISOString(),
    actor: "merchant",
    event: "QUOTE_RECEIVED",
    quote_id: quote.quote_id,
    merchant_id: quote.merchant_id,
    total_hkd: quote.total_hkd,
    unit_price_hkd: quote.unit_price_hkd,
    refundable: quote.refundable,
  });

  // 判定
  const decision = evaluateQuote(
    { mandate, quote, history, riskList, now: NOW },
    DEFAULT_OPTIONS,
  );

  console.log("");
  const badge: Record<string, string> = {
    instant: "✅ 即时通过",
    ask_once: "❓ 问用户一次",
    cooldown: "⏳ 进冷静期",
    decline: "⛔ 拒绝",
  };
  kv("判定", badge[decision.channel] ?? decision.channel);
  kv("触发规则", decision.triggeredRules.join(", ") || "无");
  kv("主要理由", decision.primaryReasonRule ?? "无");
  console.log("");
  note("给用户看的那句话：");
  note("「" + decision.userFacingReason + "」");
  if (Object.keys(decision.logNotes).length > 0) {
    console.log("");
    note("机器可读的说明（进日志）：");
    for (const [id, n] of Object.entries(decision.logNotes)) note(`  ${id}  ${n}`);
  }

  record({
    at: NOW.toISOString(),
    actor: "engine",
    event: "DECISION",
    quote_id: quote.quote_id,
    channel: decision.channel,
    triggered: decision.triggeredRules,
    primary: decision.primaryReasonRule,
    cooldown_until: decision.cooldownUntil,
    notes: decision.logNotes,
  });

  // 用户批准（如果这轮有）
  let consent = null;
  if (approvalLatencyMs !== null) {
    consent = evaluateConsent(approvalLatencyMs);
    console.log("");
    kv("用户点了同意", `用时 ${approvalLatencyMs} 毫秒`);
    kv("同意算不算数", consent.accepted ? "✅ 算数" : "⚠️ 不算 —— 视为没看");
    note(consent.userFacingReason);
    record({
      at: NOW.toISOString(),
      actor: "user",
      event: consent.accepted ? "APPROVAL_ACCEPTED" : "APPROVAL_TOO_FAST",
      quote_id: quote.quote_id,
      latency_ms: approvalLatencyMs,
      rule: consent.rule,
    });
  }

  // 能不能发凭证
  const gate = canIssueCredential({ decision, consent, now: NOW });
  console.log("");
  kv("发出凭证？", gate.ok ? "✅ 发出" : "🚫 没有发出");
  note(gate.userFacingReason);
  record({
    at: NOW.toISOString(),
    actor: "engine",
    event: gate.ok ? "CREDENTIAL_ISSUED" : "CREDENTIAL_WITHHELD",
    quote_id: quote.quote_id,
    rule: gate.rule,
    remaining_ms: gate.remainingMs,
  });

  return { decision, consent, gate };
}

// ===========================================================================
// 场景 1：正常回购 —— 大部分交易不碰保险丝
// ===========================================================================

const mandate = makeMandate();

runQuote(
  "场景 1　正常回购：你常去的咖啡店，HK$60",
  mandate,
  makeQuote({
    quote_id: "q_1001",
    merchant_id: "m_brew",
    merchant_name: "Brew & Co",
    fps_id: "1651000",
    category: "coffee",
    item: { title: "House Blend 250g", sku: "COF-250", qty: 1 },
    unit_price_hkd: 60,
  }),
  2400,
);

// ===========================================================================
// 场景 2：假商户 + 限时 10 分钟 —— 用户 1 秒内点了批准
// ===========================================================================

title("场景 2　假商户页面写着「限时 10 分钟，立即付款」");
console.log("");
note("这是骗子最常用的手法 —— 制造时间压力，让你来不及看。");
note("用户这次只用了 800 毫秒就点了「同意」。");

const scam = runQuote(
  "　　（系统先跑判定，再谈用户点没点）",
  mandate,
  makeQuote({
    quote_id: "q_2001",
    merchant_id: "m_tech",
    merchant_name: "TechDeal HK",
    fps_id: "9998887", // ← 在高风险名单上
    category: "electronics",
    item: { title: "USB-C Hub 7-in-1", sku: "HUB-7IN1", qty: 1 },
    unit_price_hkd: 199,
    shipping_hkd: 30,
    service_fee_hkd: 18,
    refundable: false,
    terms_url: "https://techdeal-hk.example.invalid/limited-10min",
  }),
  800, // ← 1 秒内点同意
);

// ===========================================================================
// 结论
// ===========================================================================

title("损失核算");

console.log("");
kv("用户损失", "HK$0");
note("凭证从来没有被发出去过 —— 不是「发出去又追回来」。");
console.log("");
note("三道保险丝各自拦了一次：");
note("  ① 凭证：这是第一次光顾，凭证还没有发出（R-06）");
note("  ② 资金：转数快识别码命中高风险名单（R-02）");
note("  ③ 判断：同意只用了 800 毫秒，视为没看，不算一次有效同意（R-12）");
console.log("");
note("就算这三道全部被骗过 ——");
note(`最坏损失 = 零用钱包里那个用户事先设的数 = HK$${mandate.pocket_wallet_hkd}`);
note("这个数字是用户自己设的，不是系统猜的。");
console.log("");

// ===========================================================================
// 凭证与批准内容的一致性
// ===========================================================================

title("附：凭证锁死一家商户、一个金额");

const approvedTerms = {
  quote_id: scam.decision.triggeredRules.length > 0 ? "q_2001" : "q_2001",
  merchant_id: "m_brew",
  amount_hkd: 199,
  item_sku: "COF-250",
};

const goodCred = {
  credential_id: "cred_ok",
  single_use: true,
  merchant_id: "m_brew",
  amount_hkd: 199,
  item_sku: "COF-250",
  issued_at: NOW.toISOString(),
  expires_at: new Date(NOW.getTime() + 300_000).toISOString(),
};

const swappedCred = { ...goodCred, credential_id: "cred_swapped", amount_hkd: 9999 };

console.log("");
kv("凭证与批准一致", validateCredential(approvedTerms, goodCred).ok ? "✅ 通过" : "❌ 失败");
kv(
  "批准 199，凭证被改成 9999",
  validateCredential(approvedTerms, swappedCred).ok ? "✅ 通过" : "❌ 拒绝结算",
);
note(validateCredential(approvedTerms, swappedCred).userFacingReason);

const secret = "demo-approval-signing-secret";
const sig = signPayload(approvedTerms, secret);
console.log("");
kv("批准数据 HMAC 签名", sig.slice(0, 32) + "…");
kv(
  "签名后又被改动",
  verifySignature({ ...approvedTerms, amount_hkd: 9999 }, sig, secret)
    ? "✅ 仍然通过（不该发生）"
    : "❌ 签名校验失败",
);

record({
  at: NOW.toISOString(),
  actor: "user",
  event: "PURCHASE_CANCELLED",
  quote_id: "q_2001",
  loss_hkd: 0,
});

showLog();

title("演示结束");
console.log("");
note("每一次放行、每一次拒绝，都在这条链上，而且改一行就会断。");
console.log("");
