/**
 * 从白名单网店的公开商品列表抓一份本地快照，断网和录屏时当后备。
 * 每件商品都带网址和抓取时间。
 *
 * 运行：node src/shop/snapshot.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { SNAPSHOT_PATH } from "./search.ts";
import { STORES, fetchStoreCatalog, type Listing } from "./shopify.ts";

const all: Listing[] = [];
for (const store of STORES) {
  try {
    const items = await fetchStoreCatalog(store);
    console.log(`${store.name}: ${items.length} 件`);
    all.push(...items);
  } catch (e) {
    console.error(`${store.name}: 失败 —— ${(e as Error).message}`);
  }
}

mkdirSync(new URL(".", SNAPSHOT_PATH), { recursive: true });
writeFileSync(SNAPSHOT_PATH, JSON.stringify(all, null, 2) + "\n", "utf8");
console.log(`写入 ${all.length} 件 → data/catalog.snapshot.json`);
