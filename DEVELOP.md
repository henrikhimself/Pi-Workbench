# Developing pi-workbench

Notes for working on the extension itself. For user-facing behavior see [README.md](README.md); for the command cheat sheet used by agents see [AGENTS.md](AGENTS.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22+ | Verified with 22.22.2 |
| npm | bundled with Node | Used for install, test and typecheck |
| Python | 3.10+ with `venv` and `pip` | Workbench creates managed virtualenvs for Headroom and Memory |
| git | any recent | |
| `pi` | 1.5.0 | Must be on `PATH` and already configured with a provider/model (verified: 1.5.0) |
| `curl`, `jq` | any | Only for the vision-model helpers and health checks |

`tsc` does not need to be on `PATH`; `npm run typecheck` uses the local copy.

Not needed for offline work: `uv`, a browser, or a running llama.cpp server.

## Setup

```bash
npm install
```

## Everyday checks

```bash
npm test                 # offline unit and smoke tests (~1 min, no network, no env vars)
npm run typecheck        # strict TypeScript
git diff --check         # whitespace errors

# All three together
npm test && npm run typecheck && git diff --check
```

Run a single test file:

```bash
node --test test/managed-mcp.test.mjs
```

## Running the extension

```bash
# Once, without installing
pi -e ./src/index.ts

# Headless Pi with Workbench and the required built-in MCP integration
pi --mode rpc --no-session --no-extensions -e builtin:mcp -e ./src/index.ts --model <provider>/<model>
```

## Test tiers

| Tier | Command | Needs |
|---|---|---|
| Offline | `npm test` | Nothing |
| Runtime | `WORKBENCH_RUNTIME_TESTS=1 node test/runtime-headroom.mjs` (also `runtime-code-graph.mjs`, `runtime-playwright.mjs --keep`) | Network and installs. Runs in an isolated runtime, never your real proxy or stores |
| Live | `WORKBENCH_LIVE_MODEL=<id> WORKBENCH_LIVE_TESTS=1 node test/live-pi.mjs --keep` | A loaded local model on llama.cpp |
| Playwright live | see [AGENTS.md](AGENTS.md) | The live setup, plus a retained runtime report |
| Test quality | `node test/test-quality.mjs` | Injects deliberate defects into disposable source copies to check the tests catch them |

Runtime and live tests are opt-in because they install software and talk to real models.

## Running the runtime and live tiers

Verified end to end on Linux x64 with Node 22.22.2, Pi 1.5.0, and a llama.cpp router with the agent model and the vision model both loaded. Each script creates a disposable home under `/tmp` and downloads what it needs (Headroom runtime and ONNX model, the pinned `codebase-memory-mcp` binary, Chromium), so they need network access and take a few minutes.

```bash
export WORKBENCH_RUNTIME_TESTS=1
node test/runtime-headroom.mjs
node test/runtime-code-graph.mjs
node test/runtime-playwright.mjs --keep      # prints "Retained Playwright acceptance fixture: <dir>"

export WORKBENCH_LIVE_TESTS=1                # also needs LLAMA_BASE_URL, LLAMA_API_KEY, WORKBENCH_LIVE_MODEL
node test/live-pi.mjs --keep
WORKBENCH_PLAYWRIGHT_LIVE_TESTS=1 \
  WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE=<retained dir>/acceptance.json \
  node test/live-playwright.mjs --keep
```

`--keep` leaves the disposable fixtures in `/tmp` (`wb-playwright-runtime-*`, `wl-*`, `wb-playwright-live-*`). Delete them when done.

Gaps the live Playwright gate reports as unverified: image input to the agent (the live agent model is text-only), the real TUI and RPC wire transport for the confirmation dialogs, and compression-on image capture.

## Environment variables

All are unset by default, and none is needed for `npm test`.

| Variable | Used by |
|---|---|
| `WORKBENCH_RUNTIME_TESTS=1` | Runtime tests |
| `WORKBENCH_LIVE_TESTS=1` | `test/live-pi.mjs` |
| `WORKBENCH_LIVE_MODEL` | Id of the already-loaded agent model for live tests |
| `LLAMA_BASE_URL` | llama.cpp router, for live tests and vision helpers |
| `LLAMA_API_KEY` | The same router |
| `WORKBENCH_PLAYWRIGHT_LIVE_TESTS=1` | `test/live-playwright.mjs` |
| `WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE` | Path to a retained runtime `acceptance.json` |
| `WORKBENCH_PLAYWRIGHT_HTTPS_URL` | Optional: anonymous trusted synthetic HTTPS endpoint for the Playwright runtime test; otherwise HTTPS is reported as unverified |
| `WORKBENCH_PLAYWRIGHT_LIVE_COMPRESSION=1` | Optional: also exercise image capture with compression on |

Do not commit values for `LLAMA_API_KEY` or any other secret.

## State on disk

Workbench keeps all state under `~/.pi/pi-workbench`, shared by every Pi process on the machine. The directory is created on first use. It may already hold `headroom.json`, `playwright.json`, and the `headroom`, `playwright`, `codebase-memory-mcp` and `run` subdirectories from earlier use.

- `playwright.json` holds the Playwright config, including `vision.model`. The vision helpers in AGENTS.md read it.
- Runtime tests are meant to use isolated directories. Do not point them at your real store.

## llama.cpp router rules

- Loading and unloading the **vision** model through the router is fine. AGENTS.md has the helper functions.
- **Never load or unload the agent model** (`WORKBENCH_LIVE_MODEL`). Doing so breaks the agentic flow.
- HTTP 400 "model is already running" or "model is not running" means the model is already in the requested state.

## TODO

Still to document:

- Release and versioning process
- How to add a new managed feature (config, schema version, command, tests)
- Debugging a managed process that is stuck or leaves stale locks
- Pinned dependency upgrade procedure (`headroom-ai`, Pi packages, Playwright assets)
