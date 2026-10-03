/**
 * 两种视图共用的逻辑：手机（本地比对定位、收集结论、打包、交给银行、同意）和代理（发起一次购物）。
 * 放在 App 顶层只跑一份，切换视图时状态不丢。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { computeScore, strengthTier } from "../../src/attest/score.ts";
import type { Bundle, SignedClaim } from "../../src/attest/types.ts";
import { api, fetchClaims, type State, type useLive } from "./api.ts";
import { NEAR_SHIP_TO_KM, VENUE, currentPosition, deviceKey, distanceKm, signLocationClaim, type Position } from "./device.ts";
import { t } from "./lang.ts";

export function defaultPrompt(): string {
  return t("帮我买一个 HK$300 以内的 65W 充电器，寄到宿舍", "Buy me a 65W charger under HK$300, ship to my dorm");
}

export interface Draft {
  orderId: string;
  /** 收集时的授权状态；变了就重新收集 */
  key: string;
  bundle: Bundle;
  distance_km: number | null;
  near: boolean | null;
  locationNote: string;
}

export interface Tamper {
  dropUnfavorable: boolean;
  inflateScore: boolean;
  replayPrevious: boolean;
}

export const NO_TAMPER: Tamper = { dropUnfavorable: false, inflateScore: false, replayPrevious: false };

export function useServerNow(state: State | null): Date {
  const [skew, setSkew] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (state) setSkew(Date.parse(state.now) - Date.now());
  }, [state?.now, state?.clock_offset_hours]);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => new Date(Date.now() + skew), [skew, tick]);
}

export function usePhone(state: State | null, refresh: () => Promise<void>, serverNow: Date, autoSubmit: boolean) {
  const order = state?.current_order ?? null;
  const [position, setPosition] = useState<Position | null>(null);
  const [posError, setPosError] = useState("");
  const [useVenue, setUseVenue] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tamper, setTamper] = useState<Tamper>(NO_TAMPER);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deviceError, setDeviceError] = useState("");
  const [collectNonce, setCollectNonce] = useState(0);
  const prevBundle = useRef<Bundle | null>(null);
  const consentShownAt = useRef<number>(0);
  const submittedFor = useRef<string | null>(null);

  const tier = state?.auth_time ? strengthTier(state.auth_time, serverNow) : null;

  const strongAuth = async () => {
    setDeviceError("");
    let key: string | null = null;
    try {
      key = (await deviceKey()).publicX;
    } catch {
      setDeviceError(
        t(
          "这个浏览器不支持 Ed25519，定位结论会按缺失计。换新版 Chrome、Edge 或 Safari 即可。",
          "This browser doesn't support Ed25519, so the location answer counts as missing. A recent Chrome, Edge or Safari works.",
        ),
      );
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

  const draftKey = `${state?.auth_time ?? "-"}|${state?.device_key ?? "-"}|${state?.clock_offset_hours}|${useVenue}|${collectNonce}`;

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
      if (!state?.device_key) {
        note = t("这台设备还没做强认证、没登记钥匙，定位结论按缺失计。", "This device hasn't done strong authentication or registered a key yet, so the location answer counts as missing.");
      } else if (!pos) {
        note = t("拿不到位置，定位结论按缺失计。", "No location available, so the location answer counts as missing.");
      } else {
        dist = distanceKm(pos, order.ship_to_place);
        near = dist <= NEAR_SHIP_TO_KM;
        all.unshift(await signLocationClaim(order.order_hash, near, at));
        note = t(
          `本地算出离「${order.ship_to_place.label}」${dist.toFixed(1)} 公里，所以回答「${near ? "是" : "否"}」。坐标没有离开这台设备。`,
          `Computed on this device: ${dist.toFixed(1)} km from "${order.ship_to_place.label}", so the answer is "${near ? "yes" : "no"}". The coordinates never left this device.`,
        );
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
    submittedFor.current = order.id;
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

  // 用户视图：证明包一准备好就自动交给银行
  useEffect(() => {
    if (!autoSubmit || !order || order.status !== "awaiting_proof") return;
    if (!draft || draft.orderId !== order.id || draft.key !== draftKey) return;
    if (submittedFor.current === order.id || busy) return;
    void submit();
  }, [autoSubmit, order?.id, order?.status, draft, draftKey]);

  const tamperShipTo = async () => {
    if (!order) return;
    await api(`/api/orders/${order.id}/tamper-ship-to`, {});
    await refresh();
    setMessage(
      t(
        "代理在结论签完之后把收货地改成了深圳仓。手机里这份证明包还是按原收货地签的。",
        "After the answers were signed, the agent changed the ship-to to the Shenzhen warehouse. The bundle on the phone is still signed for the original address.",
      ),
    );
  };

  const consent = async () => {
    if (!order) return null;
    const latency = Date.now() - consentShownAt.current;
    const r = await api<{ message: string }>(`/api/orders/${order.id}/consent`, { latency_ms: latency });
    setMessage(t(`${r.message}（你用了 ${(latency / 1000).toFixed(1)} 秒）`, `${r.message} (you took ${(latency / 1000).toFixed(1)} s)`));
    await refresh();
    return r.message;
  };

  const cooldownLeft = order?.decision?.cooldownUntil ? Math.max(0, Date.parse(order.decision.cooldownUntil) - serverNow.getTime()) : 0;

  return {
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
    setMessage,
    deviceError,
    prevBundle,
    cooldownLeft,
    strongAuth,
    submit,
    tamperShipTo,
    consent,
    recollect: () => setCollectNonce((n) => n + 1),
  };
}

export type Phone = ReturnType<typeof usePhone>;

export function useAgent(live: ReturnType<typeof useLive>) {
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [mode, setMode] = useState<"scripted" | "llm">("scripted");
  const [injection, setInjection] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  /** 发起这次购物时屏幕上已有的订单；只有之后新出现的订单才属于这次 */
  const [baselineOrderId, setBaselineOrderId] = useState<string | null>(null);

  const run = async (o: { prompt?: string; injection?: boolean } = {}) => {
    const p = o.prompt ?? prompt;
    setError("");
    live.setAgentEvents([]);
    setLastPrompt(p);
    setBaselineOrderId(live.state?.current_order?.id ?? null);
    try {
      await api("/api/agent/run", { mode, prompt: p, injection: o.injection ?? injection, access_code: code || undefined });
      await live.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return {
    prompt,
    setPrompt,
    mode,
    setMode,
    injection,
    setInjection,
    code,
    setCode,
    error,
    run,
    lastPrompt,
    baselineOrderId,
    busy: live.state?.agent_busy ?? false,
  };
}

export type Agent = ReturnType<typeof useAgent>;
