/**
 * 这台设备自己的钥匙和本地定位比对。
 *
 * 坐标只在这里用来算距离，从不发出去；发出去的只有「是 / 否」和签名。
 * 演示里定位结论是设备自证；正式版由运营商用它自己的钥匙签。
 */

import { canonicalize } from "../../src/log/canonical.ts";
import { NEAR_SHIP_TO_KM, QUESTIONS } from "../../src/attest/questions.ts";
import type { Claim, SignedClaim } from "../../src/attest/types.ts";

const STORE_KEY = "ld_device_key_v1";

interface StoredKey {
  privateJwk: JsonWebKey;
  publicX: string;
}

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cached: { privateKey: CryptoKey; publicX: string } | null = null;

export async function deviceKey(): Promise<{ privateKey: CryptoKey; publicX: string }> {
  if (cached) return cached;
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) {
    const stored = JSON.parse(raw) as StoredKey;
    const privateKey = await crypto.subtle.importKey("jwk", stored.privateJwk, { name: "Ed25519" }, false, ["sign"]);
    cached = { privateKey, publicX: stored.publicX };
    return cached;
  }
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicX = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  localStorage.setItem(STORE_KEY, JSON.stringify({ privateJwk, publicX } satisfies StoredKey));
  cached = { privateKey: pair.privateKey, publicX };
  return cached;
}

export async function deviceSupported(): Promise<boolean> {
  try {
    await deviceKey();
    return true;
  } catch {
    return false;
  }
}

export async function signLocationClaim(orderHash: string, answer: boolean, now: Date): Promise<SignedClaim> {
  const q = QUESTIONS.find((x) => x.id === "near_ship_to")!;
  const claim: Claim = {
    order_hash: orderHash,
    role: "location",
    question_id: "near_ship_to",
    answer,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + q.validity_ms).toISOString(),
  };
  const key = await deviceKey();
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(canonicalize(claim)));
  return { claim, issuer_key: key.publicX, signature: b64url(sig) };
}

export interface Position {
  lat: number;
  lng: number;
  accuracy_m: number;
  simulated: boolean;
}

/** 会场（港大）的坐标，给「用会场位置模拟」那个开关用 */
export const VENUE = { lat: 22.2830, lng: 114.1371 };

export function currentPosition(): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("这台设备不支持定位"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy, simulated: false }),
      (e) => reject(new Error(e.code === 1 ? "没有给定位权限" : "暂时拿不到位置")),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  });
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export { NEAR_SHIP_TO_KM };
