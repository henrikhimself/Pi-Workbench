# Developing pi-workbench

Notes for working on the extension itself. For user-facing behavior see [README.md](README.md). Development commands (tests, the vision-model helpers, health check) are listed under **Common commands** below.

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
| Playwright live | `WORKBENCH_LIVE_MODEL=<id> WORKBENCH_LIVE_TESTS=1 WORKBENCH_PLAYWRIGHT_LIVE_TESTS=1 WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE=<retained>/acceptance.json node test/live-playwright.mjs --keep` | The live setup, plus a retained runtime report |
| Test quality | `node test/test-quality.mjs` | Injects deliberate defects into disposable source copies to check the tests catch them |

Runtime and live tests are opt-in because they install software and talk to real models.

## Running the runtime and live tiers

Each script creates a disposable home under `/tmp` and downloads what it needs (Headroom runtime and ONNX model, the pinned `codebase-memory-mcp` binary, Chromium), so they need network access and take a few minutes.

## Common commands

Runtime/live scripts, the vision-model helpers, and the health check live here so they are not duplicated in [AGENTS.md](AGENTS.md).

```bash
# Explicit isolated runtime acceptance; never current user proxy/stores
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-headroom.mjs
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-code-graph.mjs

# Playwright runtime; no Pi/model
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-playwright.mjs --keep

# Explicit live Pi gate: already-loaded local model named in WORKBENCH_LIVE_MODEL
# (plus LLAMA_BASE_URL/LLAMA_API_KEY)
WORKBENCH_LIVE_MODEL=<model-id> WORKBENCH_LIVE_TESTS=1 node test/live-pi.mjs --keep

# Separately Playwright live gate; requires successful retained runtime report
WORKBENCH_LIVE_MODEL=<model-id> WORKBENCH_LIVE_TESTS=1 WORKBENCH_PLAYWRIGHT_LIVE_TESTS=1 \
  WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE=/retained/disposable/acceptance.json \
  node test/live-playwright.mjs --keep

# Deliberate test defects in disposable source copies
node test/test-quality.mjs

# Check HTTP availability only (not managed ownership)
curl -fsS http://127.0.0.1:8787/health
```

For testing ONLY, load or unload the vision model on the llama.cpp router
(vision.model in `~/.pi/pi-workbench/playwright.json`). NEVER load or unload
the agent model (WORKBENCH_LIVE_MODEL): unloading it breaks the agentic flow.
HTTP 400 "model is already running" / "model is not running" means the model
is already in the requested state.

```bash
vision_model() {
  local m; m=$(jq -r '.vision.model // empty' ~/.pi/pi-workbench/playwright.json) || return 1
  [ -n "$m" ] || { echo "vision.model is not configured" >&2; return 1; }
  echo "$m"
}
vision_model_set() { # $1 = load | unload
  local m; m=$(vision_model) || return 1
  curl -sS -X POST "$LLAMA_BASE_URL/models/$1" -H "Authorization: Bearer $LLAMA_API_KEY" \
    -H 'Content-Type: application/json' -d "{\"model\":\"$m\"}"
  until [ "$(curl -sS "$LLAMA_BASE_URL/v1/models" -H "Authorization: Bearer $LLAMA_API_KEY" \
    | jq -r --arg m "$m" '.data[] | select(.id==$m) | .status.value')" = "${1}ed" ]; do sleep 2; done
}
load_vision_model() { vision_model_set load; }
unload_vision_model() { vision_model_set unload; }
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

- `playwright.json` holds the Playwright config, including `vision.model`. The vision helpers in this file read it.
- Runtime tests are meant to use isolated directories. Do not point them at your real store.

## llama.cpp router rules

- Loading and unloading the **vision** model through the router is fine. The vision helper functions above read `vision.model`.
- **Never load or unload the agent model** (`WORKBENCH_LIVE_MODEL`). Doing so breaks the agentic flow.
- HTTP 400 "model is already running" or "model is not running" means the model is already in the requested state.
