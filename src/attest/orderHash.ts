/**
 * 这一单的编号 = 规范化后的 sha256。
 *
 * 覆盖商户、商品、数量、总额和收货地标签。收货地一改，编号就变，
 * 针对旧编号签的结论全部作废 —— 这就是「代理被劫持改收货地」被拦下的原因。
 */

import { createHash } from "node:crypto";

import type { Quote } from "../engine/types.ts";
import { canonicalize } from "../log/chain.ts";

export function orderHash(quote: Quote, shipToLabel: string): string {
  return createHash("sha256")
    .update(
      canonicalize({
        quote_id: quote.quote_id,
        merchant_id: quote.merchant_id,
        sku: quote.item.sku,
        qty: quote.item.qty,
        total_hkd: quote.total_hkd,
        ship_to: shipToLabel,
      }),
    )
    .digest("hex");
}
