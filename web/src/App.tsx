import { useEffect, useMemo, useRef, useState } from "react";

import { QUESTIONS, TIER_BOUNDS } from "../../src/attest/questions.ts";
import { computeScore, strengthTier } from "../../src/attest/score.ts";
import type { Bundle, SignedClaim } from "../../src/attest/types.ts";
import { api, fetchClaims, useLive, type AgentEvent, type Order, type State } from "./api.ts";
import {
  NEAR_SHIP_TO_KM,
  VENUE,
  currentPosition,
  deviceKey,
  distanceKm,
  signLocationClaim,
  type Position,
} from "./device.ts";
import { Btn, ChannelBadge, Check, Json, Panel, Toggle, hkd, short, timeHK } from "./ui.tsx";

const DEFAULT_PROMPT = "帮我买一个 HK$300 以内的 65W 充电器，寄到宿舍";
const EXAMPLE_PROMPTS = [
  DEFAULT_PROMPT,
  "帮我挑一份 HK$250 以内的丝巾礼物",
  "帮我买 4 个 HK$300 以内的 65W 充电器",
];

const QUESTION_TEXT: Record<string, string> = Object.fromEntries(QUESTIONS.map((q) => [q.id, q.text]));
const ROLE_TEXT: Record<string, string> = { location: "定位", bank: "银行", merchant: "商户" };

interface Draft {
  orderId: string;
  /** 收集时的授权状态；变了就重新收集 */
  key: string;
  bundle: Bundle;
  distance_km: number | null;
  near: boolean | null;
  locationNote: string;
}

interface Tamper {
  dropUnfavorable: boolean;
  inflateScore: boolean;
  replayPrevious: boolean;
}

export default function App() {
  const live = useLive();
  const { state, config } = live;
  const [skew, setSkew] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (state) setSkew(Date.parse(state.now) - Date.now());
  }, [state?.now, state?.clock_offset_hours]);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const serverNow = useMemo(() => new Date(Date.now() + skew), [skew, tick]);

  if (!state) {
    return <div className="grid min-h-screen place-items-center text-slate-400">连接演示服务器中…</div>;
  }

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-5">
      <Header state={state} config={config} connected={live.connected} />
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <AgentPanel live={live} />
        <PhonePanel state={state} serverNow={serverNow} refresh={live.refresh} />
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
        <p className="text-xs font-medium uppercase tracking-widest text-indigo-300">HacKU 2026 · FinTech 第 1 题 · 队伍 23 Local Deployment</p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
          代理替你付款，<span className="text-indigo-300">个人背景不出手机</span>
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          定位、银行、商户各自只回答一个固定的是非题并签名；手机按公开表合成分数，银行自己重算。结论只能让交易更严，突破不了你设的上限。
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-rose-500/15 px-2.5 py-1 text-rose-200 ring-1 ring-rose-400/30">演示环境 · 不涉及真实付款</span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 ring-1 ring-white/10">
          商品：{!config ? "检查中" : config.search_live ? "真实香港网店（实时）" : "真实网店快照"}
        </span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 ring-1 ring-white/10">
          参考价：{!config ? "检查中" : config.reference_via === "serpapi" ? "Google Shopping" : config.reference_via === "tavily" ? "全网搜索摘要" : "无"}
        </span>
        <span className="rounded-full bg-white/5 px-2.5 py-1 ring-1 ring-white/10">
          结算：{!config ? "检查中" : config.stripe_test ? "Stripe 测试模式" : "模拟"}
        </span>
        <span className={`rounded-full px-2.5 py-1 ring-1 ${connected ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30" : "bg-amber-500/10 text-amber-300 ring-amber-400/30"}`}>
          {connected ? "已连接" : "重连中"} · 演示时钟 +{state.clock_offset_hours}h
        </span>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// 代理
// ---------------------------------------------------------------------------

const TOOL_TEXT: Record<string, string> = {
  search_products: "搜索白名单网店",
  compare_products: "比价",
  get_product: "确认此刻价格和库存",
  add_to_cart: "放进店家的真购物车",
  submit_payment_plan: "交给手机和银行验证",
};

