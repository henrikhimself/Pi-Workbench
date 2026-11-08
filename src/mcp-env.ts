/**
 * Pi resolves every registered MCP `env` value as a config template
 * (`resolveConfigValueOrThrow`): `$NAME` / `${NAME}` interpolate, a leading `!`
 * runs a shell command, and `$$` / `$!` are the escapes for a literal `$` / `!`.
 * Paths or proxy URLs containing `$` would be mangled or fail to start, so every
 * value registered through `McpServerConfig.env` goes through this escape.
 */
export function escapeMcpEnvValue(value: string): string {
  const escaped = value.replaceAll("$", "$$$$");
  // After doubling, a leading "!" is not part of an escape: `$!` turns it into a literal.
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

export function escapeMcpEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, escapeMcpEnvValue(value)]));
}
