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

# Start headless Pi with only this extension
pi --mode rpc --no-session --no-extensions -e ./src/index.ts \
  --model <provider>/<model>

# Run live compression E2E only with a healthy proxy
node test/e2e-check.mjs

# Check default proxy manually
curl -fsS http://127.0.0.1:8787/health
```

## Development rules

- Keep compression fail-open. Proxy or request failure must leave original Pi context usable.
- After compression failure, mark proxy offline or restart managed proxy only when health check also fails. Healthy proxy requests retry on later turns.
- Run `npm test` and `npm run typecheck` after source or test changes. Do not run live E2E unless requested.
- Keep Headroom settings in `~/.pi/pi-workbench/headroom.json`.
- Keep managed venv, lock, Memory, and configuration under `~/.pi/pi-workbench/`. Never inspect, migrate, modify, or fall back to legacy `~/.pi/headroom-*` paths.
- Do not stop external proxy. Shared managed startup stays under extension-owned lock and rechecks health after lock acquisition.
- Memory uses managed Python plus `OnnxLocalEmbedder` CPU only. No PyTorch, MPS, CUDA, cloud, Ollama, or alternate embedding fallback.
- Preserve Pi/OpenAI bridge semantics for text, tool calls/results, thinking, images, and count-changing compression output.
- Learning Mode stays opt-in, branch-scoped, and must not obstruct direct implementation or urgent remediation. Never store learner profiles or assessments.
- Study Mode stays tutor-only. Hard-block tools outside configured inspection/read-only MCP/bounded investigation access; block `memory_save` even when configured Memory search is available.
- Study Mode must not generate code, patches, commands, write files, run tests, install packages, invoke generic shell/browser/Git, or store learner data.
- Bounded Study decompilation accepts only approved local DLL paths and fixed `ilspycmd --disable-updatecheck` arguments. Bounded fetch accepts public HTTPS only; reject credentials, local/private/reserved targets, unsafe redirects, oversized/non-text responses, and writes.
