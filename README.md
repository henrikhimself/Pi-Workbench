# pi-workbench

Headroom context compression, project-scoped Memory, Code Graph, Playwright, and Study Mode for [Pi](https://pi.dev).

## Requirements and verified scope

- Pi 1.5.0.
- Node.js 22+.
- Python 3.10+ with venv/pip.

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

## Where Workbench keeps its state

Workbench keeps everything under `~/.pi/pi-workbench`, so every Pi process on one machine shares the same store.

## Headroom configuration

Installs and manages a Headroom process using configuration loaded from `headroom.json`.


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
| `proxy` | Optional tuning of the managed proxy process, for slow machines or very large conversations. |

### Headroom Proxy

Headroom Proxy attempts to save tokens by compressing requests before they are sent to your LLM.

- `/wb:headroom-proxy on` — saves this project's compression opt-in first, then attempts managed activation. If activation fails the opt-in is kept, so the next session retries.
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

#### Proxy tuning for slow machines

The optional `proxy` section maps to Headroom's own settings and is applied when this session starts the managed proxy. A proxy that another session already started keeps its settings.

```json
{
  "proxy": {
    "compressionTimeoutSeconds": 90,
    "backgroundCompression": true,
    "backgroundCompressionMinTokens": 50000
  }
}
```

| Field | Valid values | Meaning |
|---|---|---|
| `compressionTimeoutSeconds` | Integer `5`–`600` | Server-side compression time limit. Default `30`. Pi waits 15 s longer than this before giving up on a request. |
| `backgroundCompression` | Boolean | Compress large cold-start requests off the request path instead of holding a worker. Default off. |
| `backgroundCompressionMinTokens` | Integer `1`–`10000000` | Request size from which background compression applies. Default `50000`. |
| `quarantineThreshold` | Integer `1`–`64` | Number of timed-out compression workers that makes the proxy refuse new work. Headroom's default is half its worker pool. |
| `quarantineMaxSeconds` | Integer `1`–`3600` | Longest time that refusal lasts. Default `60`. |

#### Troubleshoot editing failures

If exact-match edits fail or source edits become unreliable, start with profile above. Reload extensions, retry same edit workflow, then compare editing reliability against token savings.

### Headroom Memory

Headroom Memory gives Pi durable, project-scoped context. Pi can then search relevant prior project decisions.

- `/wb:headroom-memory on` — prepares the managed runtime and ONNX model, then creates the project's Memory store, which is its opt-in. If any step fails nothing is saved.
- `/wb:headroom-memory off [--confirm-delete]` — delete this workspace's Memory after confirmation (`--confirm-delete` replaces the prompt).
- `/wb:headroom-memory status` — reports the status (layout in [Command results](#command-results)).
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
| `root`  | Optional absolute or `~/` Memory base path for storing memory in a sqlite database. |
| `namespace` | Logical Memory namespace; default `project`. |
| `export` | Project-relative bundle directory for export/import memory as plain text files. Must remain inside the project. |

#### Merging Memories

The `memory.export` is for exchanging memories. Run `/wb:headroom-memory merge` to merge them with your own memories. 

Once memories are merged, you can share them using `/wb:headroom-memory export`.

Git merge conflicts will occur. To help avoid this nuisance, a marked block is written to `.gitattributes` that chages git merge behavior for the memory export directory. 

Each memories `merge` keeps the previous store under the Memory root. These backups are never pruned automatically.

## Code Graph

Code Graph gives Pi structural code intelligence: symbol search, call paths, architecture overview, and impact queries over a local index of the current workspace.

- `/wb:code-graph on` — installs, indexes and validates, then saves this project's opt-in as the last step. If any step fails nothing is saved.
- `/wb:code-graph off [--confirm-delete]` — delete this workspace's Code-Graph after confirmation (`--confirm-delete` replaces the prompt).
- `/wb:code-graph reindex` — reindexes code.
- `/wb:code-graph status` — reports the status of the Code-Graph.

## Playwright

Playwright gives Pi access to a browser, so it can use your website or the web. Each workspace creates a managed session store that keeps Playwright artifacts.

It loads configuration from `playwright.json`.

```json
{
  "schemaVersion": 1
}
```

- `/wb:playwright on` — saves this project's Playwright opt-in first, then installs and activates. If the install fails the opt-in is kept. A new session reuses the installed runtime and never installs. If none is installed for this version, or the host Node/npm changed, run `/wb:playwright on` again.
- `/wb:playwright off [--confirm-delete]` — deletes this workspace's managed artifacts and session records after confirmation (`--confirm-delete` replaces the prompt).
- `/wb:playwright status` — reports the status of Playwright

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

| Field | Meaning |
|---|---|
| `vision.provider`  | The Pi model provider name.  |
| `vision.model` | The name of the vision capable model that will be used. |

Vision model must be loaded manually before it can be used. Images over 4 MiB are refused

## Study Mode

Study Mode adds guidance favoring questions, evidence, explanations, and avoiding changes. It is not a sandbox: tools, commands, Memory, proxy lifecycle, and session behavior remain available. For implementation, it recommends `/wb:study-mode off` or confirming intent; explicit requests can still proceed while enabled.

- `/wb:study-mode on` — enables study guidance.
- `/wb:study-mode off` — disables study guidance.

## System Prompt

Displays the system prompt which models usually will refuse to do when asked. Even when asked nicely.

- `/wb:show-system-prompt` — Preview assembled prompt guidance.

## License

[Apache-2.0](LICENSE). Third-party component attribution: [NOTICE](NOTICE).
