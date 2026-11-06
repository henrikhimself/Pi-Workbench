# Development

```bash
npm install
npm test                         # isolated HOME/Pi/XDG; enforced offline policy
npm run typecheck
git diff --check
node test/test-quality.mjs --keep # thirteen deliberate defects in disposable copies

# Explicit opt-in; installs packages/assets and uses only synthetic/private data:
docker pull debian:trixie-slim
docker pull debian:bullseye-slim  # AMD64 legacy-userland ABI gate
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-code-graph.mjs --keep --old-fixture --debian11
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-headroom.mjs --keep
```

ARM64 omits `--debian11` (that gate is AMD64-only); follow [TEST-ARM64.md](TEST-ARM64.md). Native harnesses do not call a chat model or control a shared router.

Explicit live Pi acceptance (downloads fresh managed assets; synthetic SDK/RPC/TUI sessions only):

```bash
# Exact model must already be loaded; credential stays in process environment.
# Alternatively reads only llama.cpp credential from existing user auth store.
WORKBENCH_LIVE_TESTS=1 node test/live-pi.mjs --keep
```

This harness permits only `http://192.168.2.48:8000` and `llama.cpp/Ornith-1.5-35B-A3B-q5-mtp0`; no model load/unload, router control, or paid/default fallback. It creates private HOME/Pi roots, waits for actual direct tools, tests real local-model calls, managed compression, peers and an interactive PTY. Optional `LLAMA_BASE_URL`/`LLAMA_API_KEY` bypass reading the existing auth store; neither credential nor real user stores are copied. Failed fixtures are retained. Successful roots are removed unless `--keep`.

With `--no-extensions`, explicitly include `-e builtin:mcp` alongside Workbench; otherwise Pi's MCP integration is disabled. See [IMPLEMENTATION-REPORT.md](IMPLEMENTATION-REPORT.md) for verified scope and remaining external gates.
