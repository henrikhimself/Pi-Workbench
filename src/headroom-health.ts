export type HeadroomHealthFailureReason = "unreachable" | "http_error" | "invalid_json" | "missing_version";

export type HeadroomHealth =
  | { ok: true; version: string }
  | { ok: false; reason: HeadroomHealthFailureReason };

export type HeadroomVersionCheck =
  | { ok: true; expectedVersion: string; reportedVersion: string }
  | {
    ok: false;
    expectedVersion: string | null;
    reportedVersion: string | null;
    reason: "expected_version_unavailable" | HeadroomHealthFailureReason | "version_mismatch";
  };

/** Fetch and validate the small public subset of a Headroom health response. */
export async function getHeadroomHealth(baseUrl: string, timeoutMs: number): Promise<HeadroomHealth> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  if (!response.ok) return { ok: false, reason: "http_error" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "missing_version" };
  }

  const version = (body as Record<string, unknown>).version;
  if (typeof version !== "string" || version.length === 0) {
    return { ok: false, reason: "missing_version" };
  }

  return { ok: true, version };
}

/** Require byte-for-byte parity between Pi-Workbench SDK and proxy versions. */
export async function checkHeadroomVersion(
  baseUrl: string,
  expectedVersion: string | null,
  timeoutMs: number,
): Promise<HeadroomVersionCheck> {
  if (!expectedVersion) {
    return { ok: false, expectedVersion: null, reportedVersion: null, reason: "expected_version_unavailable" };
  }

  const health = await getHeadroomHealth(baseUrl, timeoutMs);
  if (!health.ok) {
    return { ok: false, expectedVersion, reportedVersion: null, reason: health.reason };
  }

  if (health.version !== expectedVersion) {
    return { ok: false, expectedVersion, reportedVersion: health.version, reason: "version_mismatch" };
  }

  return { ok: true, expectedVersion, reportedVersion: health.version };
}

export function describeHeadroomVersionCheck(result: HeadroomVersionCheck): string {
  if (result.ok) return `Headroom version ${result.reportedVersion} matches extension`;
  if (result.reason === "version_mismatch") {
    return `Headroom version mismatch: expected ${result.expectedVersion}, received ${result.reportedVersion}`;
  }
  if (result.reason === "expected_version_unavailable") return "Pi-Workbench bundled headroom-ai version is unavailable";
  if (result.reason === "missing_version") return "Headroom health response does not contain a version";
  if (result.reason === "invalid_json") return "Headroom health response is not valid JSON";
  if (result.reason === "http_error") return "Headroom health endpoint returned an error";
  return "Headroom health endpoint is unreachable";
}
