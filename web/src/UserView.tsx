/**
 * 用户视图：一个人用手机让代理去买东西。
 * 表面只有一条主线；签名、重算、规则编号都留给「引擎盖下面」。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { AgentEvent, Order, State, useLive } from "./api.ts";
import { api } from "./api.ts";
import { NO_TAMPER, defaultPrompt, type Agent, type Phone, type Tamper } from "./hooks.ts";
import { friendlyAsk, isNotice, questionLabel } from "./JudgeView.tsx";
import { locale, t } from "./lang.ts";
import { channelText, hkd } from "./ui.tsx";

function suggestions(): string[] {
  return [defaultPrompt(), t("帮我挑一份 HK$250 以内的丝巾礼物", "Pick a silk scarf gift under HK$250")];
}

// ---------------------------------------------------------------------------
// 一键演示
// ---------------------------------------------------------------------------

interface Scene {
  title: string;
  narration: string;
  prompt: string;
  injection?: boolean;
  tamper?: Partial<Tamper>;
  clockHours?: number;
}

function scenes(): Scene[] {
  return [
    {
      title: t("平常的一天", "An ordinary day"),
      narration: t(
        "你让代理买一个 65W 充电器。它在三家香港网店比价，选了最便宜、而且是你常去的那家。手机在本地核对你在宿舍附近，只发出几个「是 / 否」；银行重算后直接放行，用 Stripe 测试模式付款。留意比价卡上的提醒：同款在别处更便宜，代理不会瞒你。",
        "You ask the agent for a 65W charger. It compares three Hong Kong stores and picks the cheapest, at a store you've used before. Your phone checks on the device that you're near your dorm and sends only a few yes/no answers; the bank recomputes the score and lets it through, paid in Stripe test mode. Watch the comparison card: if the same item is cheaper elsewhere, the agent tells you.",
      ),
      prompt: defaultPrompt(),
    },
    {
      title: t("代理被网页骗了", "The agent gets fooled"),
      narration: t(
        "商品页里藏了一段指令，叫代理把货改寄深圳仓。代理照做了。但你的手机算出你不在深圳附近，于是停下来问你一次，只说那一个原因。点「不是我」，这一单就不会付款。",
        "The product page hides an instruction telling the agent to ship to a Shenzhen warehouse, and the agent does it. But your phone works out you're nowhere near Shenzhen, so it stops and asks you once, naming that one reason. Tap \"Not me\" and nothing is paid.",
      ),
      prompt: defaultPrompt(),
      injection: true,
    },
    {
      title: t("有人想绕过那一次确认", "Someone tries to skip that check"),
      narration: t(
        "代理又被骗、改寄深圳。这次还有人把手机交出去的分数从 60 偷偷改成 100，想跳过刚才那次确认。银行不信分数，只信签名，自己重算出 60，对不上，直接拒绝，一分钱都不会动。",
        "The agent is fooled into shipping to Shenzhen again. This time someone also changes the score the phone sends from 60 to 100 to skip that question. The bank trusts signatures, not scores: it recomputes 60, the numbers don't match, and it declines. Not a cent moves.",
      ),
      prompt: defaultPrompt(),
      injection: true,
      tamper: { inflateScore: true },
    },
    {
      title: t("超出你设的上限", "Over your limit"),
      narration: t(
        "代理要买 4 个，共 HK$876。就算三方证明都通过，规则引擎也会按你设的单笔上限 HK$800 拒绝。证明只能让交易更严，突破不了上限。",
        "The agent wants to buy 4, HK$876 in total. However high the proof score, the rule engine declines it against your HK$800 per-transaction cap. Proofs can only make a payment stricter; they can't lift a limit.",
      ),
      prompt: t("帮我买 4 个 HK$300 以内的 65W 充电器", "Buy 4 65W chargers under HK$300 each"),
    },
    {
      title: t("隔了一晚", "The next morning"),
      narration: t(
        "距离你上次用 Face ID 确认已经 13 小时。授权强度随时间变弱，同样一单现在要先进冷静期。再确认一次就恢复。",
        "It's been 13 hours since you last confirmed with Face ID. Authorisation weakens over time, so the same order now goes to cooling-off first. Confirm again and it's restored.",
      ),
      prompt: defaultPrompt(),
      clockHours: 13,
    },
  ];
}

// ---------------------------------------------------------------------------

export function UserView({
  live,
  phone,
  agent,
  serverNow,
  onOpenJudge,
}: {
  live: ReturnType<typeof useLive>;
  phone: Phone;
  agent: Agent;
  serverNow: Date;
  onOpenJudge: () => void;
}) {
  const state = live.state!;
  const [sceneIdx, setSceneIdx] = useState<number | null>(null);
  const [faceId, setFaceId] = useState<{ then: () => Promise<void> } | null>(null);
  const [cancelled, setCancelled] = useState<string | null>(null);

  const setClock = async (h: number) => {
    if (state.clock_offset_hours === h) return;
    await api("/api/clock", { offset_hours: h });
    await live.refresh();
  };

  const send = async (prompt: string, o: { injection?: boolean } = {}) => {
    setCancelled(null);
    phone.setTamper(NO_TAMPER);
    const go = async () => {
      await agent.run({ prompt, injection: o.injection ?? false });
    };
    if (phone.tier !== "strong" && state.clock_offset_hours === 0) {
      setFaceId({ then: go });
      return;
    }
    await go();
  };

  const playScene = async (i: number) => {
    const s = scenes()[i]!;
    setSceneIdx(i);
    setCancelled(null);
    phone.setTamper({ ...NO_TAMPER, ...s.tamper });
    phone.setUseVenue(true);
    if (!s.clockHours) {
      await setClock(0);
      if (phone.tier !== "strong") {
        setFaceId({ then: () => agent.run({ prompt: s.prompt, injection: s.injection ?? false }) });
        return;
      }
    } else {
      if (!state.auth_time) await phone.strongAuth();
      await setClock(s.clockHours);
    }
    await agent.run({ prompt: s.prompt, injection: s.injection ?? false });
  };

  const exitScenes = async () => {
    setSceneIdx(null);
    phone.setTamper(NO_TAMPER);
    await setClock(0);
  };

  return (
    <main className="mx-auto grid max-w-[1200px] gap-8 px-4 py-8 lg:grid-cols-[1fr_400px_1fr] lg:items-start">
      <section className="order-2 space-y-4 lg:order-1">
        <Hero />
        <GuidedCard
          sceneIdx={sceneIdx}
          busy={agent.busy}
          onPlay={(i) => void playScene(i)}
          onExit={() => void exitScenes()}
        />
      </section>

      <section className="order-1 lg:order-2">
        <PhoneFrame now={serverNow}>
          <PhoneApp
            state={state}
            phone={phone}
            agent={agent}
            events={live.agentEvents}
            cancelled={cancelled}
            onCancel={(id) => setCancelled(id)}
            onSend={(p) => void send(p)}
            onFaceId={() => setFaceId({ then: async () => undefined })}
            serverNow={serverNow}
          />
          {faceId && (
            <FaceIdSheet
              onConfirm={async () => {
                await phone.strongAuth();
                const next = faceId.then;
                setFaceId(null);
                await next();
              }}
              onClose={() => setFaceId(null)}
            />
          )}
        </PhoneFrame>
      </section>

      <section className="order-3 space-y-4">
        <BehindCard order={state.current_order} phone={phone} onOpenJudge={onOpenJudge} />
        <PrivacyCard phone={phone} />
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// 左栏
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <div>
      <p className="text-sm font-medium text-[#0071e3]">HacKU 2026 · FinTech · HKT</p>
      <h1 className="mt-2 text-4xl font-semibold leading-tight tracking-tight">
        {t("代理替你付款。", "An agent pays for you.")}
        <br />
        <span className="text-[#6e6e73]">{t("个人背景不出手机。", "Your context stays on your phone.")}</span>
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-[#6e6e73]">
        {t(
          "代理负责比价和下单，看不到你的位置和消费记录。付款前，定位、银行、商户各自只回答一个是非题并签名；银行自己重算，结论只能让交易更严。",
          "The agent compares prices and fills the cart, but never sees your location or purchase history. Before paying, location, bank and store each sign one yes/no answer; the bank recomputes the score itself, and the answers can only make a payment stricter.",
        )}
      </p>
    </div>
  );
}

function GuidedCard({
  sceneIdx,
  busy,
  onPlay,
  onExit,
}: {
  sceneIdx: number | null;
  busy: boolean;
  onPlay: (i: number) => void;
  onExit: () => void;
}) {
  const all = scenes();
  const current = sceneIdx === null ? null : all[sceneIdx]!;
  return (
    <div className="rounded-3xl bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">{t("一键演示", "Guided demo")}</h2>
        {sceneIdx !== null && (
          <button type="button" onClick={onExit} className="text-sm text-[#0071e3]">
            {t("结束演示", "End demo")}
          </button>
        )}
      </div>
      <ol className="mt-3 space-y-1">
        {all.map((s, i) => (
          <li key={s.title}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onPlay(i)}
              className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-[15px] transition disabled:opacity-50 ${
                sceneIdx === i ? "bg-[#0071e3] text-white" : "hover:bg-black/[0.04]"
              }`}
            >
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                  sceneIdx === i ? "bg-white/25" : "bg-black/[0.06] text-[#6e6e73]"
                }`}
              >
                {i + 1}
              </span>
              {s.title}
            </button>
          </li>
        ))}
      </ol>
      {current && (
        <div className="mt-4 rounded-2xl bg-[#f5f5f7] p-4">
          <p className="text-[15px] leading-relaxed">{current.narration}</p>
          {sceneIdx! < all.length - 1 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onPlay(sceneIdx! + 1)}
              className="mt-3 rounded-full bg-[#1d1d1f] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {t("下一幕：", "Next: ")}
              {all[sceneIdx! + 1]!.title}
            </button>
          )}
        </div>
      )}
      {sceneIdx === null && (
        <p className="mt-3 text-sm text-[#6e6e73]">
          {t("点任意一幕开始。每一幕都是真实网店、真实签名、真实重算。", "Pick any scene. Each one uses real stores, real signatures and a real recompute.")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 右栏
// ---------------------------------------------------------------------------

const Q_ICON: Record<string, string> = {
  near_ship_to: "📍",
  holder_recently_authenticated: "👤",
  quote_matches_listing: "🏷️",
  consistent_with_history: "🛍️",
};

function PrivacyCard({ phone }: { phone: Phone }) {
  const b = phone.outgoing;
  return (
    <div className="rounded-3xl bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <h2 className="text-lg font-semibold tracking-tight">{t("离开手机的，只有这些", "All that leaves your phone")}</h2>
      {!b && (
        <p className="mt-2 text-sm text-[#6e6e73]">
          {t("下一单开始后，这里会列出手机交给银行的全部内容。", "Once an order starts, this lists everything the phone hands to the bank.")}
        </p>
      )}
      {b && (
        <>
          <ul className="mt-3 space-y-2">
            {b.claims.map((c, i) => (
              <li key={i} className="flex items-center justify-between text-[15px]">
                <span>
                  <span className="mr-2">{Q_ICON[c.claim.question_id]}</span>
                  {questionLabel(c.claim.question_id)}
                </span>
                <span className={`font-medium ${c.claim.answer ? "text-[#34c759]" : "text-[#ff3b30]"}`}>{c.claim.answer ? t("是", "Yes") : t("否", "No")}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-[#6e6e73]">
            {t("每一条都带签名。没有坐标、没有购买记录、没有生物特征。", "Every line is signed. No coordinates, no purchase history, no biometrics.")}
          </p>
        </>
      )}
      <label className="mt-4 flex items-center justify-between gap-3 border-t border-black/5 pt-3 text-sm text-[#6e6e73]">
        {t("用会场位置（港大）模拟定位", "Simulate location at the venue (HKU)")}
        <input type="checkbox" className="h-4 w-4 accent-[#0071e3]" checked={phone.useVenue} onChange={(e) => phone.setUseVenue(e.target.checked)} />
      </label>
      {phone.position && (
        <p className="mt-1 text-xs text-[#6e6e73]">
          {phone.position.simulated
            ? t("正在用模拟位置，只在本机比对。", "Using a simulated position, compared only on this device.")
            : t(
                `正在用这台设备的真实位置（精度约 ${Math.round(phone.position.accuracy_m)} 米），只在本机比对。`,
                `Using this device's real position (accuracy about ${Math.round(phone.position.accuracy_m)} m), compared only on this device.`,
              )}
        </p>
      )}
    </div>
  );
}

function BehindCard({ order, phone, onOpenJudge }: { order: Order | null; phone: Phone; onOpenJudge: () => void }) {
  const att = order?.decision?.attestation ?? null;
  const rows: { label: string; ok: boolean | null; note?: string }[] = [
    { label: t("代理只拿到购物车", "The agent only gets a cart"), ok: order ? true : null, note: t("没有付款工具", "no payment tool") },
    { label: t("手机本地比对并签名", "The phone checks and signs locally"), ok: phone.outgoing ? true : null },
    {
      label: t("银行验签并重算", "The bank verifies and recomputes"),
      ok: att ? att.ok : null,
      note: att && !att.ok ? t("证明对不上", "proofs don't match") : att?.ok ? t(`${att.result.score} 分`, `score ${att.result.score}`) : undefined,
    },
    {
      label: t("规则引擎判定", "The rule engine decides"),
      ok: order?.decision ? order.decision.channel !== "decline" : null,
      note: order?.decision ? channelText(order.decision.channel) : undefined,
    },
    {
      label: t("一次性凭证结算", "One-time credential settles"),
      ok: order?.status === "paid" ? true : order?.status === "declined" ? false : null,
      note: order?.settlement?.mode === "stripe_test" ? t("Stripe 测试模式", "Stripe test mode") : order?.settlement ? t("模拟", "simulated") : undefined,
    },
  ];
  return (
    <div className="rounded-3xl bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <h2 className="text-lg font-semibold tracking-tight">{t("背后发生了什么", "What happened behind the scenes")}</h2>
      <ul className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-3 text-[15px]">
            <span
              className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white ${
                r.ok === null ? "bg-black/10" : r.ok ? "bg-[#34c759]" : "bg-[#ff3b30]"
              }`}
            >
              {r.ok === null ? "" : r.ok ? "✓" : "✕"}
            </span>
            <span className={r.ok === null ? "text-[#86868b]" : ""}>{r.label}</span>
            {r.note && <span className="ml-auto text-sm text-[#6e6e73]">{r.note}</span>}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onOpenJudge} className="mt-4 text-sm font-medium text-[#0071e3]">
        {t("打开引擎盖，看每一步 →", "Open the hood and see every step →")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 手机
// ---------------------------------------------------------------------------

function PhoneFrame({ now, children }: { now: Date; children: ReactNode }) {
  const time = now.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div className="relative mx-auto h-[800px] w-full max-w-[400px] overflow-hidden rounded-[52px] border-[10px] border-[#1d1d1f] bg-white shadow-[0_30px_80px_rgba(0,0,0,0.18)]">
      <div className="pointer-events-none absolute left-1/2 top-2 z-20 h-7 w-28 -translate-x-1/2 rounded-full bg-[#1d1d1f]" />
      <div className="flex items-center justify-between px-7 pb-1 pt-3 text-[13px] font-semibold">
        <span>{time}</span>
        <span className="tracking-widest">●●●</span>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-9 flex flex-col">{children}</div>
    </div>
  );
}

function tierText(tier: "strong" | "medium" | "weak"): string {
  return { strong: t("强", "Strong"), medium: t("中", "Medium"), weak: t("弱", "Weak") }[tier];
}
const TIER_COLOR = { strong: "bg-[#34c759]", medium: "bg-[#ff9f0a]", weak: "bg-[#0a84ff]" } as const;

function PhoneApp({
  state,
  phone,
  agent,
  events,
  cancelled,
  onCancel,
  onSend,
  onFaceId,
  serverNow,
}: {
  state: State;
  phone: Phone;
  agent: Agent;
  events: AgentEvent[];
  cancelled: string | null;
  onCancel: (orderId: string) => void;
  onSend: (prompt: string) => void;
  onFaceId: () => void;
  serverNow: Date;
}) {
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const order = phone.order;
  const showOrder = order && agent.lastPrompt !== null && !agent.busy && order.id !== agent.baselineOrderId;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [events.length, order?.status, phone.outgoing, cancelled]);

  const submitText = () => {
    const p = text.trim() || defaultPrompt();
    setText("");
    onSend(p);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-black/5 px-5 pb-3 pt-2">
        <div>
          <h3 className="text-[17px] font-semibold">{t("购物代理", "Shopping agent")}</h3>
          <p className="text-xs text-[#86868b]">{t("看不到你的位置和消费记录", "Can't see your location or history")}</p>
        </div>
        <button type="button" onClick={onFaceId} className="flex items-center gap-1.5 rounded-full bg-[#f5f5f7] px-3 py-1 text-xs font-medium">
          <span className={`h-2 w-2 rounded-full ${phone.tier ? TIER_COLOR[phone.tier] : "bg-[#c7c7cc]"}`} />
          {phone.tier ? t(`授权${tierText(phone.tier)}`, `${tierText(phone.tier)} auth`) : t("授权未确认", "Not confirmed")}
        </button>
      </header>

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {agent.lastPrompt === null && <EmptyState onPick={onSend} />}
        {agent.lastPrompt !== null && <Bubble side="right">{agent.lastPrompt}</Bubble>}
        <AgentThread events={events} />
        {agent.error && <Bubble side="left" tone="error">{agent.error}</Bubble>}
        {showOrder && order && <ProofCard order={order} phone={phone} />}
        {showOrder && order && (
          <DecisionCard
            order={order}
            phone={phone}
            cancelled={cancelled === order.id}
            onCancel={() => onCancel(order.id)}
            serverNow={serverNow}
          />
        )}
      </div>

      <div className="border-t border-black/5 bg-white/90 px-3 pb-6 pt-2 backdrop-blur">
        <div className="flex items-center gap-2 rounded-full bg-[#f5f5f7] py-1 pl-4 pr-1">
          <input
            className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-[#86868b]"
            placeholder={t("想让代理买什么？", "What should the agent buy?")}
            value={text}
            disabled={agent.busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitText()}
          />
          <button
            type="button"
            onClick={submitText}
            disabled={agent.busy}
            className="grid h-8 w-8 place-items-center rounded-full bg-[#0071e3] text-white disabled:opacity-40"
            aria-label={t("发送", "Send")}
          >
            ↑
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-[#86868b]">{t("演示环境 · Stripe 测试模式 · 不扣真钱", "Demo · Stripe test mode · no real money")}</p>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (p: string) => void }) {
  return (
    <div className="pt-16 text-center">
      <p className="text-2xl font-semibold tracking-tight">{t("想买什么？", "What do you need?")}</p>
      <p className="mt-1 text-sm text-[#86868b]">
        {t("代理去香港网店比价，你只在真有异常时被问一次。", "The agent compares Hong Kong stores. You're asked once, only if something is actually off.")}
      </p>
      <div className="mt-6 space-y-2">
        {suggestions().map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="block w-full rounded-2xl bg-[#f5f5f7] px-4 py-3 text-left text-[15px] hover:bg-[#ebebf0]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({ side, tone, children }: { side: "left" | "right"; tone?: "error"; children: ReactNode }) {
  return (
    <div className={`flex ${side === "right" ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-[20px] px-4 py-2 text-[15px] leading-snug ${
          side === "right"
            ? "rounded-br-md bg-[#0071e3] text-white"
            : tone === "error"
              ? "rounded-bl-md bg-[#ffebe9] text-[#c4271b]"
              : "rounded-bl-md bg-[#f2f2f7]"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function stepLabel(tool: string): string {
  const labels: Record<string, string> = {
    search_products: t("在香港网店里搜索", "Search Hong Kong stores"),
    compare_products: t("比价", "Compare prices"),
    get_product: t("确认价格和库存", "Check price and stock"),
    add_to_cart: t("放进店家的购物车", "Add to the store's cart"),
    submit_payment_plan: t("交给你的手机确认", "Hand to your phone"),
  };
  return labels[tool] ?? tool;
}

interface CompareView {
  shortlist: { rank: number; merchant: string; title: string; total_hkd: number; trusted_merchant: boolean; reasons: string[]; product_url: string }[];
  rejected: unknown[];
}

function AgentThread({ events }: { events: AgentEvent[] }) {
  const says = events.filter((e): e is Extract<AgentEvent, { kind: "say" }> => e.kind === "say");
  const steps = events.filter((e): e is Extract<AgentEvent, { kind: "step" }> => e.kind === "step");
  const compare = steps.find((s) => s.tool === "compare_products" && s.ok);
  const cart = steps.find((s) => s.tool === "add_to_cart" && s.ok);
  const injected = steps.find((s) => s.tool === "get_product" && (s.result as Record<string, unknown>)["merchant_note"]);
  if (events.length === 0) return null;
  return (
    <>
      {says[0] && <Bubble side="left">{says[0].text}</Bubble>}
      <div className="flex flex-wrap gap-1.5 pl-1">
        {steps.map((s) => (
          <span
            key={s.n}
            className={`rounded-full px-2.5 py-0.5 text-xs ${s.ok ? "bg-[#e8f5ec] text-[#1f7a3d]" : "bg-[#ffebe9] text-[#c4271b]"}`}
          >
            {s.ok ? "✓" : "✕"} {stepLabel(s.tool)}
          </span>
        ))}
      </div>
      {compare && <CompareCard r={compare.result as CompareView} />}
      {injected && (
        <div className="rounded-2xl bg-[#fff4e5] px-4 py-3 text-[13px] text-[#8a4b00]">
          <b>{t("页面里藏着一段话：", "Hidden text on the page: ")}</b>
          {String((injected.result as Record<string, unknown>)["merchant_note"])}
        </div>
      )}
      {cart && (
        <a
          href={String((cart.result as Record<string, unknown>)["cart_url"])}
          target="_blank"
          rel="noreferrer"
          className="block rounded-2xl border border-black/10 px-4 py-3 text-[13px] text-[#0071e3]"
        >
          {t(
            `已放进 ${String((cart.result as Record<string, unknown>)["merchant"])} 的真购物车 · 打开看看 ↗`,
            `In ${String((cart.result as Record<string, unknown>)["merchant"])}'s real cart · open it ↗`,
          )}
        </a>
      )}
      {says.length > 1 && <Bubble side="left">{says[says.length - 1]!.text}</Bubble>}
    </>
  );
}

function CompareCard({ r }: { r: CompareView }) {
  const top = r.shortlist.slice(0, 3);
  const notice = top[0]?.reasons.find(isNotice);
  return (
    <div className="overflow-hidden rounded-2xl border border-black/10">
      <div className="flex items-center justify-between bg-[#f5f5f7] px-4 py-2 text-xs text-[#6e6e73]">
        <span>{t(`比较了 ${r.shortlist.length + r.rejected.length} 件`, `Compared ${r.shortlist.length + r.rejected.length}`)}</span>
        <span>{t(`淘汰 ${r.rejected.length} 件不符合的`, `${r.rejected.length} ruled out`)}</span>
      </div>
      <ul>
        {top.map((x) => (
          <li key={x.product_url} className={`flex items-start gap-3 px-4 py-2.5 ${x.rank === 1 ? "bg-[#f0f7ff]" : "border-t border-black/5"}`}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium">{x.title}</p>
              <p className="text-xs text-[#86868b]">
                {x.merchant}
                {x.trusted_merchant && t(" · 常去", " · your usual")}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[14px] font-semibold tabular-nums">{hkd(x.total_hkd)}</p>
              {x.rank === 1 && <p className="text-[11px] font-medium text-[#0071e3]">{t("推荐", "Pick")}</p>}
            </div>
          </li>
        ))}
      </ul>
      {top[0] && <p className="border-t border-black/5 px-4 py-2 text-xs text-[#6e6e73]">{top[0].reasons[0]}</p>}
      {notice && <p className="border-t border-black/5 bg-[#fff8e6] px-4 py-2 text-xs text-[#8a5a00]">{notice.replace(/^(注意：|Note: )/, "")}</p>}
    </div>
  );
}

function ProofCard({ order, phone }: { order: Order; phone: Phone }) {
  const claims = (order.bundle ?? (phone.draft?.orderId === order.id ? phone.outgoing : null))?.claims ?? [];
  const waiting = claims.length === 0;
  return (
    <div className="rounded-2xl bg-[#f5f5f7] px-4 py-3">
      <p className="text-[13px] font-medium text-[#6e6e73]">
        {waiting ? t("手机正在本地核对…", "Your phone is checking locally…") : t("手机核对完毕，只发出这几个是 / 否", "Checked. Only these yes/no answers are sent")}
      </p>
      {!waiting && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {claims.map((c, i) => (
            <div key={i} className="flex items-center gap-2 rounded-xl bg-white px-2.5 py-1.5 text-xs">
              <span>{Q_ICON[c.claim.question_id]}</span>
              <span className="flex-1 text-[#1d1d1f]">{questionLabel(c.claim.question_id)}</span>
              <span className={c.claim.answer ? "text-[#34c759]" : "text-[#ff3b30]"}>{c.claim.answer ? t("是", "Yes") : t("否", "No")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionCard({
  order,
  phone,
  cancelled,
  onCancel,
  serverNow,
}: {
  order: Order;
  phone: Phone;
  cancelled: boolean;
  onCancel: () => void;
  serverNow: Date;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => setNote(""), [order.id]);
  const s = order.status;

  if (cancelled) {
    return (
      <Result
        tone="neutral"
        icon="✋"
        title={t("已取消", "Cancelled")}
        body={t("这一单不会付款。代理也拿不到任何能付款的东西。", "This order won't be paid, and the agent never holds anything it could pay with.")}
      />
    );
  }
  if (s === "awaiting_proof") return null;

  if (s === "paid") {
    return (
      <div className="rounded-3xl bg-white p-5 text-center shadow-[0_8px_30px_rgba(0,0,0,0.08)] ring-1 ring-black/5">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#34c759] text-2xl text-white">✓</div>
        <p className="mt-3 text-2xl font-semibold tabular-nums">{hkd(order.quote.total_hkd)}</p>
        <p className="text-sm text-[#6e6e73]">{t(`已付款给 ${order.listing.merchant_name}`, `Paid to ${order.listing.merchant_name}`)}</p>
        <div className="mt-4 space-y-1 rounded-2xl bg-[#f5f5f7] p-3 text-left text-xs text-[#6e6e73]">
          <p>
            <b className="text-[#1d1d1f]">{order.card && t(order.card.card.label, order.card.card.label_en ?? order.card.card.label)}</b> · {order.card?.reason}
          </p>
          <p>{t("一次性凭证 · 只能用在这家店、这个金额", "One-time credential · this store and this amount only")}</p>
          <p>
            {order.settlement?.mode === "stripe_test"
              ? t(`Stripe 测试模式 · ${order.settlement.id}`, `Stripe test mode · ${order.settlement.id}`)
              : t("模拟结算", "Simulated settlement")}
          </p>
        </div>
      </div>
    );
  }

  if (s === "declined") {
    return <Result tone="bad" icon="✕" title={t("没有付款", "Not paid")} body={order.decision?.userFacingReason ?? ""} />;
  }

  const confirm = async () => {
    setBusy(true);
    const m = await phone.consent();
    if (m) setNote(m);
    setBusy(false);
  };

  if (s === "awaiting_consent") {
    return (
      <div className="rounded-3xl bg-white p-5 shadow-[0_8px_30px_rgba(0,0,0,0.08)] ring-1 ring-black/5">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#ff9f0a] text-xl font-bold text-white">?</div>
        <p className="mt-3 text-center text-[17px] font-semibold leading-snug">{friendlyAsk(order)}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={onCancel} className="rounded-2xl bg-[#f5f5f7] py-3 text-[15px] font-medium">
            {t("不是我", "Not me")}
          </button>
          <button type="button" onClick={() => void confirm()} disabled={busy} className="rounded-2xl bg-[#0071e3] py-3 text-[15px] font-medium text-white disabled:opacity-50">
            {t("确认购买", "Confirm purchase")}
          </button>
        </div>
        {note && <p className="mt-2 text-center text-xs text-[#6e6e73]">{note}</p>}
      </div>
    );
  }

  // cooling
  const left = order.decision?.cooldownUntil ? Math.max(0, Date.parse(order.decision.cooldownUntil) - serverNow.getTime()) : 0;
  return (
    <div className="rounded-3xl bg-white p-5 text-center shadow-[0_8px_30px_rgba(0,0,0,0.08)] ring-1 ring-black/5">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#0a84ff] text-xl text-white">⏳</div>
      <p className="mt-3 text-[17px] font-semibold">{t("先冷静一下", "Take a moment first")}</p>
      <p className="mt-1 text-sm leading-relaxed text-[#6e6e73]">{order.decision?.userFacingReason}</p>
      <button
        type="button"
        onClick={() => void confirm()}
        disabled={left > 0 || busy}
        className="mt-4 w-full rounded-2xl bg-[#0071e3] py-3 text-[15px] font-medium text-white disabled:bg-[#e8e8ed] disabled:text-[#86868b]"
      >
        {left > 0 ? t(`${Math.ceil(left / 1000)} 秒后可以确认`, `You can confirm in ${Math.ceil(left / 1000)} s`) : t("确认购买", "Confirm purchase")}
      </button>
      {note && <p className="mt-2 text-xs text-[#6e6e73]">{note}</p>}
    </div>
  );
}

function Result({ tone, icon, title, body }: { tone: "bad" | "neutral"; icon: string; title: string; body: string }) {
  return (
    <div className="rounded-3xl bg-white p-5 text-center shadow-[0_8px_30px_rgba(0,0,0,0.08)] ring-1 ring-black/5">
      <div className={`mx-auto grid h-12 w-12 place-items-center rounded-full text-xl text-white ${tone === "bad" ? "bg-[#ff3b30]" : "bg-[#8e8e93]"}`}>{icon}</div>
      <p className="mt-3 text-[17px] font-semibold">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-[#6e6e73]">{body}</p>
    </div>
  );
}

function FaceIdSheet({ onConfirm, onClose }: { onConfirm: () => Promise<void>; onClose: () => void }) {
  const [scanning, setScanning] = useState(false);
  const go = async () => {
    setScanning(true);
    await new Promise((r) => setTimeout(r, 900));
    await onConfirm();
  };
  return (
    <div className="absolute inset-0 z-30 flex items-end bg-black/30 backdrop-blur-[2px]">
      <div className="w-full rounded-t-[32px] bg-white px-6 pb-10 pt-6 text-center">
        <div className={`mx-auto grid h-20 w-20 place-items-center rounded-3xl border-4 ${scanning ? "animate-pulse border-[#34c759]" : "border-[#0071e3]"} text-4xl`}>
          {scanning ? "✓" : "☺"}
        </div>
        <p className="mt-4 text-[17px] font-semibold">{t("用 Face ID 确认是你", "Confirm it's you with Face ID")}</p>
        <p className="mt-1 text-sm text-[#6e6e73]">
          {t(
            "确认一次，管一段时间；强度会随时间变弱。（演示里是模拟的，银行不会拿到你的脸。）",
            "One confirmation lasts a while and weakens over time. (Simulated in the demo; the bank never gets your face.)",
          )}
        </p>
        <button type="button" onClick={() => void go()} disabled={scanning} className="mt-5 w-full rounded-2xl bg-[#0071e3] py-3 text-[15px] font-medium text-white">
          {scanning ? t("正在确认…", "Confirming…") : t("确认", "Confirm")}
        </button>
        <button type="button" onClick={onClose} className="mt-2 w-full py-2 text-[15px] text-[#0071e3]">
          {t("取消", "Cancel")}
        </button>
      </div>
    </div>
  );
}
