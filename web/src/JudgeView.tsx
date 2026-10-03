import { useEffect, useRef, useState } from "react";

import { QUESTIONS, TIER_BOUNDS } from "../../src/attest/questions.ts";
import { computeScore } from "../../src/attest/score.ts";
import type { Bundle } from "../../src/attest/types.ts";
import { api, type AgentEvent, type Order, type State, type useLive } from "./api.ts";
import { defaultPrompt, type Agent, type Phone } from "./hooks.ts";
import { locale, t } from "./lang.ts";
import { Btn, ChannelBadge, Check, Json, Panel, Toggle, hkd, short, timeHK } from "./ui.tsx";

function examplePrompts(): string[] {
  return [
    defaultPrompt(),
    t("帮我挑一份 HK$250 以内的丝巾礼物", "Pick a silk scarf gift under HK$250"),
    t("帮我买 4 个 HK$300 以内的 65W 充电器", "Buy 4 65W chargers under HK$300 each"),
  ];
}

/** 公开问题表里的完整问题 */
export function questionText(id: string): string {
  const q = QUESTIONS.find((x) => x.id === id);
  return q ? t(q.text, q.text_en) : id;
}

/** 给用户看的短标签 */
export function questionLabel(id: string): string {
  const labels: Record<string, string> = {
    near_ship_to: t("在收货地附近", "Near the ship-to address"),
    holder_recently_authenticated: t("本人最近确认过", "You confirmed recently"),
    quote_matches_listing: t("价格和库存一致", "Price and stock match"),
    consistent_with_history: t("符合在这家店的习惯", "Fits your habits at this store"),
  };
  return labels[id] ?? id;
}

export function roleText(role: string): string {
  return ({ location: t("定位", "Location"), bank: t("银行", "Bank"), merchant: t("商户", "Store") } as Record<string, string>)[role] ?? role;
}

/** 比价理由里的「注意」提醒（同款在别处更便宜） */
export function isNotice(reason: string): boolean {
  return reason.startsWith("注意") || reason.startsWith("Note:");
}

