# pi-workbench

Headroom context compression, project-scoped Memory, Code Graph, and optional Study Mode for [Pi](https://pi.dev).

## Requirements and verified scope

- Pi 1.0+ and Node.js 22+.
- Python 3.10+ with venv/pip support for Headroom. Memory uses CPU ONNX only.

## Install, update, remove

```bash
pi install git:github.com/henrikhimself/Pi-Workbench
# Or project-local:
pi install --local git:github.com/henrikhimself/Pi-Workbench
# Try without saving package settings:
pi -e git:github.com/henrikhimself/Pi-Workbench

pi update --extensions
pi remove git:github.com/henrikhimself/Pi-Workbench
```

**Choosing an extension upgrade authorizes its pinned backend upgrades.** Eligible components prepare/install/validate automatically, without an upgrade prompt, `--yes`, or a dedicated upgrade command. Busy peers, unsafe space, incompatible state, and failed validation leave the affected feature off, preserve data, and report a reason. Retry later through normal activation. Other healthy features remain usable.

Read [RELEASE-NOTES.md](RELEASE-NOTES.md) before this release: **Headroom makes an intentional clean break.** Existing installation/store files remain untouched; no discovery, adoption, conversion, migration, or automatic import occurs.

## Fresh managed Headroom configuration

Canonical file: `~/.pi/pi-workbench/headroom.json`. A missing file is created on session start. An existing incompatible file is rejected **without rewriting it**. Supply a fresh configuration manually and reload/restart Pi.

```json
{
  "schemaVersion": 1,
  "port": 8787
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Required format identity: `1`. Old-format files are not converted. |
| `port` | Managed loopback port; default `8787`. No silent alternate port. |
| `memoryRoot` | Optional absolute or `~/` Memory base. Custom roots use a distinct `workbench-memory-v1` namespace; old `projects/` stores are not adopted. |
| `memoryNamespace` | Logical Memory namespace; default `project`. |
| `memory.export` | Optional project-relative logical bundle directory. Must remain inside the project. Required for export/import/merge. |
| `compression` | Optional per-request tuning; omit to use Headroom defaults. |

`url` and external-proxy mode are removed. Unknown occupants of the configured port are not adopted, stopped, or sent plaintext Pi context.

A fuller fresh configuration:

```json
{
  "schemaVersion": 1,
  "port": 8787,
  "memoryNamespace": "project",
  "memory": { "export": ".headroom-memory" },
  "compression": {
    "mode": "lossless_then_lossy",
    "targetRatio": 0.8,
    "compressUserMessages": false,
    "protectRecent": 8,
    "protectAnalysisContext": true,
    "frozenMessageCount": 0
  }
}
```

| Field | Valid values | Meaning |
|---|---|---|
| `mode` | `lossy_inline`, `lossless_then_lossy` | Compression pipeline. `lossless_then_lossy` better fit recovery-sensitive workflows. |
| `targetRatio` | Number `0`–`1` | Requested retained fraction for lossy compression. Lower = more aggressive compression. |
| `compressUserMessages` | Boolean | Allow compression of user-role messages. |
| `protectRecent` | Non-negative integer | Number of newest messages left uncompressed. |
| `protectAnalysisContext` | Boolean | Leave analysis/reasoning context uncompressed. |
| `frozenMessageCount` | Non-negative integer | Number of earliest messages left uncompressed. |

Headroom selects content transforms automatically.

#### Troubleshoot editing failures

If exact-match edits fail or source edits become unreliable, start with profile above. Reload extensions, retry same edit workflow, then compare editing reliability against token savings.

### Headroom Memory

Headroom Memory gives Pi durable, project-scoped context. Enable it with `/wb:headroom-memory on`; Pi can then search relevant prior project decisions and save facts only when requested or confirmed.

Optionally configure a namespace and export directory for sharing Memory through your repository as plain text files:

```json
{
  "memoryNamespace": "project",
  "memory": {
    "export": ".headroom-memory"
  }
}
```

`memory.export` must be a project-relative directory. It enables these commands:

- `show` — list current records in configured namespace.
- `export` — write Memory data into export directory.
- `import` — replace configured namespace from export directory; requires confirmation.
- `merge` — combine exported Memory with local Memory; exported version wins conflicts.
- `off` — delete this workspace's Memory after confirmation;

## Code Graph

Code Graph gives Pi structural code intelligence: symbol search, call paths, architecture overview, and impact queries over a local index of the current workspace.

The feature is enabled using `/wb:code-graph on` in a workspace. Workspace data is under `~/.pi/pi-workbench/codebase-memory-mcp/`.

### Study Mode

Study Mode adds guidance favoring questions, evidence, explanations, and avoiding changes. It is not a sandbox: tools, commands, Memory, proxy lifecycle, and session behavior remain available. For implementation, it recommends `/wb:study-mode off` or confirming intent; explicit requests can still proceed while enabled.

## Commands

| Command | Purpose |
|---|---|
| `/wb:headroom-proxy [on\|off\|status]` | Activate/retry, disable session compression, inspect state. |
| `/wb:headroom-health` | Managed ownership/runtime diagnostics. |
| `/wb:headroom-memory [on\|off\|status\|show\|export\|import\|merge]` | Project Memory. Destructive `off` needs UI confirmation or `--confirm-delete`; `import` needs confirmation or `--confirm-replace`. |
| `/wb:code-graph [on\|off\|reindex\|status]` | Workspace graph. `off` **deletes** its store after confirmation or `--confirm-delete`; binaries, backups, other workspaces and Memory remain. |
| `/wb:study-mode [on\|off\|status]` | Study guidance, not a tool/command sandbox. |
| `/wb:show-system-prompt` | Preview assembled prompt guidance. |

## License

[Apache-2.0](LICENSE)
