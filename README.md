# pi-workbench

Headroom context compression, project-scoped Memory, Code Graph, managed Playwright, and optional Study Mode for [Pi](https://pi.dev).

## Requirements and verified scope

- Pi 1.0+
- Node.js 22+.
- Python 3.10+ with venv/pip

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

## Headroom configuration

Installs and manages a Headroom process using configuration loaded from `~/.pi/pi-workbench/headroom.json`.

- `/wb:headroom-health` — managed process ownership/runtime diagnostics.

```json
{
  "schemaVersion": 1
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Required format identity: `1`. |
| `port` | Default `8787`. |
| `memory` | Optional project memory. |
| `compression` | Optional per-request tuning |

### Headroom Proxy

Headroom Proxy attempts to save tokens by compressing requests before they are sent.

- `/wb:headroom-proxy on` — saves this project's compression opt-in, then attempts managed activation.
- `/wb:headroom-proxy off` — disables this session and removes the project's compression opt-in.
- `/wb:headroom-proxy status` — reports both this session's state and the project's saved startup choice.

```json
{
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
| `mode` | `lossy_inline`, `lossless_then_lossy` | Compression pipeline method. |
| `targetRatio` | Number `0`–`1` | Requested retained fraction for lossy compression. Lower = more aggressive compression. |
| `compressUserMessages` | Boolean | Allow compression of user-role messages. |
| `protectRecent` | Non-negative integer | Number of newest messages left uncompressed. |
| `protectAnalysisContext` | Boolean | Leave analysis/reasoning context uncompressed. |
| `frozenMessageCount` | Non-negative integer | Number of earliest messages left uncompressed. |

#### Troubleshoot editing failures

If exact-match edits fail or source edits become unreliable, start with profile above. Reload extensions, retry same edit workflow, then compare editing reliability against token savings.

### Headroom Memory

Headroom Memory gives Pi durable, project-scoped context. Pi can then search relevant prior project decisions.

- `/wb:headroom-memory on` —  saves this project's Memory opt-in, then attempts managed activation.
- `/wb:headroom-memory off` — delete this workspace's Memory after confirmation.
- `/wb:headroom-memory show` — list current records in configured namespace.
- `/wb:headroom-memory export` — write Memory data into export directory.
- `/wb:headroom-memory import` — replace configured namespace from export directory; requires confirmation.
- `/wb:headroom-memory merge` — combine exported Memory with local Memory; exported version wins conflicts.

```json
{
  "memory": {
    "root": "~/",
    "namespace": "project",
    "export": ".headroom-memory"
  }
}
```

| Field | Meaning |
|---|---|
| `memory.root`  | Optional absolute or `~/` Memory base path for storing memory in a sqlite database. |
| `memory.namespace` | Logical Memory namespace; default `project`. |
| `memory.export` | Project-relative bundle directory for export/import memory as plain text files. Must remain inside the project. |

## Code Graph

Code Graph gives Pi structural code intelligence: symbol search, call paths, architecture overview, and impact queries over a local index of the current workspace.

- `/wb:code-graph on` — saves this project's Code-Graph opt-in, then attempts managed activation.
- `/wb:code-graph off` — delete this workspace's Code-Graph after confirmation.
- `/wb:code-graph reindex` — reindexes code.
- `/wb:code-graph status` — reports the status of the Code-Graph.

## Playwright

Playwright gives Pi access to a browser, so it can use your website or the web.

- `/wb:playwright on` — saves this project's Playwright opt-in, then attempts managed activation.
- `/wb:playwright off` — deletes this workspace's managed artifacts/diagnostics.
- `/wb:playwright status` — reports the status of Playwright

Each workspace creates a managed session store that saves Playwright configuration, artifacts, diagnostics and a private HOME/cache/tmp.

### Screenshots for text-only models

If your primary model cannot see images, a separate vision model can describe screenshots for it.

```json
{
  "schemaVersion": 1,
  "vision": {
    "provider": "llama.cpp",
    "model": "Qwen3-VL-4B-q4"
  }
}
```

Model must be selected and loaded manually before it can be used.

Images over 4 MiB are refused, and a failure returns a short reason (`unavailable`, `not loaded`, `too large`, `auth`, `timeout` or `model error`) so the agent can fall back to `browser_snapshot`.

## Study Mode

Study Mode adds guidance favoring questions, evidence, explanations, and avoiding changes. It is not a sandbox: tools, commands, Memory, proxy lifecycle, and session behavior remain available. For implementation, it recommends `/wb:study-mode off` or confirming intent; explicit requests can still proceed while enabled.

- `/wb:study-mode on` — enables study guidance.
- `/wb:study-mode off` — disables study guidance.

## System Prompt

Displays the system prompt which models usually will refuse to do when asked. Even when asked nicely.

- `/wb:show-system-prompt` — Preview assembled prompt guidance.

## License

[Apache-2.0](LICENSE)
