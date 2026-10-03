import type { ReactNode } from "react";

import type { Channel } from "../../src/engine/types.ts";
import { locale, t } from "./lang.ts";

export function channelText(c: Channel): string {
  return {
    instant: t("直接执行", "Go ahead"),
    ask_once: t("问你一次", "Ask once"),
    cooldown: t("冷静期", "Cooling-off"),
    decline: t("拒绝", "Decline"),
  }[c];
}

const CHANNEL_STYLE: Record<Channel, string> = {
  instant: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
  ask_once: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
  cooldown: "bg-sky-500/15 text-sky-300 ring-sky-400/30",
  decline: "bg-rose-500/15 text-rose-300 ring-rose-400/30",
};

export function ChannelBadge({ channel, size = "sm" }: { channel: Channel; size?: "sm" | "lg" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full ring-1 font-medium ${CHANNEL_STYLE[channel]} ${
        size === "lg" ? "px-3 py-1 text-base" : "px-2 py-0.5 text-xs"
      }`}
    >
      {channelText(channel)}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  accent,
  children,
  right,
}: {
  title: string;
  subtitle?: string;
  accent: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-slate-900/70 shadow-xl">
      <header className="flex items-start justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <span className={`h-2.5 w-2.5 rounded-full ${accent}`} />
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
        </div>
        {right}
      </header>
      <div className="flex flex-1 flex-col gap-3 p-4">{children}</div>
    </section>
  );
}

export function Json({ value, max = 320 }: { value: unknown; max?: number }) {
  return (
    <pre
      className="overflow-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-slate-300"
      style={{ maxHeight: max }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Btn({
  children,
  onClick,
  disabled,
  tone = "default",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger" | "ghost";
  title?: string;
}) {
  const tones = {
    default: "bg-white/10 hover:bg-white/15 text-slate-100",
    primary: "bg-indigo-500 hover:bg-indigo-400 text-white",
    danger: "bg-rose-500/80 hover:bg-rose-500 text-white",
    ghost: "bg-transparent hover:bg-white/10 text-slate-300 ring-1 ring-white/15",
  };
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-rose-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Check({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  const icon = ok === null ? "·" : ok ? "✓" : "✗";
  const color = ok === null ? "text-slate-500" : ok ? "text-emerald-400" : "text-rose-400";
  return (
    <li className="flex gap-2 text-sm">
      <span className={`w-4 shrink-0 text-center font-bold ${color}`}>{icon}</span>
      <span className={ok === null ? "text-slate-500" : "text-slate-200"}>
        {label}
        {detail && <span className="block text-xs text-slate-400">{detail}</span>}
      </span>
    </li>
  );
}

export function hkd(n: number): string {
  return `HK$${n.toLocaleString("en-HK", { maximumFractionDigits: 2 })}`;
}

export function short(hash: string | null | undefined, n = 10): string {
  if (!hash) return "—";
  return hash.length > n ? `${hash.slice(0, n)}…` : hash;
}

export function timeHK(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
