/**
 * 界面语言。服务器按每个请求的 X-Lang 决定，浏览器按顶栏开关决定；默认简体中文。
 * 引擎和证明层只在生成给人看的句子时读它，判定本身与语言无关。
 */

export type Lang = "zh" | "en";

let source: () => Lang = () => "zh";

export function setLangSource(fn: () => Lang): void {
  source = fn;
}

export function lang(): Lang {
  return source();
}

/** 按当前语言二选一 */
export function t(zh: string, en: string): string {
  return source() === "en" ? en : zh;
}

export function parseLang(v: string | null | undefined): Lang {
  return v === "en" ? "en" : "zh";
}
