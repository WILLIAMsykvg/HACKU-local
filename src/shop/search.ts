/**
 * 找商品：Tavily 只用来「发现」白名单网店里的商品页，价格一律以店里的公开数据为准。
 * Tavily 失败、没有 key、或者没找到时，退回本地快照按关键词找。
 */

import { readFileSync } from "node:fs";

import { t } from "../i18n.ts";
import { fetchListing, type Listing } from "./shopify.ts";
import { STORES } from "./stores.ts";

export const SNAPSHOT_PATH = new URL("../../data/catalog.snapshot.json", import.meta.url);

export interface SearchResult {
  via: "tavily" | "snapshot";
  note: string;
  listings: Listing[];
}

interface TavilyResponse {
  results?: { url: string; title: string; content: string }[];
}

async function tavilyProductUrls(query: string, apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      max_results: 10,
      search_depth: "basic",
      include_domains: STORES.map((s) => s.domain),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tavily 返回 ${res.status}`);
  const data = (await res.json()) as TavilyResponse;
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const r of data.results ?? []) {
    const m = r.url.match(/^https:\/\/([^/]+)\/(?:[^?#]*\/)?products\/([^/?#]+)/);
    if (!m) continue;
    const clean = `https://${m[1]}/products/${m[2]}`;
    if (seen.has(clean)) continue;
    seen.add(clean);
    urls.push(clean);
  }
  return urls;
}

let snapshotCache: Listing[] | null = null;

export function loadSnapshot(): Listing[] {
  if (snapshotCache) return snapshotCache;
  try {
    const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Listing[];
    snapshotCache = raw.map((l) => ({ ...l, source: "snapshot" as const }));
  } catch {
    snapshotCache = [];
  }
  return snapshotCache;
}

/** 只覆盖演示里会用到的常见字；目的是让简体搜索词能对上繁体商品名 */
const TO_TRAD: Record<string, string> = {
  丝: "絲", 礼: "禮", 钥: "鑰", 垫: "墊", 围: "圍", 电: "電", 线: "線", 机: "機", 壳: "殼",
  袋: "袋", 盒: "盒", 饰: "飾", 链: "鏈", 们: "們", 适: "適", 乐: "樂", 摇: "搖", 挂: "掛",
  发: "髮", 带: "帶", 亲: "親", 节: "節", 纪: "紀", 念: "念", 杯: "杯", 毯: "毯", 锁: "鎖",
};

export function normalize(s: string): string {
  return [...s.toLowerCase()].map((c) => TO_TRAD[c] ?? c).join("");
}

const CJK = /\p{Script=Han}/u;

/** 拉丁字母和数字按词切；中文按相邻两个字切 */
export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const part of normalize(s).split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    if (!CJK.test(part)) {
      out.push(part);
      continue;
    }
    const chars = [...part].filter((c) => CJK.test(c));
    if (chars.length === 1) out.push(chars[0]!);
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    const latin = part.replace(/\p{Script=Han}/gu, " ").trim();
    if (latin) out.push(...latin.split(/\s+/));
  }
  return out;
}

const STOPWORDS = new Set([
  "帮我", "我买", "买一", "一个", "一份", "以内", "内的", "寄到", "到宿", "宿舍", "给我", "我要", "我想", "想买",
  "buy", "me", "an", "under", "for", "the", "to", "my", "dorm", "ship", "hk", "and", "of", "with",
]);

export function searchSnapshot(query: string, maxPrice?: number, limit = 6): Listing[] {
  const q = tokens(query).filter((w) => !STOPWORDS.has(w));
  return loadSnapshot()
    .filter((l) => l.available && (maxPrice === undefined || l.price_hkd <= maxPrice))
    .map((l) => {
      const hay = normalize(`${l.title} ${l.product_type}`);
      const hits = q.filter((t) => hay.includes(t)).length;
      return { l, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.l.price_hkd - b.l.price_hkd)
    .slice(0, limit)
    .map((x) => x.l);
}

/**
 * 联网搜索和本地快照合并：联网搜索每次返回的结果不一样，快照保证每家白名单店都被搜到。
 * 合并后的候选逐件重新读实时价格；读不到的保留快照价并标明。
 */
export async function searchProducts(
  query: string,
  o: { maxPrice?: number; apiKey?: string; limit?: number } = {},
): Promise<SearchResult> {
  const limit = o.limit ?? 6;
  let liveUrls: string[] = [];
  let note = o.apiKey ? "" : t("没有配置搜索 key，只用本地快照。", "No search key configured, so only the local snapshot is used.");
  if (o.apiKey) {
    try {
      liveUrls = await tavilyProductUrls(query, o.apiKey);
      note = t(`Tavily 搜到 ${liveUrls.length} 个商品页`, `Tavily found ${liveUrls.length} product pages`);
    } catch (e) {
      note = t(`联网搜索失败（${(e as Error).message}）`, `Web search failed (${(e as Error).message})`);
    }
  }

  const fromSnapshot = searchSnapshot(query, o.maxPrice, limit).map((l) => l.url);
  const urls = [...new Set([...liveUrls, ...fromSnapshot])].slice(0, limit + 4);
  // 不同的店并行读；同一家店由 politeFetch 排队
  const settled = await Promise.allSettled(urls.map((u) => fetchListing(u)));
  const snapshot = loadSnapshot();
  const listings = settled
    .flatMap((r, i) => {
      if (r.status === "fulfilled") return [r.value];
      const cached = snapshot.find((l) => l.url === urls[i]);
      return cached ? [cached] : [];
    })
    .filter((l) => o.maxPrice === undefined || l.price_hkd <= o.maxPrice)
    .slice(0, limit);

  return {
    via: liveUrls.length > 0 ? "tavily" : "snapshot",
    note: t(
      `${note ? note + "；" : ""}本地快照补上 ${fromSnapshot.length} 件。价格和库存是刚从店里读的。`,
      `${note ? note + "; " : ""}the local snapshot added ${fromSnapshot.length}. Prices and stock were just read from the stores.`,
    ),
    listings,
  };
}
