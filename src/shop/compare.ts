/**
 * 比价：纯函数，规则公开。
 *
 *  1. 先看硬要求：有货、在预算内、规格对得上（例如用户说了 65W）。不满足的列进「淘汰」，写明差在哪。
 *  2. 满足的按价格从低到高排。
 *  3. 价格相差不到 TIE_HKD 时，熟客店优先：在熟客店买可以少被问一次。
 *  4. 每一件都给出机器可读的理由；卖家付费、佣金一律不参与排序（我们也没有这类数据）。
 *  5. 覆盖报告：每家白名单店搜到没有、读取失败没有，照实列出，不把部分结果说成全部。
 */

import { lang, t } from "../i18n.ts";
import type { Listing } from "./shopify.ts";

export const TIE_HKD = 10;

export interface Brief {
  query: string;
  /** 单价上限。总额是否超出授权由规则引擎判断，不在这里拦 */
  max_price_hkd?: number;
  /** 规格要求，例如 "65W"。商品标题里要出现 */
  must_include?: string[];
  qty: number;
}

export interface RankedOffer {
  rank: number;
  listing: Listing;
  total_hkd: number;
  trusted_merchant: boolean;
  reasons: string[];
}

export interface RejectedOffer {
  listing: Listing;
  missed: string[];
}

export interface CoverageRow {
  merchant_id: string;
  name: string;
  status: "matched" | "no_match" | "not_found" | "failed";
  note: string;
}

export interface Comparison {
  brief: Brief;
  rule: string;
  shortlist: RankedOffer[];
  rejected: RejectedOffer[];
  coverage: CoverageRow[];
  pick: RankedOffer | null;
}

export const RULE_TEXT =
  `先排除缺货、单价超预算、规格不符的；剩下的按总价从低到高排；总额是否超出授权由规则引擎判断；` +
  `相差不到 HK$${TIE_HKD} 时熟客店优先（少问你一次）；卖家付费不影响排序。`;

const RULE_TEXT_EN =
  `First drop items that are out of stock, over the unit budget or missing the spec; rank the rest by total price, lowest first; ` +
  `whether the total fits the mandate is for the rule engine; within HK$${TIE_HKD}, a store you've used before wins (one less question); paid placement never affects the order.`;

function money(n: number): string {
  return `HK$${Math.round(n * 100) / 100}`;
}

function hkTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(lang() === "en" ? "en-HK" : "zh-HK", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function compareOffers(
  listings: readonly Listing[],
  brief: Brief,
  o: {
    trustedMerchants: readonly string[];
    stores: readonly { merchant_id: string; name: string }[];
    /** 这次有商品读取失败的店 */
    failedMerchants?: readonly string[];
  },
): Comparison {
  const seen = new Set<string>();
  const unique = listings.filter((l) => {
    const k = `${l.url}#${l.variant_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const ok: Listing[] = [];
  const rejected: RejectedOffer[] = [];
  for (const l of unique) {
    const missed: string[] = [];
    if (!l.available) missed.push(t("缺货", "out of stock"));
    if (brief.max_price_hkd !== undefined && l.price_hkd > brief.max_price_hkd) {
      missed.push(t(`单价 ${money(l.price_hkd)} 超过预算 ${money(brief.max_price_hkd)}`, `unit price ${money(l.price_hkd)} is over the ${money(brief.max_price_hkd)} budget`));
    }
    for (const need of brief.must_include ?? []) {
      // 「禮盒|禮物盒」表示几种写法任一即可
      const options = need.split("|").map((s) => s.trim()).filter(Boolean);
      const title = l.title.toLowerCase();
      if (!options.some((opt) => title.includes(opt.toLowerCase()))) {
        missed.push(t(`标题里没有「${options.join("」或「")}」`, `title doesn't contain "${options.join('" or "')}"`));
      }
    }
    if (missed.length > 0) rejected.push({ listing: l, missed });
    else ok.push(l);
  }

  const trusted = (l: Listing) => o.trustedMerchants.includes(l.merchant_id);
  ok.sort((a, b) => {
    const d = a.price_hkd - b.price_hkd;
    if (Math.abs(d) * brief.qty < TIE_HKD && trusted(a) !== trusted(b)) return trusted(a) ? -1 : 1;
    return d;
  });

  const shortlist: RankedOffer[] = ok.map((l, i) => {
    const total = l.price_hkd * brief.qty;
    const reasons: string[] = [];
    const next = ok[i + 1];
    const prev = ok[i - 1];
    if (i === 0 && next) {
      const gap = (next.price_hkd - l.price_hkd) * brief.qty;
      reasons.push(
        gap > 0
          ? t(`比第二名便宜 ${money(gap)}`, `${money(gap)} cheaper than the next one`)
          : t(`和第二名同价，${trusted(l) ? "熟客店优先" : "按读取顺序"}`, `same price as the next one; ${trusted(l) ? "your usual store wins" : "kept in read order"}`),
      );
    } else if (i === 0) {
      reasons.push(t("唯一满足要求的", "the only one that meets the requirements"));
    } else if (prev) {
      reasons.push(t(`比第一名贵 ${money((l.price_hkd - ok[0]!.price_hkd) * brief.qty)}`, `${money((l.price_hkd - ok[0]!.price_hkd) * brief.qty)} more than the top pick`));
    }
    if (trusted(l)) reasons.push(t("熟客店：在这里买可以少问你一次", "a store you've used before, so one less question"));
    else reasons.push(t("第一次光顾：引擎会先进冷静期", "first order here, so the engine starts with cooling-off"));
    reasons.push(
      l.source === "live"
        ? t(`价格是 ${hkTime(l.fetched_at)} 刚从店里读的`, `price read live from the store at ${hkTime(l.fetched_at)}`)
        : t(`价格来自本地快照（${hkTime(l.fetched_at)}）`, `price from the local snapshot (${hkTime(l.fetched_at)})`),
    );
    return { rank: i + 1, listing: l, total_hkd: total, trusted_merchant: trusted(l), reasons };
  });

  const coverage: CoverageRow[] = o.stores.map((s) => {
    const found = unique.filter((l) => l.merchant_id === s.merchant_id);
    if (found.length === 0) {
      return o.failedMerchants?.includes(s.merchant_id)
        ? { merchant_id: s.merchant_id, name: s.name, status: "failed" as const, note: t("读取失败", "read failed") }
        : { merchant_id: s.merchant_id, name: s.name, status: "not_found" as const, note: t("这次搜索没有搜到这家的商品", "no items from this store in this search") };
    }
    const matched = ok.filter((l) => l.merchant_id === s.merchant_id).length;
    return matched > 0
      ? { merchant_id: s.merchant_id, name: s.name, status: "matched" as const, note: t(`${found.length} 件，${matched} 件符合`, `${found.length} found, ${matched} match`) }
      : { merchant_id: s.merchant_id, name: s.name, status: "no_match" as const, note: t(`${found.length} 件，都不符合要求`, `${found.length} found, none match`) };
  });

  return { brief, rule: t(RULE_TEXT, RULE_TEXT_EN), shortlist, rejected, coverage, pick: shortlist[0] ?? null };
}
