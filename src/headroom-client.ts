import { HeadroomClient } from "headroom-ai";
import { readFileSync } from "node:fs";
import type { ProxyManager } from "./proxy-manager.js";

type PinnedTransport = {
  _fetch(path: string, init?: RequestInit): Promise<Response>;
  rawFetch(path: string, init?: RequestInit): Promise<Response>;
};

/** The pinned 0.41 SDK routes compress/compressRaw/retrieval through _fetch.
 * Keep its serialization/result semantics; replace only that transport. Never
 * allow rawFetch/provider APIs or an unknown SDK contract to send plaintext.
 */
export function createOwnedHeadroomClient(proxy: Pick<ProxyManager, "baseUrl" | "requestOwned"> | null): HeadroomClient {
  const client = new HeadroomClient({ baseUrl: proxy?.baseUrl ?? "http://127.0.0.1:8787", fallback: false, timeout: 15000 });
  const transport = client as unknown as PinnedTransport;
  let compatible = false;
  try {
    const entry = import.meta.resolve("headroom-ai");
    const manifest = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
    compatible = manifest.version === "0.41.0" && typeof transport._fetch === "function" && !!proxy;
  } catch { /* Unknown installed SDK fails closed, never native plaintext fallback. */ }
  transport.rawFetch = async () => { throw new Error("Unsealed/provider SDK transport is disabled"); };
  transport._fetch = async (path, init) => {
    if (!compatible || !proxy) throw new Error("Managed SDK transport contract unavailable");
    const method = init?.method ?? "GET";
    if (method !== "GET" && method !== "POST") throw new Error("Unsupported managed SDK method");
    if (init?.body && typeof init.body !== "string") throw new Error("Unsupported managed SDK body");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const value = await proxy.requestOwned(path, body, method);
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
  return client;
}
