# 规则引擎规格 + 测试矩阵

> HacKU 2026 · FinTech 第 1 题 · 队伍 23「Local deployment」
> 状态：**引擎规格（可执行）** · 建立于 Day 1
> 依据：`HacKU-2026-FinTech-思路.md` 第 111 行起的架构图，及第 177 行「先做规则引擎和测试」

---

## 0. 一句话

规则引擎是一个**纯函数**：输入「授权 + 商户最终报价 + 用户历史」，输出「通道 + 触发的规则编号 + 给用户看的那一句话」。**它不调用任何模型。**

---

## 1. 三份输入

### 1.1 `Mandate`（授权）— 用户事先设定，长期有效

```jsonc
{
  "mandate_id": "mnd_001",
  "user_id": "u_yeung",
  "currency": "HKD",

  // 零用钱包：代理平时只能动这么多
  "pocket_wallet_hkd": 500,

  // 超过这个数 → 冷静期
  "cooldown_threshold_hkd": 300,

  // 硬上限
  "per_txn_cap_hkd": 800,
  "rolling_7d_cap_hkd": 2000,

  // 用户可以按类别自己调快慢
  "category_policy": {
    "food": "instant",
    "electronics": "cooldown",
    "default": "ask_once"
  },

  // 商户
  "merchant_allowlist": ["m_brew", "m_tech", "m_book"],
  "trusted_merchants": ["m_brew"],       // 「每家商户只慢一次」

  // 同意预算
  "weekly_interrupt_budget": 3,
  "interrupts_used_this_week": 1,

  "expires_at": "2026-10-04T13:00:00+08:00"
}
```

### 1.2 `Quote`（商户最终报价）— 每笔交易一份

```jsonc
{
  "quote_id": "q_8891",
  "merchant_id": "m_tech",
  "merchant_name": "TechDeal HK",
  "fps_id": "1651234",                   // 转数快识别码，用于查高风险名单
  "category": "electronics",

  "item": { "title": "USB-C Hub", "sku": "HUB-7IN1", "qty": 1 },

  // 报价明细 —— 引擎必须用 total 重算，不能用 unit_price
  "unit_price_hkd": 199,
  "shipping_hkd": 30,
  "tax_hkd": 0,
  "service_fee_hkd": 18,
  "total_hkd": 247,

  "refundable": false,
  "quote_captured_at": "2026-10-02T17:40:12+08:00",
  "terms_url": "https://...",
  "terms_snapshot_sha256": "…"
}
```

> **为什么必须重算 total**：题目点名要演示 *"结算时运费和税把总额推过上限"*。引擎读 `total_hkd`，并在日志里记下「报价时是 199，结算时变 247」。

### 1.3 `UserHistory`（用户历史）— 用于算异常

```jsonc
{
  "user_id": "u_yeung",
  "category_stats": {
    "food":        { "count": 42, "median_hkd": 85 },
    "electronics": { "count": 0 }
  },
  "purchases_last_7d": [
    { "at": "2026-10-01T12:03:00+08:00", "total_hkd": 120 },
    { "at": "2026-10-02T09:15:00+08:00", "total_hkd": 88 }
  ],
  "last_approval_latency_ms": 820     // 用户上一次点同意的反应时间
}
```

---

## 2. 输出

```jsonc
{
  "channel": "instant" | "ask_once" | "cooldown" | "decline",
  "triggered_rules": ["R-06", "R-08"],
  "primary_reason_rule": "R-06",
  "user_facing_reason": "和你过去几单不同：这次是第一次光顾这家店，而且不可退。",
  "log_notes": { "R-06": "merchant m_tech not in trusted_merchants" }
}
```

**通道优先级（最严的赢）**：

```
decline  >  cooldown  >  ask_once  >  instant
```

---

## 3. 规则表

