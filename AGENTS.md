# AGENTS.md

## Common commands

```bash
# Install development dependencies
npm install

# Run unit and smoke tests
npm test

# Strict TypeScript validation
npm run typecheck

# Standard checks
npm test && npm run typecheck && git diff --check

# Run extension once without installation
pi -e ./src/index.ts

# Start headless Pi with Workbench and required built-in MCP integration
pi --mode rpc --no-session --no-extensions -e builtin:mcp -e ./src/index.ts --model <provider>/<model>

# Explicit isolated runtime acceptance; never current user proxy/stores
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-headroom.mjs
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-code-graph.mjs

# Playwright runtime; no Pi/model
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-playwright.mjs --keep

# Load or unload the vision model on the llama.cpp router (vision.model in ~/.pi/pi-workbench/playwright.json).
# NEVER load or unload the agent model (WORKBENCH_LIVE_MODEL): unloading it breaks the agentic flow. 
# HTTP 400 "model is already running" / "model is not running" means the model is already in the requested state.
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

# Explicit live Pi gate: already-loaded local model named in WORKBENCH_LIVE_MODEL (plus LLAMA_BASE_URL/LLAMA_API_KEY)
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
