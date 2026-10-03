import { useState } from "react";

import { useLive } from "./api.ts";
import { defaultPrompt, useAgent, usePhone, useServerNow } from "./hooks.ts";
import { JudgeView } from "./JudgeView.tsx";
import { getLang, setLang, t, type Lang } from "./lang.ts";
import { UserView } from "./UserView.tsx";

type View = "user" | "judge";

export default function App() {
  const live = useLive();
  const serverNow = useServerNow(live.state);
  const [view, setView] = useState<View>(() => (location.hash === "#judge" ? "judge" : "user"));
  const [lang, setLangState] = useState<Lang>(getLang);
  const phone = usePhone(live.state, live.refresh, serverNow, view === "user");
  const agent = useAgent(live);

  const switchTo = (v: View) => {
    setView(v);
    history.replaceState(null, "", v === "judge" ? "#judge" : "#");
  };

  const switchLang = (l: Lang) => {
    if (l === lang) return;
    const wasDefault = agent.prompt === defaultPrompt();
    setLang(l);
    setLangState(l);
    if (wasDefault) agent.setPrompt(defaultPrompt());
    void live.refresh();
  };

  if (!live.state) {
    return <div className="grid min-h-screen place-items-center bg-[#f5f5f7] text-[#6e6e73]">{t("正在连接…", "Connecting…")}</div>;
  }

  const light = view === "user";
  return (
    <div className={light ? "min-h-screen bg-[#f5f5f7] text-[#1d1d1f]" : "min-h-screen bg-slate-950 text-slate-100"}>
      <nav
        className={`sticky top-0 z-30 border-b backdrop-blur-xl ${
          light ? "border-black/5 bg-white/70" : "border-white/10 bg-slate-950/70"
        }`}
      >
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-3 px-4 py-2.5">
          <span className="text-sm font-semibold tracking-tight">Local Deployment</span>
          <div className={`inline-flex rounded-full p-0.5 text-sm ${light ? "bg-black/5" : "bg-white/10"}`}>
            {(
              [
                ["user", t("体验", "Experience")],
                ["judge", t("引擎盖下面", "Under the hood")],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => switchTo(v)}
                className={`rounded-full px-4 py-1 transition ${
                  view === v
                    ? light
                      ? "bg-white text-[#1d1d1f] shadow-sm"
                      : "bg-white/90 text-slate-900"
                    : light
                      ? "text-[#6e6e73]"
                      : "text-slate-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className={`hidden text-xs sm:inline ${light ? "text-[#6e6e73]" : "text-slate-400"}`}>
              {t("演示环境 · 不涉及真实付款", "Demo · no real payments")}
            </span>
            <div className={`inline-flex rounded-full p-0.5 text-xs font-medium ${light ? "bg-black/5" : "bg-white/10"}`}>
              {(
                [
                  ["zh", "中文"],
                  ["en", "EN"],
                ] as const
              ).map(([l, label]) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => switchLang(l)}
                  className={`rounded-full px-2.5 py-0.5 transition ${
                    lang === l ? (light ? "bg-white text-[#1d1d1f] shadow-sm" : "bg-white/90 text-slate-900") : light ? "text-[#6e6e73]" : "text-slate-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>
      {view === "user" ? (
        <UserView live={live} phone={phone} agent={agent} serverNow={serverNow} onOpenJudge={() => switchTo("judge")} />
      ) : (
        <JudgeView live={live} phone={phone} agent={agent} serverNow={serverNow} />
      )}
    </div>
  );
}