| ID | 名称 | 触发条件 | 输出通道 | 属于哪条保险丝 |
|---|---|---|---|---|
| `R-00` | 授权已过期 | `now > mandate.expires_at` | **decline** | 凭证 |
| `R-01` | 商户不在白名单 | `merchant_id ∉ allowlist ∪ trusted` | **decline** | 凭证 |
| `R-02` | 命中高风险名单 | `fps_id ∈ risk_list` | **decline** | 资金 |
| `R-03` | 类别被禁 | `category_policy[cat] == "blocked"` | **decline** | 判断 |
| `R-04` | 单笔超硬上限 | `total > per_txn_cap_hkd` | **decline** | 凭证 |
| `R-05` | 超出零用钱包 | `total > pocket_wallet_hkd` | **cooldown** | 资金 |
| `R-06` | 第一次光顾该商户 | `merchant_id ∉ trusted_merchants` | **cooldown** | 资金 |
| `R-07` | 超过冷静期门槛 | `total > cooldown_threshold_hkd` | **cooldown** | 资金 |
| `R-08` | 不可退 | `refundable == false` | **ask_once** | 判断 |
| `R-09` | 价格异常 | `total > 3 × category_stats[cat].median_hkd` | **ask_once** | 判断 |
| `R-10` | 新类别 | `category_stats[cat].count == 0` | **ask_once** | 判断 |
| `R-11` | 同意预算用尽 | `interrupts_used ≥ weekly_interrupt_budget` | **降级**：把 `ask_once` 改成 `cooldown` | 判断 |
| `R-12` | 同意点太快 | `approval_latency_ms < 1000` | **hold**（暂缓执行，不进凭证） | 同意 |
| `R-13` | 滚动 7 天超上限 | `sum(purchases_last_7d) + total > rolling_7d_cap` | **decline** | 凭证 |
| `R-14` | 凭证与批准内容不符 | `cred.merchant ≠ approved.merchant` 或 `cred.amount ≠ approved.amount` | **fail** | 凭证 |
| `R-15` | 冷静期未结束 | `now < cooldown_until` | **hold** | 资金 |

### 规则设计说明

- **`R-04` 为什么是 decline 而不是 cooldown**：硬上限是授权的边界。超出边界 = 这件事不在授权范围内 = 拒绝。冷静期是「在授权范围内，但要等等」。
- **`R-11` 是「降级」不是「拒绝」**：打扰额度用尽，不代表交易被拒，而是**把这次打扰换成冷静期**。这正是文档说的「代理必须把打扰花在最值得问的地方」。
- **`R-12` 不进凭证**：文档原文「用户在约 1 秒内就点同意，视为没看，暂缓执行」。暂缓 ≠ 拒绝，也 ≠ 通过。
- **`primary_reason_rule` 取触发规则里最严的那一条**，`user_facing_reason` 由它生成 —— 这就是「只显示那一个差别」。

---

## 4. 状态机

### 4.1 交易生命周期

```
DRAFT
  │  代理提交付款方案
  ▼
QUOTED ────► DECLINED        （R-00/01/02/03/04/13）
  │
  ├────────► AWAITING_COOLDOWN （R-05/06/07/11降级）
  │              │ 冷静期结束
  │              ▼
  ├────────► AWAITING_APPROVAL （R-08/09/10）
  │              │ 用户点同意
  │              ▼
  │           CONSENT_CHECK
  │              ├─ 太快（R-12）─► HELD ──► 重新确认
  │              └─ 正常
  │                      ▼
  ├────────► APPROVED
  │              │ 发凭证
  │              ▼
  │           CREDENTIAL_ISSUED
  │              │ 校验商户+金额一致（R-14）
  │              ▼
  └────────► SETTLED
```

### 4.2 冷静期

```
cooldown_until = decided_at + COOLDOWN_DURATION
冷静期内：不发凭证
冷静期内代理可以继续：比价、查商户信誉
冷静期结束：自动回到 AWAITING_APPROVAL 或直接 APPROVED
```

> **待决策**：`COOLDOWN_DURATION` 设多久？（见文末待决清单）

---

## 5. 签名日志

每一条日志都要能回答「是哪条规则让它变成这样」。

```jsonc
{
  "seq": 12,
  "at": "2026-10-02T17:41:03+08:00",
  "prev_hash": "a3f1…",
  "entry_hash": "9c02…",                 // sha256(prev_hash + canonical(payload))
  "actor": "agent" | "user" | "engine",
  "event": "QUOTE_RECEIVED | DECISION | APPROVAL_CLICKED | CONSENT_TOO_FAST | CREDENTIAL_ISSUED | CREDENTIAL_MISMATCH | SETTLED | DECLINED",
  "quote_id": "q_8891",
  "decision": {
    "channel": "decline",
    "triggered_rules": ["R-04"],
    "primary_reason_rule": "R-04"
  },
  "evidence": {
    "quoted_unit_price_hkd": 199,
    "final_total_hkd": 247,
    "per_txn_cap_hkd": 800,
    "delta_over_cap_hkd": -553
  },
  "notes": "shipping 30 + service_fee 18 pushed total above the quoted price"
}
```

---

## 6. 测试矩阵

文档里点名 7 条必测。我扩成 **18 条**，覆盖全部 16 条规则 + 优先级。

