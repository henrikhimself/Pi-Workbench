/** Every file Workbench parses carries `schemaVersion: 1`. Anything else is refused at once; nothing is converted. */
export const SCHEMA_VERSION = 1 as const;

/** Throws `<what> schemaVersion must be 1` unless `record` is an object whose `schemaVersion` is exactly 1. */
export function requireSchemaVersion(record: unknown, what: string): void {
  if (!record || typeof record !== "object" || Array.isArray(record) || (record as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${what} schemaVersion must be ${SCHEMA_VERSION}`);
  }
}
