/**
 * 选哪张卡付款 —— 规则，不是模型。代理不选卡，只看结果。
 *
 *  1. 第一次光顾的商户不走转数快：转数快即时到账，付出去一般追不回。
 *  2. 有队伍亲自截图、带时间的回赠条款时，选回赠最高的。
 *  3. 没有核实过的回赠数据时不按回赠选，用信用卡（有拒付保障）。
 *
 * 回赠数字只能来自 data/cards.json 里带 source_url 和 captured_at 的条目，不估、不编。
 */

import { readFileSync } from "node:fs";

export interface PaymentCard {
  card_id: string;
  network: "mastercard" | "unionpay" | "fps";
  label: string;
  issuer: string | null;
  online_rebate_percent: number | null;
  rule_text: string | null;
  source_url: string | null;
  captured_at: string | null;
  screenshot: string | null;
}

export interface CardChoice {
  card: PaymentCard;
  reason: string;
  /** 每张卡为什么被选或没被选 */
  considered: { card_id: string; label: string; note: string }[];
}

export function loadCards(): PaymentCard[] {
  return JSON.parse(readFileSync(new URL("../../data/cards.json", import.meta.url), "utf8")) as PaymentCard[];
}

function verifiedRebate(c: PaymentCard): number | null {
  return c.online_rebate_percent !== null && c.source_url && c.captured_at ? c.online_rebate_percent : null;
}

export function chooseCard(cards: readonly PaymentCard[], o: { firstTimeMerchant: boolean }): CardChoice {
  const considered: CardChoice["considered"] = [];
  const eligible: PaymentCard[] = [];

  for (const c of cards) {
    if (c.network === "fps" && o.firstTimeMerchant) {
      considered.push({ card_id: c.card_id, label: c.label, note: "第一次光顾这家商户，不走转数快：付出去一般追不回。" });
      continue;
    }
    eligible.push(c);
  }
  if (eligible.length === 0) throw new Error("没有可用的付款方式");

  const withRebate = eligible
    .map((c) => ({ c, r: verifiedRebate(c) }))
    .filter((x): x is { c: PaymentCard; r: number } => x.r !== null)
    .sort((a, b) => b.r - a.r);

  let pick: PaymentCard;
  let reason: string;
  if (withRebate.length > 0) {
    const top = withRebate[0]!;
    pick = top.c;
    reason = `按已核实的回赠条款选：${pick.label} 网上消费回赠 ${top.r}%（${pick.captured_at} 截自 ${pick.source_url}）。`;
  } else {
    pick = eligible.find((c) => c.network !== "fps") ?? eligible[0]!;
    reason = `没有亲自核实过的回赠条款，所以不按回赠选；用${pick.label}，因为信用卡出了问题可以申请拒付。`;
  }

  for (const c of eligible) {
    if (c === pick) {
      considered.push({ card_id: c.card_id, label: c.label, note: "选中。" });
    } else {
      const r = verifiedRebate(c);
      considered.push({
        card_id: c.card_id,
        label: c.label,
        note: r === null ? "没有核实过的回赠数据。" : `回赠 ${r}%，低于选中的那张。`,
      });
    }
  }
  return { card: pick, reason, considered };
}
