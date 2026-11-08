# pi-workbench

Headroom context compression, project-scoped Memory, Code Graph, managed Playwright, and optional Study Mode for [Pi](https://pi.dev).

## Requirements and verified scope

- Pi 1.5.0 (developed and type-checked against 1.5.0; earlier versions are not tested)
- Node.js 22+.
- Python 3.10+ with venv/pip. The venv Python creates must ship pip 22.2 or newer (the install uses `pip install --dry-run --report`). Some Python 3.10 builds ship an older pip, for example Ubuntu 22.04 (pip 22.0.2); install then stops with a message naming both versions, and nothing is upgraded for you.

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

#### Proxy tuning for slow machines

The optional `proxy` section maps to Headroom's own settings and is applied when this session **starts** the managed proxy. A proxy that another session already started keeps its settings; stop it (turn compression off in every session) before changing them. `headroom.json` is read when Pi loads the extension, so use `/reload` or start a new session after editing it.

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

Other `HEADROOM_*` environment variables are not passed to the proxy; only these validated values are.

#### Troubleshoot editing failures

If exact-match edits fail or source edits become unreliable, start with profile above. Reload extensions, retry same edit workflow, then compare editing reliability against token savings.

### Headroom Memory

Headroom Memory gives Pi durable, project-scoped context. Pi can then search relevant prior project decisions.

- `/wb:headroom-memory on` —  saves this project's Memory opt-in, then attempts managed activation.
- `/wb:headroom-memory off [--confirm-delete]` — delete this workspace's Memory after confirmation (`--confirm-delete` replaces the prompt).
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
- `/wb:code-graph off [--confirm-delete]` — delete this workspace's Code-Graph after confirmation (`--confirm-delete` replaces the prompt).
- `/wb:code-graph reindex` — reindexes code.
- `/wb:code-graph status` — reports the status of the Code-Graph.

## Playwright

Playwright gives Pi access to a browser, so it can use your website or the web.

- `/wb:playwright on` — saves this project's Playwright opt-in, then attempts managed activation.
- `/wb:playwright off [--confirm-delete]` — deletes this workspace's managed artifacts/diagnostics after confirmation (`--confirm-delete` replaces the prompt).
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

Before each description Workbench checks that the model is loaded, without loading it: it sends one `GET <provider base URL>/models` with the provider's configured headers, adding the API key as a Bearer token only when no `Authorization` header is configured. The listing must contain the model. An entry with a `status` other than `loaded` counts as not loaded, and an entry with no `status` counts as loaded (a single-model server). A provider without a `/models` listing is reported as `unavailable` and cannot be used for vision.

Images over 4 MiB are refused, and a failure returns a short reason (`unavailable`, `not loaded`, `too large`, `auth`, `timeout` or `model error`) so the agent can fall back to `browser_snapshot`.

## Where Workbench keeps its state

Workbench keeps everything under `~/.pi/pi-workbench`. The location follows your home directory, not `PI_CODING_AGENT_DIR`, so every Pi configuration on one machine shares the same store, the same leases and the same proxy port. For an isolated setup (a container or a test agent directory) use a separate `HOME`.

```
~/.pi/pi-workbench/
  headroom.json, playwright.json     your settings
  headroom/                          managed Python runtime, Memory stores, compression opt-ins
  codebase-memory-mcp/               Code Graph binary, downloads, per-project index data
  playwright/                        Playwright runtime, per-project artifacts and diagnostics
```

What is shared and what is per session:

- **Headroom compression:** one managed proxy on the configured `port` (default 8787). The first session that needs it starts it, and later sessions use it while it is healthy and on the same runtime. It stops after the last session releases it. If something else holds the port, Workbench does not start another proxy.
- **Headroom Memory:** the store is per project.
- **Code Graph:** an MCP server over stdio, started for each Pi session. There is no port. The downloaded binary, the install lock and each project's index data are shared; `/wb:code-graph off` waits for other sessions that still use the index.
- **Playwright:** also one server per session. Only the runtime install is shared.

A project is on when its opt-in exists. Headroom compression, Code Graph and Playwright save it as `opt-in.json`, written last so a project without one is off; Headroom Memory counts the presence of its database. Headroom Memory and Code Graph also keep a `workbench-identity.json` in the project's data folder that says which release wrote it. Workbench never converts data and never deletes it on its own. If that marker is from another release, or the folder has content but no marker, the tool says "`<Tool>` data was written by another version, which this release does not read. It was left unchanged." and stays off.

### Command results

`on`, `off` and `status` answer the same way in all four tools. `on` ends with "`<Tool>` enabled for this project". `off` ends with "disabled for this project" (Headroom compression), "already off for this project", or, for the three tools that store project data, "data deleted for this project". `status` prints one layout:

```
<Tool>
  State:    on | off | off (<reason>) | refused (<reason>)
  Project:  <workspace path>  (<identifier>)
  Data:     <directory> | none
  Version:  <installed> (expected <pinned>) | not installed
  Link:     registered | not registered | running | not running
  Problem:  only when something is wrong
  Details:  tool-specific lines
```

## Study Mode

Study Mode adds guidance favoring questions, evidence, explanations, and avoiding changes. It is not a sandbox: tools, commands, Memory, proxy lifecycle, and session behavior remain available. For implementation, it recommends `/wb:study-mode off` or confirming intent; explicit requests can still proceed while enabled.

- `/wb:study-mode on` — enables study guidance.
- `/wb:study-mode off` — disables study guidance.

## System Prompt

Displays the system prompt which models usually will refuse to do when asked. Even when asked nicely.

- `/wb:show-system-prompt` — Preview assembled prompt guidance.

## License

[Apache-2.0](LICENSE)
