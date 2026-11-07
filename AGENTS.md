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
pi --mode rpc --no-session --no-extensions -e builtin:mcp -e ./src/index.ts \
  --model <provider>/<model>

# Explicit isolated runtime acceptance; never current user proxy/stores
WORKBENCH_RUNTIME_TESTS=1 node test/e2e-check.mjs
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-code-graph.mjs --old-fixture --debian11

# Playwright runtime only after approved host-specific authorization; no Pi/model
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-playwright.mjs --keep

# Explicit live Pi gate: already-loaded local model named in WORKBENCH_LIVE_MODEL (plus LLAMA_BASE_URL/LLAMA_API_KEY)
WORKBENCH_LIVE_MODEL=<model-id> WORKBENCH_LIVE_TESTS=1 node test/live-pi.mjs --keep

# Separately approved Playwright live gate; requires successful retained runtime report
WORKBENCH_LIVE_MODEL=<model-id> WORKBENCH_LIVE_TESTS=1 WORKBENCH_PLAYWRIGHT_LIVE_TESTS=1 \
  WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE=/retained/disposable/acceptance.json \
  node test/live-playwright.mjs --keep

# Deliberate test defects in disposable source copies
node test/test-quality.mjs

# Check HTTP availability only (not managed ownership)
curl -fsS http://127.0.0.1:8787/health
```
