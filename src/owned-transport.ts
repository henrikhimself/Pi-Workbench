import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Private managed-proxy wire protocol. Standard AES-256-GCM; never send the key
// or plaintext context to a TCP occupant, even across a health/request port race.
export const OWNED_FRAME_LIMIT = 64 * 1024 * 1024;
export function sealOwnedJson(secret: string, associatedData: string, value: unknown): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "hex"), iv);
  cipher.setAAD(Buffer.from(associatedData));
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > OWNED_FRAME_LIMIT / 2) throw new Error("Owned request exceeds safe frame limit");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), data: data.toString("base64") });
}
export function openOwnedJson(secret: string, associatedData: string, text: string): unknown {
  if (text.length > OWNED_FRAME_LIMIT) throw new Error("Owned response exceeds safe frame limit");
  try {
    const frame = JSON.parse(text);
    if (frame.v !== 1 || typeof frame.iv !== "string" || typeof frame.data !== "string") throw new Error();
    const iv = Buffer.from(frame.iv, "base64"), data = Buffer.from(frame.data, "base64");
    if (iv.length !== 12 || data.length < 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(secret, "hex"), iv);
    decipher.setAAD(Buffer.from(associatedData)); decipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString("utf8"));
  } catch { throw new Error("Owned response authentication failed"); }
}
export async function readOwnedFrame(response: Response): Promise<string> {
  if (!response.body) throw new Error("Missing owned response body");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > OWNED_FRAME_LIMIT) { await reader.cancel(); throw new Error("Owned response exceeds safe frame limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
