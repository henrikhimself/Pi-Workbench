# pi-workbench

`pi-workbench` adds Headroom context compression, project Memory, Learning Mode, and Study Mode guidance to the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Requirements

- Pi 1.0+
- Python 3.10+

## Install from GitHub

Repository: <https://github.com/henrikhimself/Pi-Workbench>

```bash
# Install for current user
pi install git:github.com/henrikhimself/Pi-Workbench

# Install for current project
pi install --local git:github.com/henrikhimself/Pi-Workbench

# Try once without saving package settings
pi -e git:github.com/henrikhimself/Pi-Workbench
```

Update installed extensions:

```bash
pi update --extensions
```

Remove extension:

```bash
pi remove git:github.com/henrikhimself/Pi-Workbench
```

## Configuration

On first session start, pi-workbench creates `headroom.json` under `~/.pi/pi-workbench/` and never overwrites user edits.

### `headroom.json`

```json
{
  "port": 8787
}
```

| Field | Meaning |
|---|---|
| `url` | External Headroom proxy URL. Disables extension proxy management. Mutually exclusive with `port`. |
| `port` | Managed localhost proxy port. Default: `8787`. Specifying `port` implies `http://127.0.0.1:<port>` and extension management. Mutually exclusive with `url`. |
| `memoryRoot` | Absolute or `~/` root for project Memory stores. Default: `~/.pi/pi-workbench/headroom-memory`. |
| `memoryNamespace` | Logical Headroom Memory namespace. Default: `project`. |
| `memory.export` | Optional project-relative canonical Memory export directory, such as `.headroom-memory`. Must remain below project root. Required for export, import, and merge. |
| `compression` | Optional per-request Headroom compression overrides. Omit to preserve Headroom defaults. See below. |

Use exactly one proxy setting. `url` connects compression to external Headroom and never starts or installs its proxy. `port` selects extension-managed localhost Headroom. Configuring both is rejected.

### Compression tuning

The optional `compression` settings travel with every compression request. They work with both managed `port` proxy and external `url` proxy; pi-workbench does not change or restart proxy service configuration.

```json
{
  "port": 8787,
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
| `mode` | `ccr`, `lossy_inline`, `lossless_then_lossy` | Compression pipeline. `ccr` and `lossless_then_lossy` better fit recovery-sensitive workflows. |
| `targetRatio` | Number `0`–`1` | Requested retained fraction for lossy compression. Lower = more aggressive compression. |
| `compressUserMessages` | Boolean | Allow compression of user-role messages. |
| `protectRecent` | Non-negative integer | Number of newest messages left uncompressed. |
| `protectAnalysisContext` | Boolean | Leave analysis/reasoning context uncompressed. |
| `frozenMessageCount` | Non-negative integer | Number of earliest messages left uncompressed. |

Headroom selects content transforms automatically. `compression` does not select code, logs, JSON, or other transform types. `/wb:headroom-health` and `/wb:headroom-proxy status` show configured overrides.

#### Troubleshoot editing failures

If exact-match edits fail or source edits become unreliable, start with profile above: `lossless_then_lossy`, `targetRatio: 0.8`, `compressUserMessages: false`, `protectRecent: 8`, and `protectAnalysisContext: true`. Reload extensions, retry same edit workflow, then compare editing reliability against token savings. Omit `compression` to return to Headroom defaults.

### Headroom Memory

Headroom Memory gives Pi durable, project-scoped context. Enable it with `/wb:headroom-memory on`; Pi can then search relevant prior project decisions and save facts only when requested or confirmed.

Memory is independent from context compression. It works with both managed proxy `port` and external proxy `url` configurations.

Optionally configure a namespace and export directory for sharing Memory through your repository:

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

Memory never syncs automatically. Enabling it prepares repository merge support for configured export directory, but never stages, commits, pulls, or pushes changes. Each clone needs Memory enabled separately.

### Study Mode

Study Mode adds branch-scoped guidance favoring questions, evidence, explanations, and avoiding changes. It is not a sandbox: tools, commands, Memory, proxy lifecycle, and session behavior remain available. For implementation, it recommends `/wb:study-mode off` or confirming intent; explicit requests can still proceed while enabled.

## Commands

| Command | Purpose |
|---|---|
| `/wb:headroom-proxy [on\|off\|status]` | Control or inspect Headroom context compression. |
| `/wb:headroom-health` | Show Headroom proxy diagnostics. |
| `/wb:headroom-memory [on\|off\|status\|show\|export\|import\|merge]` | Manage project-scoped persistent Memory. `show` lists current records. `export`, `import`, and `merge` require `memory.export`. `import` needs UI confirmation or `--confirm-replace`; `off` needs UI confirmation or `--confirm-delete`. |
| `/wb:preceptor-mode [on\|off\|status]` | Toggle branch-scoped Learning Mode. |
| `/wb:study-mode [on\|off\|status]` | Toggle branch-scoped Study guidance. Tools and commands remain available. |
| `/wb:show-system-prompt` | Preview active Pi system prompt additions. |

## License

[Apache-2.0](LICENSE)
