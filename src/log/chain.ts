/**
 * 签名日志 —— 哈希链 + HMAC。
 *
 * 目标（题目原文）：
 *  · "Show the log of what the agent was permitted to do, then show it being stopped."
 *  · "State the rule by which the agent decides, so a user could understand why it did what it did."
 *
 * 每一行都写清：谁、做了什么、触发了哪条规则、当时的数字是多少。
 * 每一行都用前一行哈希串起来，改一行就会断链。
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { t } from "../i18n.ts";
import { canonicalize } from "./canonical.ts";

export { canonicalize };

export const GENESIS = "0".repeat(64);

export type Actor = "agent" | "user" | "engine" | "merchant" | "phone" | "bank" | "location";

export interface LogPayload {
  at: string;
  actor: Actor;
  event: string;
  [key: string]: unknown;
}

export interface LogEntry extends LogPayload {
  seq: number;
  prev_hash: string;
  entry_hash: string;
}

export function computeEntryHash(prevHash: string, payload: unknown): string {
  return createHash("sha256")
    .update(prevHash)
    .update("\n")
    .update(canonicalize(payload))
    .digest("hex");
}

/** 往链上追加一条。返回新链（不修改传入的数组以外的状态，保持可测） */
export function appendEntry(chain: readonly LogEntry[], payload: LogPayload): LogEntry {
  const prev = chain.length > 0 ? chain[chain.length - 1]!.entry_hash : GENESIS;
  const seq = chain.length;
  const entry_hash = computeEntryHash(prev, payload);
  return { ...payload, seq, prev_hash: prev, entry_hash };
}

export interface VerifyResult {
  ok: boolean;
  brokenAt: number | null;
  reason: string;
}

/** 校验整条链：序号连续、prev_hash 对得上、entry_hash 重算一致 */
export function verifyChain(chain: readonly LogEntry[]): VerifyResult {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i]!;
    if (e.seq !== i) {
      return { ok: false, brokenAt: i, reason: t(`seq 不连续：期望 ${i}，实际 ${e.seq}`, `seq is not continuous: expected ${i}, got ${e.seq}`) };
    }
    if (e.prev_hash !== prev) {
      return { ok: false, brokenAt: i, reason: t(`第 ${i} 条的 prev_hash 对不上`, `entry ${i}: prev_hash doesn't match`) };
    }
    const { seq: _seq, prev_hash: _prev, entry_hash: _hash, ...payload } = e;
    const expect = computeEntryHash(prev, payload);
    if (expect !== e.entry_hash) {
      return {
        ok: false,
        brokenAt: i,
        reason: t(`第 ${i} 条内容被改过（entry_hash 对不上）`, `entry ${i} was altered (entry_hash doesn't match)`),
      };
    }
    prev = e.entry_hash;
  }
  return { ok: true, brokenAt: null, reason: t(`${chain.length} 条全部通过`, `all ${chain.length} entries verified`) };
}

// ---------------------------------------------------------------------------
// HMAC 签名 —— 用在「批准数据」上，防止批准在客户端与服务端之间被改
// ---------------------------------------------------------------------------

export function signPayload(payload: unknown, secret: string): string {
  return createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");
}

export function verifySignature(
  payload: unknown,
  signature: string,
  secret: string,
): boolean {
  const expected = signPayload(payload, secret);
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
