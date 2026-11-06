# Implementation evidence

## Authorization and limits

Assistant owns baseline implementation/testing under approved TODO.md. User owns host/live acceptance for the subsequent project-opt-in change; assistant runs required offline development checks. No staging, commits, publication, production-store changes or real managed-installation changes performed. Tests use owned disposable roots and synthetic facts/code. ARM64 execution and real-user/production-size canaries remain external acceptance.

## Available passing evidence

- **274 offline tests, zero failures/skips** after project-opt-in changes (`/tmp/workbench-project-optin-final.log`). Earlier 256-test baseline passed three consecutive isolated runs (`/tmp/workbench-handoff-offline-{1,2,3}.log`).
- `npm run typecheck` and `git diff --check` pass.
- **Sixteen** deliberate defects in disposable source copies fail intended assertions: artifact digest, backend version, tool names, namespace, health proof, authored-data loss, MCP registration, SDK transport bypass, plaintext context leakage, headless theme fallback, same-process shim publication, log-handle cleanup, native normalized Memory names, Memory startup gating, compression startup gating and project intent persistence. No setup/timeout substitute.
- Default test runner isolates HOME/Pi/XDG and removes credentials; policy failures cannot be swallowed by fail-open code.
- Shipped Python and optional JS harnesses receive syntax validation; runtime client catches bad exit/trailing/truncated stdout.
- Git staged diff remains empty. No owned native test backends remain after cleanup audit. No generated `__pycache__`/`.pyc` under source/tests.

## Requirement-to-evidence map

| Contract | Evidence |
|---|---|
| Fresh managed Headroom; old files untouched; old DB not opt-in | headroom-config, headroom-runtime, memory-config, memory-lifecycle tests |
| Immutable shared runtime, no venv relocation/live pip repair | runtime descriptor/consumer/publication tests; actual runtime-headroom harness |
| CPU ONNX model/package/weight/tokenizer identity | Memory lifecycle/preflight tests; actual 384-dimensional CPU save/search |
| Unknown proxy isolation; healthy failures retry later | proxy-manager/index tests; challenge HMAC and sealed SDK/native request tests |
| Creator/peer/last-consumer and Memory-only lifetimes | real proxy crash/handoff, same-store peers, post-import Memory-only search |
| Logical operations and relationships/full backups | memory-bundle/lifecycle tests; native relationship export/import and retained physical/bundle backups |
| Exact v0.12.1 artifact/CLI/MCP/project contracts | pins/installer/contract tests; actual native installer/index/17-tool MCP |
| Workspace-private cache/HOME/IPC, short-path checks | private namespace tests; native two-workspace and watcher acceptance |
| Automatic staging, quiescence, authored preservation, failed publication | upgrade/fault tests; actual legacy ADR fixture/full file backup hashes/current traces/restoration |
| Manual downgrade pairing and old AMD64-off outcome | native fixture pair; archived f0f549b ARM-only mapping; user ARM64 handoff |
| Guidance, Study, bridge semantics | wiring/index/Study/format tests; actual SDK compression fixture preserves tool calls/results and final messages |

## Earlier AMD64 native runs

```bash
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-code-graph.mjs --keep --old-fixture --debian11
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-headroom.mjs --keep
```

Code Graph verified archive v0.12.1 AMD64 SHA:
`8c3d0341064301e78ecc84cf7348d4e2c6562a0f57448243ea560aaa34de36c1`.
Actual manager initial indexing, 17 tools, workspace domains, peers, graph watcher updates and final daemon drain passed. Actual v0.8.1 ADR fixture upgraded; complete pre-upgrade file hashes matched backup. Native publication failure restored original data. Debian 11/glibc 2.31 CLI/MCP used the same verified artifact with network disabled; Node manager ran in host userland.

Headroom 0.41.0 + cryptography 50.0.2 passed fresh immutable installation, sealed compression/health, public content-route denial, CCR retrieval/TTL, owned crash/peer lifecycle, CPU Memory, native relationship preservation, backup retention, incompatible-Memory independence and Memory-only operation. Actual SDK coding-context compression reduced **4224 → 154 tokens** while preserving tested tool calls/results and final messages.

Legacy observations: v0.8.1 artifact CLI says 0.8.1 but MCP metadata reports 0.10.0. Its trace ingestion is accepted/not-implemented, not persisted observations. These quirks are recorded only for fixtures; production v0.12.1 checks stay strict. Current v0.12.1 trace persistence is verified separately.

## Important fixes found by tests

