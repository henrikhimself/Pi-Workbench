/** One vocabulary for `on`, `off` and `status` across the four tools. Names come from `tool-names.ts`. */

export type OffOutcome = "disabled" | "already-off" | "deleted";

export function enabledMessage(tool: string): string { return `${tool} enabled for this project`; }

export function offMessage(tool: string, outcome: OffOutcome): string {
  switch (outcome) {
    case "disabled": return `${tool} disabled for this project`;
    case "already-off": return `${tool} already off for this project`;
    case "deleted": return `${tool} data deleted for this project`;
  }
}

export interface StatusFields {
  /** `on`, `off`, `off (<reason>)` or `refused (<reason>)`. */
  state: string;
  projectPath: string;
  identifier: string;
  /** The data directory, or omitted when the project has none. */
  data?: string | null;
  /** Installed version and the pinned one, either may be unknown. */
  version?: { installed?: string | null; expected?: string };
  /** MCP registration (`registered`, `not registered`) or proxy health (`running`, `not running`). */
  link?: string;
  /** Only when something is wrong. */
  problem?: string;
  /** Tool-specific lines, printed under `Details:`. */
  details?: string[];
}

function versionLine(version: NonNullable<StatusFields["version"]>): string | undefined {
  if (version.installed) return version.expected ? `${version.installed} (expected ${version.expected})` : version.installed;
  return version.expected !== undefined || version.installed === null ? "not installed" : undefined;
}

/** The same header block in the same order for every tool; absent optional fields are left out. */
export function formatStatus(tool: string, fields: StatusFields): string[] {
  const row = (label: string, value: string) => `  ${`${label}:`.padEnd(10)}${value}`;
  const lines = [tool, row("State", fields.state), row("Project", `${fields.projectPath}  (${fields.identifier})`),
    row("Data", fields.data ? fields.data : "none")];
  const version = fields.version ? versionLine(fields.version) : undefined;
  if (version) lines.push(row("Version", version));
  if (fields.link) lines.push(row("Link", fields.link));
  if (fields.problem) lines.push(row("Problem", fields.problem));
  if (fields.details?.length) lines.push("  Details:", ...fields.details.map(line => `    ${line}`));
  return lines;
}
