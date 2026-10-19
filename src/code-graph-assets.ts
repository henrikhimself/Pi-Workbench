/**
 * Packaged codebase-memory-mcp release assets.
 *
 * This manifest is reviewed and distributed with the Pi-Workbench package.
 * It is the only source of asset identity: no user configuration file,
 * environment variable, or runtime override may replace versions, URLs, or
 * checksums. A new release or platform requires a code-reviewed package
 * change plus product-owner approval.
 *
 * URL templates contain the literal token `v0.x.y`. The installer replaces
 * every occurrence with the asset version before downloading.
 */

export type CodeGraphPlatform = "linux-arm64";

export interface CodeGraphAsset {
  /** Exact release tag in `vMAJOR.MINOR.PATCH` form. */
  version: string;
  /** HTTPS GitHub release URL template containing at least one `v0.x.y` token. */
  url: string;
  /** SHA-256 of the release archive, 64 lowercase hex characters. */
  sha256: string;
  /**
   * Exact archive size in bytes, verified against the release during the
   * compatibility spike. Advisory: used for confirmation text and
   * diagnostics, never for integrity (SHA-256 is the binding check).
   */
  sizeBytes?: number;
}

export const CODE_GRAPH_ASSETS: Record<CodeGraphPlatform, CodeGraphAsset> = {
  "linux-arm64": {
    version: "v0.8.1",
    url:
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.x.y/codebase-memory-mcp-linux-arm64.tar.gz",
    sha256: "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091",
    sizeBytes: 36_458_830,
  },
};

/** The only archive member the installer may extract. */
export const CODE_GRAPH_BINARY_MEMBER = "codebase-memory-mcp";

export const ASSET_VERSION_TOKEN = "v0.x.y";

const ASSET_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ParsedAssetVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `vMAJOR.MINOR.PATCH`. Returns null for anything else. */
export function parseAssetVersion(version: string): ParsedAssetVersion | null {
  const match = typeof version === "string" ? version.match(ASSET_VERSION_PATTERN) : null;
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Numeric semantic comparison. Both arguments must parse; returns -1/0/1. */
export function compareAssetVersions(left: string, right: string): number {
  const a = parseAssetVersion(left);
  const b = parseAssetVersion(right);
  if (!a || !b) {
    throw new Error(`Unparseable asset version(s): ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  }
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}

/**
 * Validate one packaged asset entry. Returns a list of human-readable
 * problems; an empty list means the asset is acceptable.
 */
export function validateAsset(platform: string, asset: CodeGraphAsset): string[] {
  const problems: string[] = [];
  if (!(platform in CODE_GRAPH_ASSETS)) {
    problems.push(`Unsupported code graph platform: ${JSON.stringify(platform)}`);
  }
  if (!parseAssetVersion(asset.version)) {
    problems.push(`Asset version must use vMAJOR.MINOR.PATCH form; got ${JSON.stringify(asset.version)}`);
  }
  if (!SHA256_PATTERN.test(asset.sha256)) {
    problems.push(`Asset sha256 must be 64 lowercase hex characters; got ${JSON.stringify(asset.sha256)}`);
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(asset.url);
  } catch {
    problems.push(`Asset URL is not a valid URL: ${JSON.stringify(asset.url)}`);
  }
  if (parsed) {
    if (parsed.protocol !== "https:") {
      problems.push(`Asset URL must use HTTPS: ${asset.url}`);
    }
    if (parsed.hostname !== "github.com") {
      problems.push(`Asset URL must point at github.com: ${asset.url}`);
    }
    if (!parsed.pathname.startsWith("/DeusData/codebase-memory-mcp/releases/download/")) {
      problems.push(`Asset URL must be a DeusData/codebase-memory-mcp release download: ${asset.url}`);
    }
    if (!asset.url.includes(ASSET_VERSION_TOKEN)) {
      problems.push(`Asset URL must contain the literal ${ASSET_VERSION_TOKEN} token: ${asset.url}`);
    }
    if (asset.sizeBytes !== undefined && (!Number.isInteger(asset.sizeBytes) || asset.sizeBytes <= 0)) {
      problems.push(`Asset sizeBytes must be a positive integer: ${String(asset.sizeBytes)}`);
    }
  }
  return problems;
}

/**
 * Replace every literal `v0.x.y` token with the asset version.
 * Throws when the token is absent so a malformed template can never
 * download an unpinned release.
 */
export function resolveAssetUrl(asset: CodeGraphAsset): string {
  if (!asset.url.includes(ASSET_VERSION_TOKEN)) {
    throw new Error(`Asset URL is missing the ${ASSET_VERSION_TOKEN} token: ${asset.url}`);
  }
  return asset.url.split(ASSET_VERSION_TOKEN).join(asset.version);
}

/** Look up a packaged asset; throws a diagnostic for unsupported platforms. */
export function getAsset(platform: string): { platform: CodeGraphPlatform; asset: CodeGraphAsset } {
  const problems = validateAsset(platform, CODE_GRAPH_ASSETS[platform as CodeGraphPlatform] ?? { version: "", url: "", sha256: "" });
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
  return { platform: platform as CodeGraphPlatform, asset: CODE_GRAPH_ASSETS[platform as CodeGraphPlatform] };
}