- Host-dependent fake install/architecture fixtures and prior x64 failures removed without downloads/skips.
- Actual-child leases protect asynchronous MCP shutdown and store replacement.
- Interrupted store/selection publication retains intent; apparently valid pointers cannot hide uncertain recovery.
- Overlong native socket layouts fixed with short hashed IPC parents; canonical overlong roots fail closed.
- Native schema/compact graph JSON and rootless Docker mount UID handling reflected in acceptance fixtures.
- Static disclosed ownership nonce replaced by challenge proof and authenticated compression transport.
- Actual SDK helper E2E exposed `compressRaw`-only hook mismatch; version-pinned SDK transport now seals actual `compress()` path and disables unsealed/provider fetch.
- Guidance follows actually active compatible direct MCP tools, not pending registration intent.

## Earlier isolated live Pi acceptance (before project-opt-in follow-up)

```bash
WORKBENCH_LIVE_TESTS=1 node test/live-pi.mjs --keep
```

Fresh passing fixture: `/tmp/wl-w7rCaL`; sanitized report `/tmp/workbench-live-pi-final.json`, preparation log `/tmp/workbench-live-pi-final.log`, detailed fixture `worker.log`. Retained files are evidence, not prerequisites; checked-in harness recreates setup.

- Three actual SDK sessions across two workspaces plus separate real RPC and interactive PTY processes used only private HOME/Pi/config/store roots.
- Authenticated read-only checks required exact `llama.cpp/Ornith-1.5-35B-A3B-q5-mtp0` already loaded immediately before inference. Actual SDK and RPC model turns invoked native direct Memory search and returned the saved synthetic sentinel. No paid/default inference or router/model control requests.
- Actual turn system sections contained Memory guidance using Pi-normalized tool names. Direct tools were inspected, not inferred from registration status. RPC with `--no-extensions` explicitly loaded `builtin:mcp`.
- Pi context hook saved **4,070 tokens (95%)** on explicit synthetic historical tool-output input before the real model turn; fixture history is not model-generated evidence. Native SDK bridge/CCR contracts remain separately covered above.
- Same-workspace Memory peers shared sentinel; different workspace did not. Graph tool removal and RPC Memory tool removal preserved busy peer data; native peer tools still worked after separate CLI exit.
- Compression off and creator disposal preserved Memory/proxy peers. Last real Pi consumers stopped the owned proxy. Interactive PTY health and Study Mode on/off commands exited cleanly without inference; actual SDK/RPC provide model-turn evidence.
- First Pi startup automatically staged controlled old-pin metadata on disposable current-format graph data, retained a backup, deferred a contending peer, then one normal later activation succeeded. This is a startup-wiring fixture, **not** substitute evidence for real v0.8.1 migration, which passed separately in the native harness.
- Headless-theme absence, native tool-name normalization, identical-clock shim publication and callback-failure log cleanup received fixes plus focused regressions/negative controls. `session.systemPrompt` is the base getter; actual turn system sections, not that getter, verified injected guidance.

Baseline mutation report: `/tmp/workbench-handoff-negative.json`, 13 caught defects; retained mutation copies/logs `/tmp/wb-test-quality-fu3S8R`. Typecheck/whitespace checks passed after final source/test changes. Exact credential scan of diff, new files and retained live logs/config was clean; Git index remained empty and no owned live fixture processes remained.

## Project-opt-in follow-up

User approved persistent compression on/off per project and owns acceptance testing. Implementation moves Memory opt-in ahead of root preparation, gates compression restore on explicit canonical-workspace intent, makes config creation lazy, and fences late startup/context work after off. Off preserves active peers/Memory; failed on retains intent and unsaved off reports its persistence failure. Symlink/ownership guards remain unchanged.

Added 18 focused regressions covering absent/symlinked roots, independent Memory restoration, persisted on/off/restart/other-workspace behavior, peer preservation, failed activation/opt-out, corrupt/foreign/unsafe preferences, cancellation and pending startup/context races. Current suite: 274 pass, zero failures/skips; typecheck and whitespace pass. All 16 mutation controls caught intended assertions (`/tmp/workbench-project-optin-negative.json`; retained logs `/tmp/wb-test-quality-hn1g9S`).

No new native/live inference, real host startup or symlinked production-store tests were performed. Earlier native/live evidence above must not be presented as acceptance of the changed startup behavior. The live harness now seeds explicit intent in disposable projects. User procedure: TEST-PROJECT-OPT-IN.md.

## Remaining external acceptance

Native Linux ARM64 acceptance procedure: TEST-ARM64.md. No bare-macOS ELF, ARM64 execution, unsupported-platform, production-size, or real-user-canary claim is made here.
