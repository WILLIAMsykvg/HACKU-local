/**
 * 全网参考价：只看不买。
 *
 * 有 SERPAPI_KEY 时用 SerpAPI 的 Google Shopping 接口（gl=hk），拿结构化的卖家和价格；
 * 没有时用 Tavily 搜全网，从摘要里解析「HK$ 数字」。摘要解析可能不准，会标明。
 * 白名单店的结果不放进参考价（它们已经在比较表里，价格是实时读的）。
 * 参考价永远不能直接下单：下单只走白名单店的真购物车。
 */

import { t } from "../i18n.ts";
import { STORES } from "./stores.ts";

export interface ReferenceOffer {
  source: string;
  title: string;
  price_hkd: number | null;
  price_text: string;
  url: string;
  via: "serpapi_google_shopping" | "tavily_snippet";
  fetched_at: string;
  /** 标题里的品牌、型号、规格词和我们这件对得上，算同款 */
  same_product: boolean;
}

export interface ReferenceResult {
  via: ReferenceOffer["via"] | "none";
  note: string;
  offers: ReferenceOffer[];
}

const WHITELIST = new Set(STORES.map((s) => s.domain));

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function parseHkd(text: string): { value: number; text: string } | null {
  const m = text.match(/(?:HK\$|HKD\s?\$?|港幣|港币)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const value = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? { value, text: m[0] } : null;
}

async function viaSerpApi(query: string, key: string, limit: number): Promise<ReferenceOffer[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.search = new URLSearchParams({ engine: "google_shopping", q: query, gl: "hk", hl: "zh-tw", api_key: key }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`SerpAPI 返回 ${res.status}`);
  const data = (await res.json()) as {
    shopping_results?: { title: string; source?: string; price?: string; extracted_price?: number; link?: string; product_link?: string }[];
    error?: string;
  };
  if (data.error) throw new Error(`SerpAPI：${data.error}`);
  const at = new Date().toISOString();
  return (data.shopping_results ?? [])
    .filter((r) => !WHITELIST.has(hostOf(r.link ?? "")))
    .map((r) => {
      const parsed = r.price ? parseHkd(r.price) : null;
      return {
        source: r.source ?? hostOf(r.link ?? r.product_link ?? ""),
        title: r.title,
        price_hkd: parsed?.value ?? (r.price?.includes("$") && r.extracted_price ? r.extracted_price : null),
        price_text: r.price ?? "",
        url: r.link ?? r.product_link ?? "",
        via: "serpapi_google_shopping" as const,
        fetched_at: at,
        same_product: isSameProduct(query, r.title),
      };
    })
    .sort((a, b) => Number(b.same_product) - Number(a.same_product))
    .slice(0, limit);
}

/** 品牌（第一个纯字母词）必须对上，再加至少一个型号或规格词 */
export function isSameProduct(ourTitle: string, theirTitle: string): boolean {
  const terms = keyTerms(ourTitle);
  const brand = terms.find((t) => /^[a-z]+$/.test(t));
  const text = theirTitle.toLowerCase();
  if (!brand || !text.includes(brand)) return false;
  const others = terms.filter((t) => t !== brand);
  return others.length === 0 || others.some((t) => text.includes(t));
}

/** 商品名里有辨识度的词：品牌、型号、规格。用来判断搜索摘要说的是不是同一件东西 */
export function keyTerms(title: string): string[] {
  return title
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => (/\d/.test(t) && t.length >= 2) || (/^[A-Za-z]{2,}$/.test(t) && !/^(and|the|with|for|usb|ports?|charger|black|white)$/i.test(t)))
    .map((t) => t.toLowerCase())
    .slice(0, 4);
}

const LISTING_PAGE = /search|categor|\/c\/|\/shop\/|collections\/?$|\?q=|query=/i;

async function viaTavily(query: string, key: string, limit: number): Promise<ReferenceOffer[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `${query} HK$ 價錢`, max_results: 10, search_depth: "basic", exclude_domains: [...WHITELIST] }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Tavily 返回 ${res.status}`);
  const data = (await res.json()) as { results?: { url: string; title: string; content: string }[] };
  const at = new Date().toISOString();
  const terms = keyTerms(query);
  const out: ReferenceOffer[] = [];
  for (const r of data.results ?? []) {
    if (LISTING_PAGE.test(r.url)) continue;
    const text = `${r.title} ${r.content}`.toLowerCase();
    const hits = terms.filter((t) => text.includes(t)).length;
    if (terms.length > 0 && hits < Math.min(2, terms.length)) continue;
    const p = parseHkd(`${r.title} ${r.content}`);
    if (!p) continue;
    out.push({ source: hostOf(r.url), title: r.title, price_hkd: p.value, price_text: p.text, url: r.url, via: "tavily_snippet", fetched_at: at, same_product: true });
    if (out.length >= limit) break;
  }
  return out;
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; result: ReferenceResult }>();

/** 同一个查询 10 分钟内只查一次，省免费额度 */
export async function referencePrices(
  query: string,
  o: { serpKey?: string; tavilyKey?: string; limit?: number } = {},
): Promise<ReferenceResult> {
  const hit = cache.get(query);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.result, note: viaNote(hit.result.via) ?? hit.result.note };
  const result = await referencePricesUncached(query, o);
  if (result.via !== "none") cache.set(query, { at: Date.now(), result });
  return result;
}

async function referencePricesUncached(
  query: string,
  o: { serpKey?: string; tavilyKey?: string; limit?: number },
): Promise<ReferenceResult> {
  const limit = o.limit ?? 5;
  if (o.serpKey) {
    try {
      const offers = await viaSerpApi(query, o.serpKey, limit);
      return { via: "serpapi_google_shopping", note: viaNote("serpapi_google_shopping")!, offers };
    } catch (e) {
      if (!o.tavilyKey) return { via: "none", note: (e as Error).message, offers: [] };
    }
  }
  if (o.tavilyKey) {
    try {
      const offers = await viaTavily(query, o.tavilyKey, limit);
      return { via: "tavily_snippet", note: viaNote("tavily_snippet")!, offers };
    } catch (e) {
      return { via: "none", note: (e as Error).message, offers: [] };
    }
  }
  return { via: "none", note: t("没有配置参考价来源。", "No reference price source configured."), offers: [] };
}

function viaNote(via: ReferenceResult["via"]): string | null {
  if (via === "serpapi_google_shopping") return t("来自 Google Shopping（香港），只看不买。", "From Google Shopping (Hong Kong). For reference only, not for buying.");
  if (via === "tavily_snippet") return t("从全网搜索摘要里解析的价格，可能不准，只看不买。", "Parsed from web search snippets, may be inaccurate. For reference only.");
  return null;
}
