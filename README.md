# 代理替你付款，个人背景不出手机

> **过去的支付用隐私换安全；我们让安全在本地被证明，隐私留在原地。**

HacKU 2026 · FinTech 第 1 题「Give a Machine a Wallet – Agentic Commerce」（HKT 赞助）· 队伍 23「Local deployment」

**English summary.** A shopping agent finds a real product in real Hong Kong Shopify stores and puts it in the store's real cart — but it has no payment tool and never sees the user's location, purchase history or card. Before any money moves, three issuers each answer one fixed yes/no question and sign it: *is the device near the ship-to address* (computed on the device; coordinates never leave it), *how recently did the holder strongly authenticate* (bank), and *does this order match the store's listing and the buyer's habits* (merchant). The phone combines the signed answers into a score using a public table; the bank re-computes it from the signatures and never trusts the stated number. Attestations can only make a transaction stricter — the existing rule engine's caps, mandate expiry and cooldowns always win. Every step is written to a hash-chained log.

---

## 一句话

代理替你付款前，定位、银行、商户各自只回答一个固定的是非题并签名。手机按公开表合成分数，银行自己重算。个人背景不出手机，只出签过名的结论。结论只能让交易更严，突破不了你设的上限。

## 跑起来

要求 Node.js **≥ 23.6**（直接跑 TypeScript）。

```bash
npm install
npm run build        # 打包前端到 web/dist
npm start            # http://localhost:8787
npm test             # 61 条测试，不需要网络
```

开发时：`npm run dev`（服务器，改代码自动重启）+ `npm run dev:web`（前端，http://localhost:5173）。

可选的环境变量放在根目录 `.env`（已被 `.gitignore` 排除）：

| 名称 | 作用 | 不配置时 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 模式的代理 | 只有脚本模式 |
| `TAVILY_API_KEY` | 在白名单网店里联网搜索 | 用本地快照 `data/catalog.snapshot.json` |
| `SERPAPI_KEY` | 全网参考价用 Google Shopping（香港） | 用 Tavily 摘要，或不显示 |
| `STRIPE_SECRET_KEY` | `sk_test_` 开头，Stripe 测试模式结算 | 模拟结算 |
| `DEMO_ACCESS_CODE` | 公开部署时，DeepSeek 模式要输入的访问码 | 不需要访问码 |
| `PORT` | 端口 | 8787 |

## 一笔交易怎么走

1. **代理**（`src/agent/`）只有五个工具：在白名单网店搜索、比价、确认此刻价格和库存、放进店家的真购物车、交给手机和银行验证。没有付款工具；没比价过的商品放不进购物车。脚本模式每一步写死，演示用；DeepSeek 模式由模型自己决定，每笔最多 10 次工具调用。
2. **真实网店**（`src/shop/`）：只用香港 Shopify 店公开开放的数据——商品的价格、库存、规格，以及购物车链接。不提交订单、不填付款资料、不绕过任何防护，每家店的请求有最小间隔。白名单有电子配件店和礼品店，类别按店决定。
3. **比价**（`src/shop/compare.ts`，规则公开）：先排除缺货、超预算、规格不符的，写明各自差在哪；剩下的按总价从低到高排；相差不到 HK$10 时熟客店优先（少问你一次）；卖家付费不影响排序。附覆盖报告（每家白名单店搜到没有），以及全网参考价（`SERPAPI_KEY` 时用 Google Shopping，否则用 Tavily 摘要；只看不买）。
4. **发证方**（`src/attest/`）各自只回答一个固定问题，用 Ed25519 签名：

   | 发证方 | 固定问题 | 演示里是 |
   |---|---|---|
   | 定位 | 此刻是否在收货地 5 公里内 | **在浏览器里用设备真实位置本地比对**，设备自己的钥匙签（WebCrypto）。坐标不离开设备。正式版由运营商签 |
   | 银行 | 本人最近一次强认证的时间 | 模拟的指纹 / 面容按钮。强度随时间衰减：2 小时内强、12 小时内中、24 小时内弱、之后失效 |
   | 商户 | 这一单的商品、价格、库存是否与本店此刻一致 | **当场重新读店里的公开数据**。对不上直接不发凭证 |
   | 商户 | 这一单是否符合此人在本店的购买习惯 | 规则是真的，购买记录是演示数据 |

