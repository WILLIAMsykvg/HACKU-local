/**
 * 只用 Shopify 店公开开放的功能：
 *   /products/<handle>.js   单件商品：价格（分）、库存、规格编号
 *   /products.json          全店商品列表（用来做本地快照）
 *   /cart/<规格编号>:<数量>  购物车链接，打开就是这家店的真结账页
 *
 * 不提交订单、不填付款资料、不绕过任何防护。每家店的请求有最小间隔。
 */

import { STORES, USER_AGENT, storeByDomain, type Store } from "./stores.ts";

export interface Listing {
  merchant_id: string;
  merchant_name: string;
  domain: string;
  handle: string;
  title: string;
  product_type: string;
  variant_id: string;
  variant_title: string;
  price_hkd: number;
  available: boolean;
  url: string;
  fetched_at: string;
  /** live：刚从店里读的；snapshot：来自本地快照 */
  source: "live" | "snapshot";
}

export class ShopError extends Error {}

const MIN_INTERVAL_MS = 600;
/** 每家店下一次允许发请求的时间。先占位再等待，并发调用也会排队 */
const nextSlot = new Map<string, number>();

async function politeFetch(url: URL): Promise<Response> {
  const store = storeByDomain(url.host);
  if (!store) throw new ShopError(`域名 ${url.host} 不在白名单里`);
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(store.domain) ?? 0);
  nextSlot.set(store.domain, slot + MIN_INTERVAL_MS);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new ShopError(`${url.host} 返回 ${res.status}`);
  return res;
}

/** 从商品网址里取出店和 handle；不是白名单店的商品页就抛错 */
export function parseProductUrl(raw: string): { store: Store; handle: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ShopError(`不是有效的网址：${raw}`);
  }
  const store = storeByDomain(url.host);
  if (!store) throw new ShopError(`域名 ${url.host} 不在白名单里`);
  const m = url.pathname.match(/\/products\/([^/?#.]+)/);
  if (!m) throw new ShopError(`不是商品页：${raw}`);
  return { store, handle: decodeURIComponent(m[1]!) };
}

interface ShopifyVariantJs {
  id: number;
  title: string;
  price: number;
  available: boolean;
}

interface ShopifyProductJs {
  title: string;
  handle: string;
  type?: string;
  variants: ShopifyVariantJs[];
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; listing: Listing }>();

/**
 * 读一件商品此刻的价格和库存。fresh=false 时允许用 60 秒内读过的结果（代理浏览用）；
 * 商户核对价格时必须 fresh=true。
 */
export async function fetchListing(productUrl: string, variantId?: string, o: { fresh?: boolean } = {}): Promise<Listing> {
  const key = `${productUrl}#${variantId ?? ""}`;
  const hit = cache.get(key);
  if (!o.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.listing;
  const listing = await fetchListingLive(productUrl, variantId);
  cache.set(key, { at: Date.now(), listing });
  return listing;
}

async function fetchListingLive(productUrl: string, variantId?: string): Promise<Listing> {
  const { store, handle } = parseProductUrl(productUrl);
  const res = await politeFetch(new URL(`https://${store.domain}/products/${encodeURIComponent(handle)}.js`));
  const p = (await res.json()) as ShopifyProductJs;
  const v =
    (variantId ? p.variants.find((x) => String(x.id) === variantId) : undefined) ??
    p.variants.find((x) => x.available) ??
    p.variants[0];
  if (!v) throw new ShopError(`${p.title} 没有可选的规格`);
  return {
    merchant_id: store.merchant_id,
    merchant_name: store.name,
    domain: store.domain,
    handle: p.handle,
    title: p.title,
    product_type: p.type ?? "",
    variant_id: String(v.id),
    variant_title: v.title,
    price_hkd: v.price / 100,
    available: v.available,
    url: `https://${store.domain}/products/${p.handle}`,
    fetched_at: new Date().toISOString(),
    source: "live",
  };
}

interface ShopifyProductsJson {
  products: {
    title: string;
    handle: string;
    product_type: string;
    variants: { id: number; title: string; price: string; available: boolean }[];
  }[];
}

/** 读一家店的商品列表，每件取第一个有货的规格 */
export async function fetchStoreCatalog(store: Store, limit = 250): Promise<Listing[]> {
  const res = await politeFetch(new URL(`https://${store.domain}/products.json?limit=${limit}`));
  const data = (await res.json()) as ShopifyProductsJson;
  const at = new Date().toISOString();
  return data.products.flatMap((p) => {
    const v = p.variants.find((x) => x.available) ?? p.variants[0];
    if (!v) return [];
    return [
      {
        merchant_id: store.merchant_id,
        merchant_name: store.name,
        domain: store.domain,
        handle: p.handle,
        title: p.title,
        product_type: p.product_type,
        variant_id: String(v.id),
        variant_title: v.title,
        price_hkd: Number(v.price),
        available: v.available,
        url: `https://${store.domain}/products/${p.handle}`,
        fetched_at: at,
        source: "live" as const,
      },
    ];
  });
}

export function cartUrl(listing: Pick<Listing, "domain" | "variant_id">, qty: number): string {
  return `https://${listing.domain}/cart/${listing.variant_id}:${qty}`;
}

export { STORES };
