import { HeadroomClient } from "headroom-ai";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { HEADROOM_REQUEST_TIMEOUT_MS, type ProxyManager } from "./proxy-manager.js";

type PinnedTransport = {
  _fetch(path: string, init?: RequestInit): Promise<Response>;
  rawFetch(path: string, init?: RequestInit): Promise<Response>;
};

/** The SDK's compress() takes no AbortSignal. Run it inside this store and the owned
 * transport cancels the in-flight request when the signal aborts. */
export const compressionSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/** The pinned 0.41 SDK routes compress/compressRaw/retrieval through _fetch.
 * Keep its serialization/result semantics; replace only that transport. Never
 * allow rawFetch/provider APIs or an unknown SDK contract to send plaintext.
 */
export function createOwnedHeadroomClient(
  proxy: Pick<ProxyManager, "baseUrl" | "requestOwned"> | null,
  timeoutMs = HEADROOM_REQUEST_TIMEOUT_MS,
): HeadroomClient {
  // retries: 0 — a retry after a timeout would queue a second compression behind the first on
  // the same busy proxy. Failures surface to the context handler, which fails open.
  const client = new HeadroomClient({ baseUrl: proxy?.baseUrl ?? "http://127.0.0.1:8787", fallback: false, timeout: timeoutMs, retries: 0 });
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
    const value = await proxy.requestOwned(path, body, method, compressionSignal.getStore());
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  };
  return client;
}