5. **手机**把结论原样交出，附上按公开表（`src/attest/questions.ts`）算出的分数。
6. **银行**（`src/attest/verify.ts`）逐项检查：每题一份、钥匙在信任名单里、签名对得上、签的是这一单（订单编号覆盖商户、商品、数量、金额、收货地）、问题在公开表里、价格库存一致、分数重算一致。过期的那一份按缺失计 0 分。
7. **规则引擎**（`src/engine/`，莫森写的，规格见 `docs/rules.md`）照常判定：单笔上限、7 天上限、首单冷静期、1 秒内点同意不算……**最终通道 = 引擎和证明层中更严的那个**。证明不成立一律拒绝，不发凭证。
8. **付款**（`src/pay/`）：放行后发一次性凭证，锁死商户和金额。选卡是规则不是模型：第一次光顾的商户不走转数快（付出去追不回）；只有带出处和截图时间的回赠条款才参与比较，否则不按回赠选。结算走 Stripe 测试模式或模拟。
9. **日志**（`src/log/chain.ts`）：每一步写进哈希链。先记下代理被允许做什么，再记下它被拦住。不写坐标、购买明细、密钥。

## 演示里可以试的攻击

| 攻击 | 结果 |
|---|---|
| 商品页藏了劫持指令，代理把收货地改成深圳仓 | 定位答「否」，停下来问你一次，并说出原因 |
| 结论签完之后再改收货地 | 订单编号对不上，拒绝 |
| 重放上一单的结论 | 订单编号对不上，拒绝 |
| 丢掉回答为「否」的结论 | 缺的按 0 分，照样变严 |
| 把分数改成 100 | 银行重算对不上，拒绝 |
| 买 4 个（HK$876） | 超过单笔上限 HK$800，分数再高也拒绝 |
| 把时钟拨到强认证 13 小时后 | 授权变弱，进冷静期 |
| 一键撤销授权 | 授权过期，拒绝 |

## 不变量

1. 引擎和证明层不调用模型，任何测试都不需要网络。
2. 引擎和证明层不读外部状态，`now` 也是参数。
3. 每一次判定都写一条日志。
4. 证明层只能让交易更严。
5. 代理没有付款工具。

## 目录

```
src/
  engine/   规则引擎（R-00 至 R-15）
  attest/   证明层：固定问题、签名、计分、验证、接到引擎
  agent/    代理：DeepSeek 调用、四个工具、外层循环、脚本模式
  shop/     白名单网店、Shopify 公开数据、Tavily 搜索、本地快照
  pay/      选卡规则、一次性凭证、Stripe 测试模式
  server/   node:http 服务器、每个访客一套演示状态
  log/      规范化、哈希链
web/        前端（Vite、React、Tailwind）。直接复用 src/ 里的计分和规范化代码
tests/      engine T01–T21 · chain C01–C07 · attest A01–A21 · pay-agent P01–P12（含比价）
data/       本地商品快照、卡片条款（回赠数字只填亲自截图过的）
docs/       引擎规格、计划书
```

## 哪些是真的，哪些是模拟的

- **真的：** 商品、价格、库存、购物车链接（真实香港 Shopify 网店）；定位比对（设备真实位置，本地计算）；Ed25519 签名与验签；分数重算；规则引擎；一次性凭证；哈希链。
- **模拟的：** 指纹 / 面容确认；定位结论由设备自证（正式版由运营商签）；商户的购买记录；结算（Stripe 测试模式或模拟），不涉及真钱。
- **没做：** 真的发卡行接入、真的通行密钥、真实下单。

## 已知边界

- 手机被控制时，设备自证的定位可以造假。正式版由运营商签；就算造假，也突破不了授权上限。
- 运费 Shopify 商品数据里没有，报价按 0 计，以结账页为准。
- 加分表的权重是人设的，不是训练出来的。
- 用户本人在场、情况相符、清醒地被骗时，系统会放行。我们保证的是上限，而不是零损失。
- 所有费率、回赠、积分价值必须由队伍亲自截图并打时间戳，不能估。

## 出处

- 开源库：React、Vite、Tailwind CSS、TypeScript（均为 MIT 许可）。引擎、证明层、服务器只用 Node 自带模块。
- 服务：DeepSeek API（代理）、Tavily Search API（发现商品页）、Shopify 店铺公开的 `/products/*.js`、`/products.json`、`/cart/*` 端点、Stripe 测试模式。
- 白名单网店：THINKTHING STUDIO（www.thinkthingstudio.com）、GP Batteries Hong Kong（hk.gpbatteries.com）、StephyDesignHK（www.stephydesignhk.com），用 `/meta.json` 核对过店址在香港、币种港币。
- 比价的设计参考了 [NorthCinder](https://github.com/AIXploits/northcinder)：推荐理由、淘汰原因、覆盖报告，看到的报价要经商户正式接口确认才能下单。