/** 评委视图：打开引擎盖，看代理、手机、银行三方每一步 */
export function JudgeView({
  live,
  phone,
  agent,
  serverNow,
}: {
  live: ReturnType<typeof useLive>;
  phone: Phone;
  agent: Agent;
  serverNow: Date;
}) {
  const { state, config } = live;
  if (!state) return null;

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-5">
      <Header state={state} config={config} connected={live.connected} />
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <AgentPanel live={live} agent={agent} />
        <PhonePanel state={state} serverNow={serverNow} phone={phone} />
        <BankPanel order={state.current_order} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <DemoControls state={state} refresh={live.refresh} />
        <div className="lg:col-span-2">
          <LogPanel state={state} />
        </div>
      </div>
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({ state, config, connected }: { state: State; config: ReturnType<typeof useLive>["config"]; connected: boolean }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-widest text-indigo-300">
          {t("HacKU 2026 · FinTech 第 1 题 · 队伍 23 Local Deployment", "HacKU 2026 · FinTech Problem 1 · Team 23 Local Deployment")}
        </p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
          {t("代理替你付款，", "An agent pays for you; ")}
          <span className="text-indigo-300">{t("个人背景不出手机", "your context stays on your phone")}</span>
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          {t(
            "定位、银行、商户各自只回答一个固定的是非题并签名；手机按公开表合成分数，银行自己重算。结论只能让交易更严，突破不了你设的上限。",
            "Location, bank and store each sign an answer to one fixed yes/no question; the phone combines them with a public table and the bank recomputes the score. The answers can only make a payment stricter, never past the limits you set.",
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-rose-500/15 px-2.5 py-1 text-rose-200 ring-1 ring-rose-400/30">{t("演示环境 · 不涉及真实付款", "Demo · no real payments")}</span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 ring-1 ring-white/10">
          {t("商品：", "Products: ")}
          {!config ? t("检查中", "checking") : config.search_live ? t("真实香港网店（实时）", "live Hong Kong stores") : t("真实网店快照", "snapshot of real stores")}
        </span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 ring-1 ring-white/10">
          {t("参考价：", "Reference prices: ")}
          {!config
            ? t("检查中", "checking")
            : config.reference_via === "serpapi"
              ? "Google Shopping"
              : config.reference_via === "tavily"
                ? t("全网搜索摘要", "web search snippets")
                : t("无", "none")}
        </span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 ring-1 ring-white/10">
          {t("结算：", "Settlement: ")}
          {!config ? t("检查中", "checking") : config.stripe_test ? t("Stripe 测试模式", "Stripe test mode") : t("模拟", "simulated")}
        </span>
        <span className={`rounded-full px-2.5 py-1 ring-1 ${connected ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30" : "bg-amber-500/10 text-amber-300 ring-amber-400/30"}`}>
          {connected ? t("已连接", "Connected") : t("重连中", "Reconnecting")} · {t("演示时钟", "demo clock")} +{state.clock_offset_hours}h
        </span>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------------

function toolText(tool: string): string {
  const labels: Record<string, string> = {
    search_products: t("搜索白名单网店", "Search whitelisted stores"),
    compare_products: t("比价", "Compare prices"),
    get_product: t("确认此刻价格和库存", "Check current price and stock"),
    add_to_cart: t("放进店家的真购物车", "Add to the store's real cart"),
    submit_payment_plan: t("交给手机和银行验证", "Hand to the phone and bank"),
  };
  return labels[tool] ?? tool;
}

function AgentPanel({ live, agent }: { live: ReturnType<typeof useLive>; agent: Agent }) {
  const { config, agentEvents } = live;
  const { prompt, setPrompt, mode, setMode, injection, setInjection, code, setCode, error, busy } = agent;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [agentEvents.length]);

  const run = () => void agent.run();

  return (
    <Panel
      title={t("购物代理", "Shopping agent")}
      subtitle={t(
        "工具只有：搜索、比价、确认价格、放进购物车、交给你验证。没比价的放不进购物车；没有付款工具，也看不到你的位置和消费记录。",
        "Its only tools: search, compare, check price, add to cart, hand over for verification. Nothing goes in the cart without a comparison; it has no payment tool and can't see your location or history.",
      )}
      accent="bg-violet-400"
    >
      <textarea
        className="min-h-[64px] w-full resize-none rounded-lg border border-white/10 bg-black/30 p-2.5 text-sm outline-none focus:border-indigo-400"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
      />
      <div className="flex flex-wrap gap-1.5">
        {examplePrompts().map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPrompt(p)}
            disabled={busy}
            className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
          >
            {p.replace("，寄到宿舍", "").replace(", ship to my dorm", "")}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="inline-flex overflow-hidden rounded-lg ring-1 ring-white/15">
          {(["scripted", "llm"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={m === "llm" && !config?.llm_available}
              className={`px-3 py-1.5 ${mode === m ? "bg-indigo-500 text-white" : "bg-transparent text-slate-300 hover:bg-white/10"} disabled:opacity-40`}
            >
              {m === "scripted" ? t("脚本模式", "Scripted") : t("DeepSeek 模式", "DeepSeek")}
            </button>
          ))}
        </div>
        {mode === "llm" && config?.llm_requires_code && (
          <input
            className="w-28 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm"
            placeholder={t("访问码", "Access code")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
        <Btn tone="primary" onClick={run} disabled={busy || !prompt.trim()}>
          {busy ? t("代理工作中…", "Agent working…") : t("让代理去买", "Send the agent")}
        </Btn>
      </div>
      <Toggle
        checked={injection}
        onChange={setInjection}
        label={t("商品页里藏了一段劫持指令", "The product page hides a hijack instruction")}
        hint={
          mode === "scripted"
            ? t("脚本模式会照着做：把收货地改成深圳仓。用来演示代理被骗了也没用。", "Scripted mode obeys it and ships to the Shenzhen warehouse, to show that fooling the agent isn't enough.")
            : t("DeepSeek 可能识破，也可能上当。安全不押在它身上。", "DeepSeek may spot it or fall for it. Safety doesn't depend on it.")
        }
      />
      {error && <p className="rounded-lg bg-rose-500/10 p-2 text-sm text-rose-300">{error}</p>}

      <div ref={listRef} className="flex max-h-[420px] flex-col gap-2 overflow-auto pr-1">
        {agentEvents.length === 0 && <p className="text-sm text-slate-500">{t("代理每一步都会显示在这里。", "Every agent step shows up here.")}</p>}
        {agentEvents.map((e, i) => (
          <AgentStep key={i} e={e} />
        ))}
      </div>
    </Panel>
  );
}

function AgentStep({ e }: { e: AgentEvent }) {
  if (e.kind === "say") {
    return <div className="rounded-lg bg-violet-500/10 p-2.5 text-sm text-violet-100">{e.text}</div>;
  }
  const r = e.result as Record<string, unknown>;
  return (
    <div className={`rounded-lg border p-2.5 text-sm ${e.ok ? "border-white/10 bg-black/20" : "border-rose-400/30 bg-rose-500/10"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {e.n}. {toolText(e.tool)}
        </span>
        <code className="text-[11px] text-slate-500">{e.tool}</code>
      </div>
      {!e.ok && <p className="mt-1 text-rose-300">{String(r["error"])}</p>}
      {e.ok && e.tool === "search_products" && <SearchResult r={r} />}
      {e.ok && e.tool === "compare_products" && <CompareResult r={r as unknown as CompareView} />}
      {e.ok && e.tool === "get_product" && (
        <p className="mt-1 text-slate-300">
          {t(`${String(r["merchant"])}「${String(r["title"])}」`, `${String(r["merchant"])} · ${String(r["title"])} · `)}
          {hkd(Number(r["price_hkd"]))} · {r["available"] ? t("有货", "in stock") : t("缺货", "out of stock")}
          {r["merchant_note"] ? (
            <span className="mt-1 block rounded bg-rose-500/15 p-1.5 text-xs text-rose-200">
              {t("页面里藏着：", "Hidden on the page: ")}
              {String(r["merchant_note"])}
            </span>
          ) : null}
        </p>
      )}
      {e.ok && e.tool === "add_to_cart" && (
        <p className="mt-1 text-slate-300">
          {String(r["title"])} ×{String(r["qty"])} = {hkd(Number(r["subtotal_hkd"]))} ·{" "}
          <a className="text-indigo-300 underline" href={String(r["cart_url"])} target="_blank" rel="noreferrer">
            {t("打开店家的真购物车", "Open the store's real cart")}
          </a>
        </p>
      )}
      {e.ok && e.tool === "submit_payment_plan" && (
        <p className="mt-1 text-slate-300">
          {t("收货地：", "Ship to: ")}
          <b>{String((e.args as Record<string, unknown>)["ship_to_label"])}</b>
          {t("。代理的任务到此结束，付款要等你和银行。", ". The agent's job ends here; payment waits for you and the bank.")}
        </p>
      )}
    </div>
  );
}

function SearchResult({ r }: { r: Record<string, unknown> }) {
  const results = (r["results"] as { title: string; merchant: string; price_hkd: number; source: string; fetched_at: string }[]) ?? [];
  return (
    <div className="mt-1">
      <p className="text-xs text-slate-400">{String(r["note"])}</p>
      <ul className="mt-1 space-y-0.5">
        {results.map((x, i) => (
          <li key={i} className="flex justify-between gap-2 text-xs text-slate-300">
            <span className="truncate">
              {x.merchant} · {x.title}
            </span>
            <span className="shrink-0 tabular-nums">
              {hkd(x.price_hkd)} <span className="text-slate-500">{x.source === "live" ? t(`实时 ${timeHK(x.fetched_at)}`, `live ${timeHK(x.fetched_at)}`) : t("快照", "snapshot")}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface CompareView {
  rule: string;
  shortlist: { rank: number; merchant: string; title: string; total_hkd: number; trusted_merchant: boolean; reasons: string[]; product_url: string }[];
  rejected: { merchant: string; title: string; price_hkd: number; missed: string[] }[];
  coverage: { name: string; status: string; note: string }[];
  references: { via: string; note: string; offers: { source: string; title: string; price_text: string; url: string; same_product: boolean }[] };
}

const COVERAGE_STYLE: Record<string, string> = {
  matched: "text-emerald-300",
  no_match: "text-amber-300",
  not_found: "text-slate-500",
  failed: "text-rose-300",
};

function CompareResult({ r }: { r: CompareView }) {
  const [showRejected, setShowRejected] = useState(false);
  return (
    <div className="mt-2 space-y-2">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="pb-1 pr-1">#</th>
            <th className="pb-1 pr-1">{t("店 · 商品", "Store · item")}</th>
            <th className="pb-1 text-right">{t("总价", "Total")}</th>
          </tr>
        </thead>
        <tbody>
          {r.shortlist.map((x) => (
            <tr key={x.product_url} className={`align-top ${x.rank === 1 ? "bg-emerald-500/10" : ""}`}>
              <td className="py-1 pr-1 font-semibold text-slate-300">{x.rank}</td>
              <td className="py-1 pr-1">
                <span className="text-slate-200">{x.title}</span>
                <span className="block text-slate-500">
                  {x.merchant}
                  {x.trusted_merchant && <span className="ml-1 rounded bg-emerald-500/15 px-1 text-emerald-300">{t("熟客店", "regular")}</span>}
                </span>
                {x.rank === 1 && (
                  <span className="block text-emerald-300">
                    {x.reasons.filter((s) => !isNotice(s)).join(" · ")}
                    {x.reasons
                      .filter(isNotice)
                      .map((s) => (
                        <span key={s} className="mt-0.5 block rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200">
                          {s}
                        </span>
                      ))}
                  </span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums text-slate-200">{hkd(x.total_hkd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.shortlist.length === 0 && <p className="text-xs text-amber-300">{t("没有一件满足要求。", "Nothing meets the requirements.")}</p>}
      {r.rejected.length > 0 && (
        <div>
          <button type="button" className="text-xs text-slate-400 underline" onClick={() => setShowRejected(!showRejected)}>
            {showRejected
              ? t(`淘汰了 ${r.rejected.length} 件（收起）`, `${r.rejected.length} ruled out (hide)`)
              : t(`淘汰了 ${r.rejected.length} 件，看原因`, `${r.rejected.length} ruled out, see why`)}
          </button>
          {showRejected && (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-400">
              {r.rejected.map((x, i) => (
                <li key={i}>
                  {t(`${x.merchant}「${x.title}」${hkd(x.price_hkd)}：`, `${x.merchant} · ${x.title} · ${hkd(x.price_hkd)}: `)}
                  <span className="text-rose-300">{x.missed.join(t("；", "; "))}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        {t("覆盖：", "Coverage: ")}
        {r.coverage.map((c, i) => (
          <span key={i} className={`mr-2 ${COVERAGE_STYLE[c.status] ?? ""}`}>
            {t(`${c.name}（${c.note}）`, `${c.name} (${c.note})`)}
          </span>
        ))}
      </p>
      <div className="rounded bg-black/30 p-2 text-[11px] text-slate-400">
        <p>
          {t("全网参考价", "Reference prices elsewhere")} · <span className="text-slate-500">{r.references.note}</span>
        </p>
        {r.references.offers.length === 0 && <p className="text-slate-500">{t("这次没有找到可信的同款参考价。", "No reliable reference price for the same item this time.")}</p>}
        {r.references.offers.map((o, i) => (
          <p key={i} className="flex justify-between gap-2">
            <a className="truncate text-indigo-300 underline" href={o.url} target="_blank" rel="noreferrer">
              <span className={`mr-1 rounded px-1 no-underline ${o.same_product ? "bg-amber-500/20 text-amber-200" : "bg-white/10 text-slate-400"}`}>
                {o.same_product ? t("同款", "same") : t("类似", "similar")}
              </span>
              {o.source} · {o.title}
            </a>
            <span className="shrink-0 tabular-nums text-slate-300">{o.price_text}</span>
          </p>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        {t("排序规则：", "Ranking rule: ")}
        {r.rule}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 手机
// ---------------------------------------------------------------------------

function tierText(tier: "strong" | "medium" | "weak"): string {
  return { strong: t("强", "Strong"), medium: t("中", "Medium"), weak: t("弱", "Weak") }[tier];
}

function PhonePanel({ state, serverNow, phone }: { state: State; serverNow: Date; phone: Phone }) {
  const {
    order,
    tier,
    position,
    posError,
    useVenue,
    setUseVenue,
    draft,
    outgoing,
    tamper,
    setTamper,
    busy,
    message,
    deviceError,
    prevBundle,
    cooldownLeft,
    strongAuth,
    submit,
    tamperShipTo,
    recollect,
  } = phone;
  const consent = () => void phone.consent();

  return (
    <Panel
      title={t("你的手机", "Your phone")}
      subtitle={t("比对在这里完成。发出去的只有签过名的是非结论。", "The checks happen here. Only signed yes/no answers leave.")}
      accent="bg-indigo-400"
    >
      <div className="rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/10 p-3 ring-1 ring-white/10">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-300">{t("授权强度", "Authorisation strength")}</span>
          <span className="text-sm font-semibold">{tier ? tierText(tier) : t("未认证或已失效", "Not confirmed or expired")}</span>
        </div>
        <StrengthBar authTime={state.auth_time} now={serverNow} />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-slate-400">
            {state.auth_time
              ? t(`上次确认 ${timeHK(state.auth_time)}`, `Last confirmed ${timeHK(state.auth_time)}`)
              : t("按一次，管一段时间；强度随时间变弱", "One tap lasts a while; strength fades over time")}
          </span>
          <Btn tone="primary" onClick={strongAuth}>
            {t("指纹 / 面容确认（模拟）", "Fingerprint / Face ID (simulated)")}
          </Btn>
        </div>
        {deviceError && <p className="mt-1 text-xs text-amber-300">{deviceError}</p>}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <Stat label={t("单笔上限", "Per-transaction cap")} value={hkd(state.mandate.per_txn_cap_hkd)} />
        <Stat label={t("7 天上限", "7-day cap")} value={hkd(state.mandate.rolling_7d_cap_hkd)} />
        <Stat
          label={t("授权到期", "Mandate expires")}
          value={
            Date.parse(state.mandate.expires_at) <= serverNow.getTime()
              ? t("已撤销", "Revoked")
              : new Date(state.mandate.expires_at).toLocaleString(locale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
          }
        />
      </div>

      <div className="rounded-lg bg-black/20 p-2.5 text-xs text-slate-400">
        <Toggle
          checked={useVenue}
          onChange={setUseVenue}
          label={t("用会场位置（港大）模拟定位", "Simulate location at the venue (HKU)")}
          hint={t(
            "电脑定位常常只准到几公里。录屏或室内信号差时用；会标明是模拟的。",
            "Laptop location is often only accurate to a few km. Use this for recordings or poor indoor signal; it's labelled as simulated.",
          )}
        />
        {position && (
          <p className="mt-1">
            {position.simulated
              ? t("模拟位置。坐标只在这台设备上。", "Simulated position. Coordinates stay on this device.")
              : t(
                  `真实定位，精度约 ${Math.round(position.accuracy_m)} 米。坐标只在这台设备上。`,
                  `Real location, accuracy about ${Math.round(position.accuracy_m)} m. Coordinates stay on this device.`,
                )}
          </p>
        )}
        {posError && <p className="mt-1 text-amber-300">{posError}</p>}
      </div>

      {!order && <p className="text-sm text-slate-500">{t("等代理交来一份购物车。", "Waiting for the agent to hand over a cart.")}</p>}

      {order && (
        <div className="rounded-xl border border-white/10 p-3">
          <p className="text-sm">
            <b>{order.listing.title}</b> ×{order.qty} · {hkd(order.quote.total_hkd)}
          </p>
          <p className="text-xs text-slate-400">
            {order.listing.merchant_name} · {t(`寄到「${order.ship_to_place.label}」`, `ship to "${order.ship_to_place.label}"`)}
            {order.ship_to_tampered && <span className="ml-1 text-rose-300">{t("（签完后被改过）", "(changed after signing)")}</span>}
          </p>

          {order.status === "awaiting_proof" && draft?.orderId === order.id && outgoing && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-slate-300">{draft.locationNote}</p>
              <div className="rounded-lg bg-rose-500/5 p-2 ring-1 ring-rose-400/20">
                <p className="mb-1 text-xs font-medium text-rose-200">{t("攻击（交出去之前动手脚）", "Attacks (tamper before sending)")}</p>
                <div className="space-y-1">
                  <Toggle
                    checked={tamper.dropUnfavorable}
                    onChange={(v) => setTamper({ ...tamper, dropUnfavorable: v })}
                    label={t("丢掉回答为「否」的结论", 'Drop the "no" answers')}
                  />
                  <Toggle checked={tamper.inflateScore} onChange={(v) => setTamper({ ...tamper, inflateScore: v })} label={t("把分数改成 100", "Change the score to 100")} />
                  <Toggle
                    checked={tamper.replayPrevious}
                    onChange={(v) => setTamper({ ...tamper, replayPrevious: v })}
                    label={t("重放上一单的结论", "Replay the last order")}
                    hint={prevBundle.current ? undefined : t("要先完成过一单", "Needs one completed order first")}
                  />
                </div>
                <div className="mt-2">
                  <Btn tone="ghost" onClick={tamperShipTo}>
                    {t("代理签完后改收货地", "Agent changes ship-to after signing")}
                  </Btn>
                </div>
              </div>
              <OutgoingSummary bundle={outgoing} now={serverNow} />
              <div className="flex flex-wrap gap-2">
                <Btn tone="primary" onClick={submit} disabled={busy}>
                  {busy
                    ? t("银行验证中…", "Bank is verifying…")
                    : t(`交给银行（声明 ${outgoing.stated_score} 分）`, `Send to the bank (stated score ${outgoing.stated_score})`)}
                </Btn>
                <Btn tone="ghost" onClick={recollect}>
                  {t("重新收集证明", "Collect proofs again")}
                </Btn>
              </div>
            </div>
          )}

          {order.status === "awaiting_consent" && (
            <div className="mt-3 rounded-lg bg-amber-500/10 p-3 ring-1 ring-amber-400/30">
              <p className="text-base font-medium text-amber-50">{friendlyAsk(order)}</p>
              <p className="mt-1 text-xs text-amber-100/80">{order.decision?.userFacingReason}</p>
              <div className="mt-2 flex gap-2">
                <Btn tone="primary" onClick={consent}>
                  {t("我看过了，确认购买", "I've read it, confirm purchase")}
                </Btn>
              </div>
              <p className="mt-1 text-[11px] text-amber-200/70">{t("1 秒内点下去不算数（R-12）。", "A click within 1 second doesn't count (R-12).")}</p>
            </div>
          )}

          {order.status === "cooling" && (
            <div className="mt-3 rounded-lg bg-sky-500/10 p-3 ring-1 ring-sky-400/30">
              <p className="text-sm text-sky-100">{order.decision?.userFacingReason}</p>
              <p className="mt-1 text-xs text-sky-200">
                {cooldownLeft > 0
                  ? t(`冷静期还剩 ${Math.ceil(cooldownLeft / 1000)} 秒，这段时间不会发出凭证。`, `${Math.ceil(cooldownLeft / 1000)} s of cooling-off left; no credential until then.`)
                  : t("冷静期结束了，需要你确认一次。", "Cooling-off is over; confirm once to proceed.")}
              </p>
              <div className="mt-2">
                <Btn tone="primary" onClick={consent} disabled={cooldownLeft > 0}>
                  {t("确认购买", "Confirm purchase")}
                </Btn>
              </div>
            </div>
          )}

          {order.status === "paid" && (
            <p className="mt-3 rounded-lg bg-emerald-500/10 p-2.5 text-sm text-emerald-200">
              {t("已付款", "Paid")} {hkd(order.quote.total_hkd)} · {order.card && t(order.card.card.label, order.card.card.label_en ?? order.card.card.label)}
            </p>
          )}
          {order.status === "declined" && (
            <p className="mt-3 rounded-lg bg-rose-500/10 p-2.5 text-sm text-rose-200">
              {t("没有付款：", "Not paid: ")}
              {order.decision?.userFacingReason}
            </p>
          )}
          {message && <p className="mt-2 text-xs text-slate-300">{message}</p>}
        </div>
      )}
    </Panel>
  );
}

/** 只说那一个最重要的差别，用人话 */
export function friendlyAsk(order: Order): string {
  const answers = new Map((order.bundle?.claims ?? []).map((c) => [c.claim.question_id, c.claim.answer]));
  const item = t(`${order.listing.title}（${hkd(order.quote.total_hkd)}）`, `${order.listing.title} (${hkd(order.quote.total_hkd)})`);
  const place = order.ship_to_place.label;
  if (answers.get("near_ship_to") === false) {
    return t(
      `代理想把${item}寄到「${place}」，但你现在不在那附近。是你要寄过去的吗？`,
      `The agent wants to ship ${item} to "${place}", but you're not near there right now. Did you mean to send it there?`,
    );
  }
  if (!answers.has("near_ship_to")) {
    return t(`没有拿到你的位置。确认要把${item}寄到「${place}」吗？`, `No location available. Ship ${item} to "${place}"?`);
  }
  if (answers.get("consistent_with_history") === false) {
    return t(`这一单和你在这家店平时买的不太一样：${item}。确认要买吗？`, `This isn't like what you usually buy at this store: ${item}. Buy it?`);
  }
  if (!answers.get("holder_recently_authenticated")) {
    return t(`你有一阵子没确认过身份了。确认要买${item}吗？`, `You haven't confirmed it's you for a while. Buy ${item}?`);
  }
  return t(`确认要买${item}吗？`, `Buy ${item}?`);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/20 p-2">
      <div className="text-slate-400">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums text-slate-100">{value}</div>
    </div>
  );
}

function StrengthBar({ authTime, now }: { authTime: string | null; now: Date }) {
  const age = authTime ? now.getTime() - Date.parse(authTime) : Infinity;
  const pct = Number.isFinite(age) ? Math.max(0, 100 - (age / TIER_BOUNDS.weak) * 100) : 0;
  const color = age < TIER_BOUNDS.strong ? "bg-emerald-400" : age < TIER_BOUNDS.medium ? "bg-amber-400" : age < TIER_BOUNDS.weak ? "bg-sky-400" : "bg-slate-600";
  return (
    <div className="mt-2">
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>0 · {t("强", "strong")}</span>
        <span>2h · {t("中", "medium")}</span>
        <span>12h · {t("弱", "weak")}</span>
        <span>24h · {t("失效", "expired")}</span>
      </div>
    </div>
  );
}

function OutgoingSummary({ bundle, now }: { bundle: Bundle; now: Date }) {
  const [open, setOpen] = useState(false);
  const recomputed = computeScore(bundle.claims, now);
  return (
    <div className="rounded-lg bg-black/30 p-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-slate-200">{t("离开手机的数据", "Data leaving the phone")}</p>
        <button type="button" className="text-xs text-indigo-300 underline" onClick={() => setOpen(!open)}>
          {open ? t("收起 JSON", "Hide JSON") : t("看完整 JSON", "Show full JSON")}
        </button>
      </div>
      <ul className="mt-1 space-y-0.5 text-xs">
        {bundle.claims.map((c, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span className="text-slate-400">
              {roleText(c.claim.role)} · {questionText(c.claim.question_id)}
            </span>
            <span className={c.claim.answer ? "text-emerald-300" : "text-rose-300"}>{c.claim.answer ? t("是", "Yes") : t("否", "No")}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-slate-500">
        {t(
          `没有坐标、没有购买记录、没有生物特征。按公开表算是 ${recomputed} 分。`,
          `No coordinates, no purchase history, no biometrics. The public table gives a score of ${recomputed}.`,
        )}
      </p>
      {open && <Json value={bundle} max={260} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 银行
// ---------------------------------------------------------------------------

const FAIL_STEP: Record<string, number> = { "A-01": 0, "A-02": 1, "A-03": 2, "A-04": 3, "A-05": 4, "A-07": 5, "A-06": 6 };
function bankSteps(): string[] {
  return [
    t("每题只交一份", "One answer per question"),
    t("签名钥匙在信任名单里", "Signing key is on the trusted list"),
    t("签名对得上", "Signature verifies"),
    t("签的是这一单（订单编号）", "Signed for this order (order hash)"),
    t("问题在公开表里", "Question is in the public table"),
    t("商户核对价格和库存", "Store confirms price and stock"),
    t("按公开表重算分数", "Recompute the score from the public table"),
  ];
}

function BankPanel({ order }: { order: Order | null }) {
  const d = order?.decision ?? null;
  const att = d?.attestation ?? null;
  const failAt = att && !att.ok ? FAIL_STEP[att.code] ?? -1 : -1;

  return (
    <Panel
      title={t("银行（验证方）", "Bank (verifier)")}
      subtitle={t("不信手机报的分数，只信签名；自己重算，再交给规则引擎。", "Trusts signatures, not the phone's score: recomputes it, then hands over to the rule engine.")}
      accent="bg-emerald-400"
    >
      {!d && <p className="text-sm text-slate-500">{t("等手机交来证明包。", "Waiting for the phone's proof bundle.")}</p>}
      {d && order && (
        <>
          <ol className="space-y-1">
            {bankSteps().map((s, i) => (
              <Check
                key={s}
                ok={!att ? null : att.ok ? true : i < failAt ? true : i === failAt ? false : null}
                label={s}
                detail={
                  att && !att.ok && i === failAt
                    ? att.reason
                    : i === 6 && att?.ok
                      ? t(`手机声明 ${order.bundle?.stated_score} 分，重算 ${att.result.score} 分`, `Phone stated ${order.bundle?.stated_score}, recomputed ${att.result.score}`)
                      : undefined
                }
              />
            ))}
          </ol>

          {att?.ok && (
            <div className="rounded-lg bg-black/20 p-2.5 text-xs">
              <table className="w-full">
                <tbody>
                  {att.result.statuses.map((s) => (
                    <tr key={s.question_id} className="border-b border-white/5 last:border-0">
                      <td className="py-1 pr-2 align-top text-slate-400">{roleText(s.role)}</td>
                      <td className="py-1 text-slate-300">{questionText(s.question_id)}</td>
                      <td className="py-1 text-right">
                        {s.state === "counted" ? (s.answer ? t("是", "Yes") : t("否", "No")) : s.state === "missing" ? t("没交", "Missing") : t("过期", "Expired")}
                      </td>
                      <td className="py-1 pl-2 text-right tabular-nums text-slate-400">+{s.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-slate-400">
                {t("强认证档位：", "Strong-auth tier: ")}
                {att.result.tier ? tierText(att.result.tier) : t("无", "none")} · {t("分数给出", "score gives")} <ChannelBadge channel={att.result.score_channel} /> ·{" "}
                {t("档位和核对给出", "tier and checks give")} <ChannelBadge channel={att.result.floor_channel} />
              </p>
            </div>
          )}

          <div className="rounded-xl border border-white/10 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-400">{t("规则引擎", "Rule engine")}</span>
              <ChannelBadge channel={d.engineChannel} />
              <span className="text-slate-500">{t("与证明层取更严 →", "stricter of this and the proofs →")}</span>
              <ChannelBadge channel={d.channel} size="lg" />
            </div>
            <p className="mt-2 text-sm text-slate-200">{d.userFacingReason}</p>
            {d.triggeredRules.length > 0 && (
              <p className="mt-1 text-xs text-slate-500">
                {t("命中规则：", "Rules hit: ")}
                {d.triggeredRules.join(t("、", ", "))}
              </p>
            )}
          </div>

          {order.credential && (
            <div className="rounded-xl bg-emerald-500/10 p-3 text-sm ring-1 ring-emerald-400/30">
              <p className="font-medium text-emerald-200">
                {t("一次性凭证", "One-time credential")} {order.credential.credential_id}
              </p>
              <p className="text-xs text-emerald-100/80">
                {t(
                  `锁死商户 ${order.credential.merchant_id} · 金额 ${hkd(order.credential.amount_hkd)} · 只能用一次 · ${timeHK(order.credential.expires_at)} 过期`,
                  `Locked to store ${order.credential.merchant_id} · amount ${hkd(order.credential.amount_hkd)} · single use · expires ${timeHK(order.credential.expires_at)}`,
                )}
              </p>
              {order.card && (
                <p className="mt-1 text-xs text-emerald-100/80">
                  {t("选卡：", "Card: ")}
                  {order.card.reason}
                </p>
              )}
              {order.settlement && (
                <p className="mt-1 text-xs text-emerald-100/80">
                  {t("结算：", "Settlement: ")}
                  {order.settlement.mode === "stripe_test" ? t("Stripe 测试模式", "Stripe test mode") : t("模拟", "simulated")} · {order.settlement.id} · {order.settlement.note}
                </p>
              )}
            </div>
          )}
          <p className="text-[11px] text-slate-500">
            {t(
              `订单编号 ${short(order.order_hash, 16)}（覆盖商户、商品、数量、金额、收货地）`,
              `Order hash ${short(order.order_hash, 16)} (covers store, item, quantity, amount and ship-to)`,
            )}
          </p>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 演示控制和日志
// ---------------------------------------------------------------------------

function DemoControls({ state, refresh }: { state: State; refresh: () => Promise<void> }) {
  const setClock = async (h: number) => {
    await api("/api/clock", { offset_hours: h });
    await refresh();
  };
  const revoked = Date.parse(state.mandate.expires_at) <= Date.parse(state.now);
  return (
    <Panel
      title={t("演示控制", "Demo controls")}
      subtitle={t("把时钟往后拨，看同一单怎么一级级变严。", "Move the clock forward and watch the same order get stricter step by step.")}
      accent="bg-sky-400"
    >
      <div>
        <p className="mb-1 text-xs text-slate-400">{t("演示时钟（距现在）", "Demo clock (from now)")}</p>
        <div className="flex flex-wrap gap-2">
          {[0, 3, 13, 25].map((h) => (
            <Btn key={h} tone={state.clock_offset_hours === h ? "primary" : "default"} onClick={() => setClock(h)}>
              {t(`+${h} 小时`, `+${h} h`)}
            </Btn>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">{t("拨完之后让代理重新买一次。", "Then send the agent again.")}</p>
      </div>
      <div>
        <p className="mb-1 text-xs text-slate-400">{t("授权书", "Mandate")}</p>
        {revoked ? (
          <Btn onClick={async () => (await api("/api/mandate/restore", {}), await refresh())}>{t("恢复授权", "Restore mandate")}</Btn>
        ) : (
          <Btn tone="danger" onClick={async () => (await api("/api/mandate/revoke", {}), await refresh())}>
            {t("一键撤销授权", "Revoke mandate")}
          </Btn>
        )}
      </div>
      <div className="text-xs text-slate-400">
        <p>{t("试试看：", "Try this:")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>
            {t(
              "打开「藏了劫持指令」再让代理买：收货地变成深圳仓，定位答「否」。",
              'Turn on the hidden hijack instruction and send the agent: the ship-to becomes the Shenzhen warehouse and location answers "no".',
            )}
          </li>
          <li>
            {t(
              "交给银行前勾「把分数改成 100」：银行重算对不上，不发凭证。",
              'Tick "Change the score to 100" before sending to the bank: the recompute doesn\'t match and no credential is issued.',
            )}
          </li>
          <li>{t("让代理「买 4 个」：超过单笔上限 HK$800，分数再高也拒绝。", 'Ask the agent to "buy 4": over the HK$800 cap, declined whatever the score.')}</li>
        </ul>
      </div>
      <Btn tone="ghost" onClick={async () => (await api("/api/reset", {}), location.reload())}>
        {t("重置这个演示", "Reset this demo")}
      </Btn>
    </Panel>
  );
}

function LogPanel({ state }: { state: State }) {
  const [checked, setChecked] = useState<string>("");
  const verify = async () => {
    const r = await api<{ chain: { ok: boolean; reason: string } }>("/api/log");
    setChecked(`${r.chain.ok ? "✓" : "✗"} ${r.chain.reason}`);
  };
  const entries = [...state.log].reverse().slice(0, 60);
  return (
    <Panel
      title={t("哈希链日志", "Hash-chained log")}
      subtitle={t(
        "先记下代理被允许做什么，再记下它被拦住。每一条都串着上一条的哈希，改一条整条链就断。",
        "First what the agent was allowed to do, then where it was stopped. Each entry carries the previous entry's hash, so changing one breaks the chain.",
      )}
      accent="bg-amber-400"
      right={
        <div className="flex items-center gap-2">
          {checked && <span className="text-xs text-emerald-300">{checked}</span>}
          <Btn onClick={verify}>{t("验证整条链", "Verify the whole chain")}</Btn>
        </div>
      }
    >
      <div className="max-h-[340px] overflow-auto">
        <table className="w-full text-xs">
          <tbody>
            {entries.map((e) => (
              <tr key={e.seq} className="border-b border-white/5 align-top">
                <td className="py-1 pr-2 tabular-nums text-slate-500">#{e.seq}</td>
                <td className="py-1 pr-2 tabular-nums text-slate-500">{timeHK(e.at)}</td>
                <td className="py-1 pr-2 text-slate-400">{e.actor}</td>
                <td className="py-1 pr-2 font-medium text-slate-200">{e.event}</td>
                <td className="py-1 pr-2 text-slate-400">{summary(e)}</td>
                <td className="py-1 font-mono text-[10px] text-slate-600">{short(e.entry_hash, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function summary(e: Record<string, unknown>): string {
  const pick = ["tool", "question", "answer", "final_channel", "fail_code", "recomputed_score", "stated_score", "total_hkd", "ship_to", "credential_id", "mode", "offset_hours", "reason"];
  return pick
    .filter((k) => e[k] !== undefined && e[k] !== null)
    .map((k) => `${k}=${typeof e[k] === "string" ? String(e[k]).slice(0, 60) : JSON.stringify(e[k])}`)
    .join(" · ");
}

function Footer() {
  return (
    <footer className="mt-6 space-y-1 text-xs text-slate-500">
      <p>
        {t(
          "哪些是真的：商品、价格、库存来自真实香港 Shopify 网店（只读公开数据，不提交订单）；定位用你这台设备的真实位置在本地比对；签名、重算、规则引擎、哈希链都是真的。",
          "Real: products, prices and stock from live Hong Kong Shopify stores (read-only public data, no orders placed); location compared on this device using its real position; signatures, recompute, rule engine and hash chain.",
        )}
      </p>
      <p>
        {t(
          "哪些是模拟的：指纹 / 面容确认；定位结论由设备自证（正式版由运营商签）；商户的购买记录；结算（Stripe 测试模式或模拟），不涉及真钱。",
          "Simulated: fingerprint / Face ID; the location answer is signed by the device itself (a carrier would sign it in production); the store's purchase history; settlement (Stripe test mode or simulated), no real money.",
        )}
      </p>
    </footer>
  );
}
