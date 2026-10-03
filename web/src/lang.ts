/**
 * 浏览器这边的界面语言：网址 ?lang= 优先，其次上次的选择，再其次浏览器语言。
 * 接到 src/i18n.ts 上，所以前端复用的计分、问题表文字也跟着切换。
 */

import { parseLang, setLangSource, type Lang } from "../../src/i18n.ts";

export { t, type Lang } from "../../src/i18n.ts";

const STORE_KEY = "ld_lang";

function initial(): Lang {
  const q = new URLSearchParams(location.search).get("lang");
  if (q) return parseLang(q);
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) return parseLang(saved);
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Lang = initial();
setLangSource(() => current);
applyToDocument();

function applyToDocument(): void {
  document.documentElement.lang = current === "en" ? "en" : "zh-CN";
  document.title = current === "en" ? "Local Deployment · An agent pays; your context stays on your phone" : "Local Deployment · 代理替你付款，个人背景不出手机";
}

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  localStorage.setItem(STORE_KEY, l);
  applyToDocument();
}

/** 日期和时间的区域设置 */
export function locale(): string {
  return current === "en" ? "en-HK" : "zh-HK";
}
