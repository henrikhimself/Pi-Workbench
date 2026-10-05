# pi-workbench

`pi-workbench` adds Headroom context compression, project Memory, Learning Mode, and tutor-only Study Mode to the [Pi coding agent](https://github.com/badlogic/pi-mono).

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

On first session start, pi-workbench creates these files under `~/.pi/pi-workbench/` and never overwrites user edits.

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
| `memoryUser` | Logical Headroom Memory user identity. Default: OS user name. |

Use exactly one proxy setting. `url` connects compression to external Headroom and never starts or installs its proxy. `port` selects extension-managed localhost Headroom. Configuring both is rejected.

Headroom Memory is separate from compression proxy. It starts local project-scoped `headroom.memory.mcp_server` with CPU-only `OnnxLocalEmbedder`, so it needs `~/.pi/pi-workbench/headroom-venv` even when `url` points at healthy external Headroom. External proxy service is not Memory MCP endpoint and is not reused.

### `study-mode.json`

```json
{
  "version": 1,
  "allowedBuiltInTools": ["read", "grep", "find", "ls"],
  "allowedSkills": [],
  "allowedMcpServers": ["headroom-memory"]
}
```

Study Mode permits only configured inspection tools, configured read-only MCP tools, bounded local .NET inspection, and bounded public HTTPS source fetch. `memory_search` is allowed when available; `memory_save` remains blocked.

## Commands

| Command | Purpose |
|---|---|
| `/wb:headroom-proxy [on\|off\|status]` | Control or inspect Headroom context compression. |
| `/wb:headroom-health` | Show Headroom proxy diagnostics. |
| `/wb:headroom-memory [on\|off\|status]` | Enable, remove, or inspect project-scoped persistent Memory. Use `off --confirm-delete` for noninteractive deletion. |
| `/wb:preceptor-mode [on\|off\|status]` | Toggle branch-scoped Learning Mode. |
| `/wb:study-mode [on\|off\|status]` | Toggle branch-scoped tutor-only Study Mode. |
| `/wb:show-system-prompt` | Preview active Pi system prompt additions. |

## License

[Apache-2.0](LICENSE)