| # | 场景 | 输入要点 | 期望通道 | 期望触发 | 来源 |
|---|---|---|---|---|---|
| T01 | 回头客即时通过 | trusted 商户 + 金额 < 门槛 + 可退 | `instant` | `[]` | 文档必测 |
| T02 | 首单进冷静期 | 商户 ∉ trusted | `cooldown` | `R-06` | 文档必测 |
| T03 | 超零用钱包进冷静期 | `total > pocket_wallet` | `cooldown` | `R-05` | 文档必测 |
| T04 | 1 秒内点同意则暂缓 | `latency = 800ms` | `hold` | `R-12` | 文档必测 |
| T05 | 命中高风险名单则拒绝 | `fps_id ∈ risk_list` | `decline` | `R-02` | 文档必测 |
| T06 | 凭证金额与批准不符则失败 | `cred.amount = 247`，`approved = 199` | `fail` | `R-14` | 文档必测 |
| T07 | 冷静期未结束不发凭证 | `now < cooldown_until` | `hold` | `R-15` | 文档必测 |
| T08 | **结算时运费税把总额推过上限** | `unit=780`，`+shipping 30 +fee 18` → `total=828 > cap 800` | `decline` | `R-04` | ★ 题目点名 |
| T09 | 授权过期 | `now > expires_at` | `decline` | `R-00` | |
| T10 | 商户不在白名单 | 不在 allowlist 也不在 trusted | `decline` | `R-01` | |
| T11 | 滚动 7 天超上限 | 近 7 天已 1900，本单 200 | `decline` | `R-13` | |
| T12 | 不可退 → 问一次 | `refundable = false` | `ask_once` | `R-08` | |
| T13 | 价格异常 → 问一次 | 该类别中位数 85，本单 400 | `ask_once` | `R-09` | |
| T14 | 新类别 → 问一次 | `count == 0` | `ask_once` | `R-10` | |
| T15 | 同意预算用尽 → 降级 | 已用 3/3，本来要 `ask_once` | `cooldown` | `R-11` | |
| T16 | **优先级：decline 赢** | 同时触发 `R-06`(cooldown) 和 `R-02`(decline) | `decline` | `R-02` | |
| T17 | **优先级：cooldown 赢 ask_once** | 同时触发 `R-06` 和 `R-08` | `cooldown` | 两条都记，primary = `R-06` | |
| T18 | 多规则同时触发 | 首单 + 不可退 + 新类别 | 按优先级 | 三条都进 `triggered_rules` | |

### 为什么 T16/T17 重要

**演示时评委一定会问「如果同时满足好几条呢？」** 这两条测试就是答案：不是取第一条命中的，而是**全部评估、按最严的赢、全部记进日志**。

---

## 7. 目录结构建议

```
app/
  src/
    engine/
      types.ts          # Mandate / Quote / UserHistory / Decision
      rules.ts          # 规则表（数据，不是逻辑）
      evaluate.ts       # 主入口：纯函数 evaluate(mandate, quote, history)
      reasons.ts        # 规则 ID → 给用户看的那句话
    log/
      chain.ts          # 哈希链签名与校验
    store/
      json-store.ts     # 文件存储（先做这个）
    agent/
      tools.ts          # ★ 只有：搜索、入车、提交付款方案
                        #   故意不给「付款」和「提高额度」
    mock/
      merchants.ts      # 模拟商户 + 「限时 10 分钟」假页
      risk-list.ts      # 高风险 FPS ID 名单（模拟）
  tests/
    engine.test.ts      # T01–T18
  web/                  # 页面
  docs/
    rules.md            # 本文件
```

---

## 8. 待决清单（需要队伍拍板）

| # | 问题 | 影响 | 我的建议 |
|---|---|---|---|
| **D1** | 技术栈：TypeScript/Node（本机可用）还是 Python（本机不可用，要先装）？ | 决定一切 | **TypeScript** —— Node 24 本机可用，且队伍里有 JS 的人 |
| **D2** | 开发机器是不是这台？ | 如果不是，我写的代码传不过去 | 需要确认 |
| **D3** | 大模型用哪家？（OpenAI / DeepSeek / 本地模型 / 先不用） | 影响代理层 | **先做规则引擎，代理层最后接** |
| **D4** | 支付层：Stripe 测试模式（要注册）还是纯模拟？ | 影响凭证层真实度 | 先纯模拟，留出 Stripe 接口位 |
| **D5** | `COOLDOWN_DURATION` 设多久？ | 演示节奏 | **演示用 60 秒**，真实建议阶梯（首单 30 分钟 / 大额 24 小时） |
| **D6** | 零用钱包设多少钱？ | 产品决策 | 演示用 **HK$500** |
| **D7** | 第一版是否纳入「积分的负价值」模块？ | 范围 | 先不纳入，做成静态图 |
| **D8** | 项目 / 仓库名？ | 交付物 | 待定 |

---

## 9. 规则引擎的三条不变量（写测试时守住）

1. **引擎不调用模型。** 任何测试都不应该需要网络。
2. **引擎不读时间以外的外部状态。** 所有输入都通过参数传入（`now` 也是参数），方便测试和复现。
3. **每一次判定都必须产出一条日志。** 包括 `instant` 的那次 —— 记录「为什么这次不用问」和记录「为什么拒绝」一样重要。
