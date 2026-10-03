/**
 * 白名单网店。代理只能访问这里列出的域名，列表写死在代码里。
 *
 * 只收香港的 Shopify 店，并用 /meta.json 核对过 country=HK、currency=HKD。
 * 运费 Shopify 商品数据里没有，要进结账页才算得出来；
 * 这里只记店家公布的数字和出处，没有就写 null，报价按 0 计并标明「以结账页为准」。
 */

export type Category = "electronics_accessory" | "gift";

export interface Store {
  merchant_id: string;
  name: string;
  domain: string;
  /** 这家店的商品在规则引擎里算哪一类 */
  category: Category;
  /** 用 /meta.json 核对的时间 */
  verified_at: string;
  shipping_hkd: number | null;
  shipping_source: string | null;
}

export const STORES: readonly Store[] = [
  {
    merchant_id: "m_thinkthing",
    name: "THINKTHING STUDIO",
    domain: "www.thinkthingstudio.com",
    category: "electronics_accessory",
    verified_at: "2026-10-04T00:10:00+08:00",
    shipping_hkd: null,
    shipping_source: null,
  },
  {
    merchant_id: "m_gp_hk",
    name: "GP Batteries Hong Kong",
    domain: "hk.gpbatteries.com",
    category: "electronics_accessory",
    verified_at: "2026-10-04T00:10:00+08:00",
    shipping_hkd: null,
    shipping_source: null,
  },
  {
    merchant_id: "m_stephy",
    name: "StephyDesignHK",
    domain: "www.stephydesignhk.com",
    category: "gift",
    verified_at: "2026-10-04T01:00:00+08:00",
    shipping_hkd: null,
    shipping_source: null,
  },
];

export const CATEGORY_TEXT: Record<Category, string> = {
  electronics_accessory: "电子配件",
  gift: "礼品",
};

export function storeByDomain(host: string): Store | undefined {
  const h = host.toLowerCase();
  return STORES.find((s) => s.domain === h);
}

export function storeById(id: string): Store | undefined {
  return STORES.find((s) => s.merchant_id === id);
}

export const USER_AGENT = "LocalDeploymentAgent/0.1 (HacKU 2026 demo; team 23)";
