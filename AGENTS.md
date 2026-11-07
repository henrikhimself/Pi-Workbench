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

## Development rules

- Compression startup is project-opt-in; existing on/off commands persist project intent. Missing marker means off. Do not prepare Headroom roots/config/runtime for opted-out features.
- Memory startup checks existing fresh project-store opt-in before managed-root preparation. Preserve symlink/ownership guards for actual activation.
- Keep compression fail-open. Proxy or request failure must leave original Pi context usable.
- After compression failure, mark proxy offline or restart managed proxy only when health check also fails. Healthy proxy requests retry on later turns.
- Run `npm test` and `npm run typecheck` after source or test changes. Do not run live E2E unless requested.
- Keep Headroom settings in `~/.pi/pi-workbench/headroom.json`.
- Keep managed venv, lock, Memory, and configuration under `~/.pi/pi-workbench/`. Never inspect, migrate, modify, or fall back to legacy `~/.pi/headroom-*` paths.
- Do not stop external proxy. Shared managed startup stays under extension-owned lock and rechecks health after lock acquisition.
- Memory uses managed Python plus `OnnxLocalEmbedder` CPU only. No PyTorch, MPS, CUDA, cloud, Ollama, or alternate embedding fallback.
- Preserve Pi/OpenAI bridge semantics for text, tool calls/results, thinking, images, and count-changing compression output.
- Study Mode stays opt-in and branch-scoped guidance. It favors questions, evidence, explanations, and avoiding changes, but is not a tool or command sandbox.
- Explicit user requests may proceed while Study Mode is enabled. Recommend `/wb:study-mode off` or confirm intent before implementation work; do not claim actions are blocked.
- Study Mode must not create learner profiles, assessments, or stored learner data.
- Playwright startup is independently workspace-opt-in; absent intent/status must not prepare roots, install packages, register MCP, or launch a browser.
- Playwright pins are `@playwright/mcp` 0.0.84 and `playwright`/`playwright-core` 1.65.0-alpha-2026-10-30. Provision immutable slots under `~/.pi/pi-workbench/playwright/`; never install OS dependencies, download Node/npm, change host security, or retry unsandboxed.
- Managed Playwright uses isolated headless Chromium with sandbox required, vision enabled, idle timeout 0, WebMCP disabled, and unknown/unsafe tools hidden. Preserve the direct/nested tool guard and canonical managed output filenames; workspace uploads retain upstream guardrails.
- Each Pi session owns its browser and transient HOME/cache/tmp. Chromium uses detached groups: MCP exit alone is not quiescence. Verify birth/ancestry/private-scope witnesses, protect the Pi process/group, and retain evidence when ownership is uncertain.
- Playwright off requires confirmation before stopping the invoking session. Same-workspace active peers prevent deletion; retain intent/data, never stop peers, and never schedule deferred deletion. Shared runtime/browser/npm assets and other workspaces/features remain untouched.
- Retain browser artifacts/diagnostics until confirmed workspace off; no automatic artifact/runtime GC, quotas, TTL, persistent profiles, or automatic storage snapshots. Never log credentials/raw browsing content in Workbench lifecycle diagnostics.
- Default tests may execute only byte-attested Node Playwright fixtures, never real npm/Playwright/Chromium. Current-host real-browser acceptance and live Pi/model acceptance are separate gates; flags are not approval. The Playwright live fixture additionally requires environment-supplied selected-provider credentials and a successful current-host runtime report; no normal auth-store fallback, model load/unload, router control, or paid/default provider fallback.
