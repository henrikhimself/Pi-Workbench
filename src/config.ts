export const DEFAULT_HEADROOM_PORT = 8787;

/** Validate a managed-proxy port loaded from headroom.json. */
export function parseHeadroomPort(value: unknown): number {
  if (value === undefined) return DEFAULT_HEADROOM_PORT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`headroom.json port must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  }
  return value;
}
