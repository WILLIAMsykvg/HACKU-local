/**
 * Ed25519 签名与验签。
 *
 * 不用 HMAC：HMAC 的密钥在运营者手里，第三方无法独立核对。
 * 签名对象是 canonicalize(claim) 的 UTF-8 字节，浏览器端用 WebCrypto 按同样规则签。
 */

import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import { canonicalize } from "../log/chain.ts";
import type { Claim, SignedClaim } from "./types.ts";

export interface IssuerKey {
  privateKey: KeyObject;
  /** JWK 的 x，base64url */
  publicKey: string;
}

export function generateIssuerKey(): IssuerKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("Ed25519 公钥导出失败");
  return { privateKey, publicKey: jwk.x };
}

export function claimBytes(claim: Claim): Buffer {
  return Buffer.from(canonicalize(claim), "utf8");
}

export function signClaim(claim: Claim, key: IssuerKey): SignedClaim {
  const signature = sign(null, claimBytes(claim), key.privateKey).toString("base64url");
  return { claim, issuer_key: key.publicKey, signature };
}

export function verifyClaimSignature(sc: SignedClaim): boolean {
  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: sc.issuer_key },
      format: "jwk",
    });
    return verify(null, claimBytes(sc.claim), publicKey, Buffer.from(sc.signature, "base64url"));
  } catch {
    return false;
  }
}