function AgentPanel({ live }: { live: ReturnType<typeof useLive> }) {
  const { state, config, agentEvents, setAgentEvents } = live;
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [mode, setMode] = useState<"scripted" | "llm">("scripted");
  const [injection, setInjection] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const busy = state?.agent_busy ?? false;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [agentEvents.length]);

  const run = async () => {
    setError("");
    setAgentEvents([]);
    try {
      await api("/api/agent/run", { mode, prompt, injection, access_code: code || undefined });
      await live.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Panel
      title="购物代理"
      subtitle="工具只有：搜索、比价、确认价格、放进购物车、交给你验证。没比价的放不进购物车；没有付款工具，也看不到你的位置和消费记录。"
      accent="bg-violet-400"
    >
      <textarea
        className="min-h-[64px] w-full resize-none rounded-lg border border-white/10 bg-black/30 p-2.5 text-sm outline-none focus:border-indigo-400"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
      />
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPrompt(p)}
            disabled={busy}
            className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
          >
            {p.replace("，寄到宿舍", "")}
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
              {m === "scripted" ? "脚本模式" : "DeepSeek 模式"}
            </button>
          ))}
        </div>
        {mode === "llm" && config?.llm_requires_code && (
          <input
            className="w-28 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm"
            placeholder="访问码"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        )}
        <Btn tone="primary" onClick={run} disabled={busy || !prompt.trim()}>
          {busy ? "代理工作中…" : "让代理去买"}
        </Btn>
      </div>
      <Toggle
        checked={injection}
        onChange={setInjection}
        label="商品页里藏了一段劫持指令"
        hint={
          mode === "scripted"
            ? "脚本模式会照着做：把收货地改成深圳仓。用来演示代理被骗了也没用。"
            : "DeepSeek 可能识破，也可能上当。安全不押在它身上。"
        }
      />
      {error && <p className="rounded-lg bg-rose-500/10 p-2 text-sm text-rose-300">{error}</p>}

      <div ref={listRef} className="flex max-h-[420px] flex-col gap-2 overflow-auto pr-1">
        {agentEvents.length === 0 && <p className="text-sm text-slate-500">代理每一步都会显示在这里。</p>}
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
          {e.n}. {TOOL_TEXT[e.tool] ?? e.tool}
        </span>
        <code className="text-[11px] text-slate-500">{e.tool}</code>
      </div>
      {!e.ok && <p className="mt-1 text-rose-300">{String(r["error"])}</p>}
      {e.ok && e.tool === "search_products" && <SearchResult r={r} />}
      {e.ok && e.tool === "compare_products" && <CompareResult r={r as unknown as CompareView} />}
      {e.ok && e.tool === "get_product" && (
        <p className="mt-1 text-slate-300">
          {String(r["merchant"])}「{String(r["title"])}」{hkd(Number(r["price_hkd"]))} · {r["available"] ? "有货" : "缺货"}
          {r["merchant_note"] ? <span className="mt-1 block rounded bg-rose-500/15 p-1.5 text-xs text-rose-200">页面里藏着：{String(r["merchant_note"])}</span> : null}
        </p>
      )}
      {e.ok && e.tool === "add_to_cart" && (
        <p className="mt-1 text-slate-300">
          {String(r["title"])} ×{String(r["qty"])} = {hkd(Number(r["subtotal_hkd"]))} ·{" "}
          <a className="text-indigo-300 underline" href={String(r["cart_url"])} target="_blank" rel="noreferrer">
            打开店家的真购物车
          </a>
        </p>
      )}
      {e.ok && e.tool === "submit_payment_plan" && (
        <p className="mt-1 text-slate-300">
          收货地：<b>{String((e.args as Record<string, unknown>)["ship_to_label"])}</b>。代理的任务到此结束，付款要等你和银行。
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
              {hkd(x.price_hkd)} <span className="text-slate-500">{x.source === "live" ? `实时 ${timeHK(x.fetched_at)}` : "快照"}</span>
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
            <th className="pb-1 pr-1">店 · 商品</th>
            <th className="pb-1 text-right">总价</th>
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
                  {x.trusted_merchant && <span className="ml-1 rounded bg-emerald-500/15 px-1 text-emerald-300">熟客店</span>}
                </span>
                {x.rank === 1 && (
                  <span className="block text-emerald-300">
                    {x.reasons.filter((s) => !s.startsWith("注意")).join(" · ")}
                    {x.reasons
                      .filter((s) => s.startsWith("注意"))
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
      {r.shortlist.length === 0 && <p className="text-xs text-amber-300">没有一件满足要求。</p>}
      {r.rejected.length > 0 && (
        <div>
          <button type="button" className="text-xs text-slate-400 underline" onClick={() => setShowRejected(!showRejected)}>
            淘汰了 {r.rejected.length} 件{showRejected ? "（收起）" : "，看原因"}
          </button>
          {showRejected && (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-400">
              {r.rejected.map((x, i) => (
                <li key={i}>
                  {x.merchant}「{x.title}」{hkd(x.price_hkd)}：<span className="text-rose-300">{x.missed.join("；")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        覆盖：
        {r.coverage.map((c, i) => (
          <span key={i} className={`mr-2 ${COVERAGE_STYLE[c.status] ?? ""}`}>
            {c.name}（{c.note}）
          </span>
        ))}
      </p>
      <div className="rounded bg-black/30 p-2 text-[11px] text-slate-400">
        <p>
          全网参考价 · <span className="text-slate-500">{r.references.note}</span>
        </p>
        {r.references.offers.length === 0 && <p className="text-slate-500">这次没有找到可信的同款参考价。</p>}
        {r.references.offers.map((o, i) => (
          <p key={i} className="flex justify-between gap-2">
            <a className="truncate text-indigo-300 underline" href={o.url} target="_blank" rel="noreferrer">
              <span className={`mr-1 rounded px-1 no-underline ${o.same_product ? "bg-amber-500/20 text-amber-200" : "bg-white/10 text-slate-400"}`}>
                {o.same_product ? "同款" : "类似"}
              </span>
              {o.source} · {o.title}
            </a>
            <span className="shrink-0 tabular-nums text-slate-300">{o.price_text}</span>
          </p>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">排序规则：{r.rule}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 手机
// ---------------------------------------------------------------------------

const TIER_TEXT = { strong: "强", medium: "中", weak: "弱" } as const;

function PhonePanel({ state, serverNow, refresh }: { state: State; serverNow: Date; refresh: () => Promise<void> }) {
  const order = state.current_order;
  const [position, setPosition] = useState<Position | null>(null);
  const [posError, setPosError] = useState("");
  const [useVenue, setUseVenue] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tamper, setTamper] = useState<Tamper>({ dropUnfavorable: false, inflateScore: false, replayPrevious: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deviceError, setDeviceError] = useState("");
  const prevBundle = useRef<Bundle | null>(null);
  const consentShownAt = useRef<number>(0);

  const tier = state.auth_time ? strengthTier(state.auth_time, serverNow) : null;

  const strongAuth = async () => {
    setDeviceError("");
    let key: string | null = null;
    try {
      key = (await deviceKey()).publicX;
    } catch {
      setDeviceError("这个浏览器不支持 Ed25519，定位结论会按缺失计。换新版 Chrome、Edge 或 Safari 即可。");
    }
    await api("/api/auth/strong", { device_key: key });
    await refresh();
  };

  const locate = async (): Promise<Position | null> => {
    if (useVenue) {
      const p = { ...VENUE, accuracy_m: 50, simulated: true };
      setPosition(p);
      return p;
    }
    try {
      const p = await currentPosition();
      setPosition(p);
      setPosError("");
      return p;
    } catch (e) {
      setPosError((e as Error).message);
      return null;
    }
  };

  const [collectNonce, setCollectNonce] = useState(0);
  const draftKey = `${state.auth_time ?? "-"}|${state.device_key ?? "-"}|${state.clock_offset_hours}|${useVenue}|${collectNonce}`;

  // 新订单进来：手机在本地比对定位、向银行和商户要结论、打包
  useEffect(() => {
    if (!order || order.status !== "awaiting_proof") return;
    if (draft?.orderId === order.id && draft.key === draftKey) return;
    let cancelled = false;
    (async () => {
      setMessage("");
      const { claims, now } = await fetchClaims(order.id);
      const at = new Date(now);
      const pos = await locate();
      const all: SignedClaim[] = [...claims];
      let dist: number | null = null;
      let near: boolean | null = null;
      let note: string;
      if (!state.device_key) {
        note = "这台设备还没做强认证、没登记钥匙，定位结论按缺失计。";
      } else if (!pos) {
        note = "拿不到位置，定位结论按缺失计。";
      } else {
        dist = distanceKm(pos, order.ship_to_place);
        near = dist <= NEAR_SHIP_TO_KM;
        all.unshift(await signLocationClaim(order.order_hash, near, at));
        note = `本地算出离「${order.ship_to_place.label}」${dist.toFixed(1)} 公里，所以回答「${near ? "是" : "否"}」。坐标没有离开这台设备。`;
      }
      const bundle: Bundle = { order_hash: order.order_hash, claims: all, stated_score: computeScore(all, at) };
      if (!cancelled) setDraft({ orderId: order.id, key: draftKey, bundle, distance_km: dist, near, locationNote: note });
    })().catch((e) => setMessage((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [order?.id, order?.status, draftKey]);

  useEffect(() => {
    if (order?.status === "awaiting_consent" || order?.status === "cooling") consentShownAt.current = Date.now();
  }, [order?.id, order?.status]);

  const outgoing = useMemo(() => {
    if (!draft) return null;
    let b: Bundle = { ...draft.bundle, claims: [...draft.bundle.claims] };
    if (tamper.replayPrevious && prevBundle.current) b = { ...prevBundle.current, order_hash: draft.bundle.order_hash };
    if (tamper.dropUnfavorable) b = { ...b, claims: b.claims.filter((c) => c.claim.answer) };
    if (tamper.inflateScore) b = { ...b, stated_score: 100 };
    return b;
  }, [draft, tamper]);

  const submit = async () => {
    if (!order || !outgoing) return;
    setBusy(true);
    try {
      await api(`/api/orders/${order.id}/submit`, { bundle: outgoing });
      prevBundle.current = draft?.bundle ?? null;
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tamperShipTo = async () => {
    if (!order) return;
    await api(`/api/orders/${order.id}/tamper-ship-to`, {});
    await refresh();
    setMessage("代理在结论签完之后把收货地改成了深圳仓。手机里这份证明包还是按原收货地签的。");
  };

  const consent = async () => {
    if (!order) return;
    const latency = Date.now() - consentShownAt.current;
    const r = await api<{ message: string }>(`/api/orders/${order.id}/consent`, { latency_ms: latency });
    setMessage(`${r.message}（你用了 ${(latency / 1000).toFixed(1)} 秒）`);
    await refresh();
  };

  const cooldownLeft = order?.decision?.cooldownUntil ? Math.max(0, Date.parse(order.decision.cooldownUntil) - serverNow.getTime()) : 0;

  return (
    <Panel title="你的手机" subtitle="比对在这里完成。发出去的只有签过名的是非结论。" accent="bg-indigo-400">
      <div className="rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/10 p-3 ring-1 ring-white/10">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-300">授权强度</span>
          <span className="text-sm font-semibold">{tier ? `${TIER_TEXT[tier]}` : "未认证或已失效"}</span>
        </div>
        <StrengthBar authTime={state.auth_time} now={serverNow} />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-slate-400">
            {state.auth_time ? `上次确认 ${timeHK(state.auth_time)}` : "按一次，管一段时间；强度随时间变弱"}
          </span>
          <Btn tone="primary" onClick={strongAuth}>
            指纹 / 面容确认（模拟）
          </Btn>
        </div>
        {deviceError && <p className="mt-1 text-xs text-amber-300">{deviceError}</p>}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <Stat label="单笔上限" value={hkd(state.mandate.per_txn_cap_hkd)} />
        <Stat label="7 天上限" value={hkd(state.mandate.rolling_7d_cap_hkd)} />
        <Stat
          label="授权到期"
          value={
            Date.parse(state.mandate.expires_at) <= serverNow.getTime()
              ? "已撤销"
              : new Date(state.mandate.expires_at).toLocaleString("zh-HK", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
          }
        />
      </div>

      <div className="rounded-lg bg-black/20 p-2.5 text-xs text-slate-400">
        <Toggle checked={useVenue} onChange={setUseVenue} label="用会场位置（港大）模拟定位" hint="电脑定位常常只准到几公里。录屏或室内信号差时用；会标明是模拟的。" />
        {position && (
          <p className="mt-1">
            {position.simulated ? "模拟位置" : `真实定位，精度约 ${Math.round(position.accuracy_m)} 米`}。坐标只在这台设备上。
          </p>
        )}
        {posError && <p className="mt-1 text-amber-300">{posError}</p>}
      </div>

      {!order && <p className="text-sm text-slate-500">等代理交来一份购物车。</p>}

      {order && (
        <div className="rounded-xl border border-white/10 p-3">
          <p className="text-sm">
            <b>{order.listing.title}</b> ×{order.qty} · {hkd(order.quote.total_hkd)}
          </p>
          <p className="text-xs text-slate-400">
            {order.listing.merchant_name} · 寄到「{order.ship_to_place.label}」
            {order.ship_to_tampered && <span className="ml-1 text-rose-300">（签完后被改过）</span>}
          </p>

          {order.status === "awaiting_proof" && draft?.orderId === order.id && outgoing && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-slate-300">{draft.locationNote}</p>
              <div className="rounded-lg bg-rose-500/5 p-2 ring-1 ring-rose-400/20">
                <p className="mb-1 text-xs font-medium text-rose-200">攻击（交出去之前动手脚）</p>
                <div className="space-y-1">
                  <Toggle checked={tamper.dropUnfavorable} onChange={(v) => setTamper({ ...tamper, dropUnfavorable: v })} label="丢掉回答为「否」的结论" />
                  <Toggle checked={tamper.inflateScore} onChange={(v) => setTamper({ ...tamper, inflateScore: v })} label="把分数改成 100" />
                  <Toggle
                    checked={tamper.replayPrevious}
                    onChange={(v) => setTamper({ ...tamper, replayPrevious: v })}
                    label="重放上一单的结论"
                    hint={prevBundle.current ? undefined : "要先完成过一单"}
                  />
                </div>
                <div className="mt-2">
                  <Btn tone="ghost" onClick={tamperShipTo}>
                    代理签完后改收货地
                  </Btn>
                </div>
              </div>
              <OutgoingSummary bundle={outgoing} now={serverNow} />
              <div className="flex flex-wrap gap-2">
                <Btn tone="primary" onClick={submit} disabled={busy}>
                  {busy ? "银行验证中…" : `交给银行（声明 ${outgoing.stated_score} 分）`}
                </Btn>
                <Btn tone="ghost" onClick={() => setCollectNonce((n) => n + 1)}>
                  重新收集证明
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
                  我看过了，确认购买
                </Btn>
              </div>
              <p className="mt-1 text-[11px] text-amber-200/70">1 秒内点下去不算数（R-12）。</p>
            </div>
          )}

          {order.status === "cooling" && (
            <div className="mt-3 rounded-lg bg-sky-500/10 p-3 ring-1 ring-sky-400/30">
              <p className="text-sm text-sky-100">{order.decision?.userFacingReason}</p>
              <p className="mt-1 text-xs text-sky-200">
                {cooldownLeft > 0 ? `冷静期还剩 ${Math.ceil(cooldownLeft / 1000)} 秒，这段时间不会发出凭证。` : "冷静期结束了，需要你确认一次。"}
              </p>
              <div className="mt-2">
                <Btn tone="primary" onClick={consent} disabled={cooldownLeft > 0}>
                  确认购买
                </Btn>
              </div>
            </div>
          )}

          {order.status === "paid" && (
            <p className="mt-3 rounded-lg bg-emerald-500/10 p-2.5 text-sm text-emerald-200">
              已付款 {hkd(order.quote.total_hkd)} · {order.card?.card.label}
            </p>
          )}
          {order.status === "declined" && (
            <p className="mt-3 rounded-lg bg-rose-500/10 p-2.5 text-sm text-rose-200">没有付款：{order.decision?.userFacingReason}</p>
          )}
          {message && <p className="mt-2 text-xs text-slate-300">{message}</p>}
        </div>
      )}
    </Panel>
  );
}

/** 只说那一个最重要的差别，用人话 */
function friendlyAsk(order: Order): string {
  const answers = new Map((order.bundle?.claims ?? []).map((c) => [c.claim.question_id, c.claim.answer]));
  const item = `${order.listing.title}（${hkd(order.quote.total_hkd)}）`;
  if (answers.get("near_ship_to") === false) {
    return `代理想把${item}寄到「${order.ship_to_place.label}」，但你现在不在那附近。是你要寄过去的吗？`;
  }
  if (!answers.has("near_ship_to")) return `没有拿到你的位置。确认要把${item}寄到「${order.ship_to_place.label}」吗？`;
  if (answers.get("consistent_with_history") === false) return `这一单和你在这家店平时买的不太一样：${item}。确认要买吗？`;
  if (!answers.get("holder_recently_authenticated")) return `你有一阵子没确认过身份了。确认要买${item}吗？`;
  return `确认要买${item}吗？`;
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
        <span>0 · 强</span>
        <span>2h · 中</span>
        <span>12h · 弱</span>
        <span>24h · 失效</span>
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
        <p className="text-xs font-medium text-slate-200">离开手机的数据</p>
        <button type="button" className="text-xs text-indigo-300 underline" onClick={() => setOpen(!open)}>
          {open ? "收起 JSON" : "看完整 JSON"}
        </button>
      </div>
      <ul className="mt-1 space-y-0.5 text-xs">
        {bundle.claims.map((c, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span className="text-slate-400">
              {ROLE_TEXT[c.claim.role]} · {QUESTION_TEXT[c.claim.question_id] ?? c.claim.question_id}
            </span>
            <span className={c.claim.answer ? "text-emerald-300" : "text-rose-300"}>{c.claim.answer ? "是" : "否"}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-slate-500">
        没有坐标、没有购买记录、没有生物特征。按公开表算是 {recomputed} 分。
      </p>
      {open && <Json value={bundle} max={260} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 银行
// ---------------------------------------------------------------------------

const FAIL_STEP: Record<string, number> = { "A-01": 0, "A-02": 1, "A-03": 2, "A-04": 3, "A-05": 4, "A-07": 5, "A-06": 6 };
const STEPS = ["每题只交一份", "签名钥匙在信任名单里", "签名对得上", "签的是这一单（订单编号）", "问题在公开表里", "商户核对价格和库存", "按公开表重算分数"];

function BankPanel({ order }: { order: Order | null }) {
  const d = order?.decision ?? null;
  const att = d?.attestation ?? null;
  const failAt = att && !att.ok ? FAIL_STEP[att.code] ?? -1 : -1;

  return (
    <Panel title="银行（验证方）" subtitle="不信手机报的分数，只信签名；自己重算，再交给规则引擎。" accent="bg-emerald-400">
      {!d && <p className="text-sm text-slate-500">等手机交来证明包。</p>}
      {d && order && (
        <>
          <ol className="space-y-1">
            {STEPS.map((s, i) => (
              <Check
                key={s}
                ok={!att ? null : att.ok ? true : i < failAt ? true : i === failAt ? false : null}
                label={s}
                detail={att && !att.ok && i === failAt ? att.reason : i === 6 && att?.ok ? `手机声明 ${order.bundle?.stated_score} 分，重算 ${att.result.score} 分` : undefined}
              />
            ))}
          </ol>

          {att?.ok && (
            <div className="rounded-lg bg-black/20 p-2.5 text-xs">
              <table className="w-full">
                <tbody>
                  {att.result.statuses.map((s) => (
                    <tr key={s.question_id} className="border-b border-white/5 last:border-0">
                      <td className="py-1 text-slate-400">{ROLE_TEXT[s.role]}</td>
                      <td className="py-1 text-slate-300">{QUESTION_TEXT[s.question_id]}</td>
                      <td className="py-1 text-right">
                        {s.state === "counted" ? (s.answer ? "是" : "否") : s.state === "missing" ? "没交" : "过期"}
                      </td>
                      <td className="py-1 pl-2 text-right tabular-nums text-slate-400">+{s.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-slate-400">
                强认证档位：{att.result.tier ? TIER_TEXT[att.result.tier] : "无"} · 分数给出 <ChannelBadge channel={att.result.score_channel} /> · 档位和核对给出{" "}
                <ChannelBadge channel={att.result.floor_channel} />
              </p>
            </div>
          )}

          <div className="rounded-xl border border-white/10 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-400">规则引擎</span>
              <ChannelBadge channel={d.engineChannel} />
              <span className="text-slate-500">与证明层取更严 →</span>
              <ChannelBadge channel={d.channel} size="lg" />
            </div>
            <p className="mt-2 text-sm text-slate-200">{d.userFacingReason}</p>
            {d.triggeredRules.length > 0 && <p className="mt-1 text-xs text-slate-500">命中规则：{d.triggeredRules.join("、")}</p>}
          </div>

          {order.credential && (
            <div className="rounded-xl bg-emerald-500/10 p-3 text-sm ring-1 ring-emerald-400/30">
              <p className="font-medium text-emerald-200">一次性凭证 {order.credential.credential_id}</p>
              <p className="text-xs text-emerald-100/80">
                锁死商户 {order.credential.merchant_id} · 金额 {hkd(order.credential.amount_hkd)} · 只能用一次 · {timeHK(order.credential.expires_at)} 过期
              </p>
              {order.card && <p className="mt-1 text-xs text-emerald-100/80">选卡：{order.card.reason}</p>}
              {order.settlement && (
                <p className="mt-1 text-xs text-emerald-100/80">
                  结算：{order.settlement.mode === "stripe_test" ? "Stripe 测试模式" : "模拟"} · {order.settlement.id} · {order.settlement.note}
                </p>
              )}
            </div>
          )}
          <p className="text-[11px] text-slate-500">订单编号 {short(order.order_hash, 16)}（覆盖商户、商品、数量、金额、收货地）</p>
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
    <Panel title="演示控制" subtitle="把时钟往后拨，看同一单怎么一级级变严。" accent="bg-sky-400">
      <div>
        <p className="mb-1 text-xs text-slate-400">演示时钟（距现在）</p>
        <div className="flex flex-wrap gap-2">
          {[0, 3, 13, 25].map((h) => (
            <Btn key={h} tone={state.clock_offset_hours === h ? "primary" : "default"} onClick={() => setClock(h)}>
              +{h} 小时
            </Btn>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">拨完之后让代理重新买一次。</p>
      </div>
      <div>
        <p className="mb-1 text-xs text-slate-400">授权书</p>
        {revoked ? (
          <Btn onClick={async () => (await api("/api/mandate/restore", {}), await refresh())}>恢复授权</Btn>
        ) : (
          <Btn tone="danger" onClick={async () => (await api("/api/mandate/revoke", {}), await refresh())}>
            一键撤销授权
          </Btn>
        )}
      </div>
      <div className="text-xs text-slate-400">
        <p>试试看：</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>打开「藏了劫持指令」再让代理买：收货地变成深圳仓，定位答「否」。</li>
          <li>交给银行前勾「把分数改成 100」：银行重算对不上，不发凭证。</li>
          <li>让代理「买 4 个」：超过单笔上限 HK$800，分数再高也拒绝。</li>
        </ul>
      </div>
      <Btn tone="ghost" onClick={async () => (await api("/api/reset", {}), location.reload())}>
        重置这个演示
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
      title="哈希链日志"
      subtitle="先记下代理被允许做什么，再记下它被拦住。每一条都串着上一条的哈希，改一条整条链就断。"
      accent="bg-amber-400"
      right={
        <div className="flex items-center gap-2">
          {checked && <span className="text-xs text-emerald-300">{checked}</span>}
          <Btn onClick={verify}>验证整条链</Btn>
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
        哪些是真的：商品、价格、库存来自真实香港 Shopify 网店（只读公开数据，不提交订单）；定位用你这台设备的真实位置在本地比对；签名、重算、规则引擎、哈希链都是真的。
      </p>
      <p>
        哪些是模拟的：指纹 / 面容确认；定位结论由设备自证（正式版由运营商签）；商户的购买记录；结算（Stripe 测试模式或模拟），不涉及真钱。
      </p>
    </footer>
  );
}
