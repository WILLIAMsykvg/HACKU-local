import { useEffect, useRef, useState } from "react";

import type { Bundle, ScoreResult, SignedClaim, StrengthTier } from "../../src/attest/types.ts";
import type { Channel, ConsentDecision, Credential, Mandate, Quote, RuleId } from "../../src/engine/types.ts";
import { getLang, t } from "./lang.ts";

export interface Listing {
  merchant_id: string;
  merchant_name: string;
  domain: string;
  title: string;
  variant_title: string;
  price_hkd: number;
  available: boolean;
  url: string;
  fetched_at: string;
  source: "live" | "snapshot";
}

export type Attestation =
  | { ok: true; result: ScoreResult }
  | { ok: false; code: string; reason: string };

export interface Decision {
  channel: Channel;
  engineChannel: Channel;
  triggeredRules: RuleId[];
  primaryReasonRule: RuleId | null;
  userFacingReason: string;
  cooldownUntil: string | null;
  orderHash: string;
  attestation: Attestation | null;
}

export interface Place {
  label: string;
  lat: number;
  lng: number;
}

export interface Order {
  id: string;
  created_at: string;
  status: "awaiting_proof" | "awaiting_consent" | "cooling" | "paid" | "declined";
  listing: Listing;
  qty: number;
  cart_url: string;
  ship_to: string;
  ship_to_place: Place;
  ship_to_tampered: boolean;
  agent_reason: string;
  quote: Quote;
  order_hash: string;
  bundle: Bundle | null;
  decision: Decision | null;
  consent: ConsentDecision | null;
  credential: Credential | null;
  card: { card: { label: string; label_en?: string }; reason: string; considered: { label: string; note: string }[] } | null;
  settlement: { mode: string; id: string; status: string; note: string } | null;
}

export interface LogEntry {
  seq: number;
  at: string;
  actor: string;
  event: string;
  entry_hash: string;
  prev_hash: string;
  [k: string]: unknown;
}

export interface State {
  now: string;
  clock_offset_hours: number;
  mandate: Mandate;
  auth_time: string | null;
  tier: StrengthTier | null;
  device_key: string | null;
  keys: { bank: string; merchant: string; location: string | null };
  ship_to: Record<string, Place>;
  stores: { merchant_id: string; name: string; domain: string }[];
  current_order: Order | null;
  log: LogEntry[];
  chain: { ok: boolean; reason: string };
  agent_busy: boolean;
}

export interface Config {
  llm_available: boolean;
  llm_requires_code: boolean;
  search_live: boolean;
  reference_via: "serpapi" | "tavily" | "none";
  stripe_test: boolean;
}

export type AgentEvent =
  | { kind: "say"; text: string }
  | { kind: "step"; n: number; tool: string; args: unknown; ok: boolean; result: unknown };

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? { "X-Lang": getLang() } : { "Content-Type": "application/json", "X-Lang": getLang() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? t(`请求失败（${res.status}）`, `Request failed (${res.status})`));
  return data;
}

export function fetchClaims(orderId: string) {
  return api<{ claims: SignedClaim[]; now: string }>(`/api/orders/${orderId}/claims`, {});
}

export function useLive() {
  const [state, setState] = useState<State | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let stopped = false;

    const open = () => {
      const es = new EventSource(`/api/events?lang=${getLang()}`);
      esRef.current = es;
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es.close();
        if (!stopped) setTimeout(open, 1500);
      };
      es.addEventListener("state", (e) => setState(JSON.parse((e as MessageEvent).data) as State));
      es.addEventListener("order", (e) => {
        const o = JSON.parse((e as MessageEvent).data) as Order;
        setState((s) => (s ? { ...s, current_order: o } : s));
      });
      es.addEventListener("log", (e) => {
        const entry = JSON.parse((e as MessageEvent).data) as LogEntry;
        setState((s) => (s ? { ...s, log: [...s.log.filter((x) => x.seq !== entry.seq), entry] } : s));
      });
      es.addEventListener("agent", (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as AgentEvent;
        setAgentEvents((xs) => [...xs, ev]);
      });
    };

    // 先拿到会话 cookie 和初始状态，再连实时推送；否则并发的首个请求会各开一个会话
    (async () => {
      try {
        setState(await api<State>("/api/state"));
      } catch {
        // 连不上就交给 EventSource 重连
      }
      api<Config>("/api/config").then(setConfig).catch(() => undefined);
      if (!stopped) open();
    })();
    return () => {
      stopped = true;
      esRef.current?.close();
    };
  }, []);

  const refresh = async () => setState(await api<State>("/api/state"));

  return { state, setState, config, agentEvents, setAgentEvents, connected, refresh };
}
