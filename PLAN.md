# Managed services: implemented architecture and acceptance record

Implementation authorized. Baseline testing owned by assistant; project-opt-in follow-up host/live acceptance is user-owned (TEST-PROJECT-OPT-IN.md). `TODO.md` records dependency-ordered execution. No staging, commits, publication, production-data changes, or real managed-installation changes are authorized. Runtime tests use disposable owned homes/stores/services only.

This document supersedes the pre-implementation proposals with implemented contracts. Product decisions remain those approved in `TODO.md`; native ARM64 and real-user canaries are external acceptance, not implied by AMD64 tests.

## 1. Scope and approved invariants

1. Managed-only Headroom; no external URL mode or unknown localhost adoption.
2. One immutable Headroom installation for proxy and Memory, with separate readiness/process lifetimes.
3. Fresh Headroom baseline: configuration, runtime and stores. Old installation/store files remain untouched. No discovery, adoption, migration, conversion, automatic import, cleanup, or carry-forward of old settings.
4. Code Graph target v0.12.1 portable Linux ARM64/AMD64, preserving existing workspace-store isolation and authored data.
5. Extension upgrade itself authorizes eligible pinned backend upgrades. No approval dialog, `--yes`, or dedicated upgrade command. Explicit destructive data operations retain their own confirmations.
6. Unsafe/unverifiable space, active consumers, incompatible identity, or failed validation defer only the affected feature. Preserve peers/data; retry later normal activation. No forced shutdown, retry loop, arbitrary higher-version selection, or old-backend fallback.
7. Keep staging/pre-upgrade/full physical backups and manual downgrade procedures. No general rollback engine, dual-version backend mode, automatic retention pruning/quota, overwrite, or cleanup command.
8. Keep all managed artifacts beneath `~/.pi/pi-workbench/`. Never inspect, migrate, modify, or fall back to legacy `~/.pi/headroom-*` locations. Explicit custom Memory bases use fresh namespaced storage, never old-store adoption.
9. Preserve fail-open compression, healthy-request retries, Pi/OpenAI text/tool/thinking/image/count-change semantics, logical Memory operations, and component independence.
10. Memory: `OnnxLocalEmbedder`, CPU only. No PyTorch, MPS/CUDA, cloud/Ollama/alternate embedding fallback.
11. Study Mode stays optional branch-scoped guidance, not a tool/command sandbox. Explicit requests may proceed. No learner profiles, assessments, or stored learner data.
12. Only isolated synthetic live inference is authorized, using `llama.cpp/Ornith-1.5-35B-A3B-q5-mtp0`. No paid/default provider fallback, shared router/model load/unload/reconfiguration, or credential disclosure/store rewriting.
13. ARM64 execution is excluded here. Deliver `TEST-ARM64.md` for user-owned native Linux ARM64 on Apple Silicon; never run ELF directly on macOS or claim ARM64 verified.

## 2. Reviewed release identities

Headroom SDK/Python: **0.41.0**; tagged source `76133cff59b71284399bf760c5578dc373c97231`. The managed transport additionally pins **cryptography 50.0.2**. Use `[proxy]`, not `[memory]`, `[ml]`, or `[all]` extras that introduce PyTorch. Installation freezes the resolved distribution hashes and verifies the installed inventory and CPU imports.

Code Graph: **v0.12.1**, upstream source `a7158ac2f48ca646b4527341b76f930f2aeff87e`.

| Platform | Archive bytes | Executable bytes | Archive SHA-256 |
|---|---:|---:|---|
| linux-arm64 portable | 48,466,763 | 331,161,408 | `ed0f1f548cd79b121c401c2e9f7841c189a001af26d3768368088c24f6a53533` |
| linux-amd64 portable | 48,920,994 | 330,641,600 | `8c3d0341064301e78ecc84cf7348d4e2c6562a0f57448243ea560aaa34de36c1` |

```text
https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.12.1/codebase-memory-mcp-linux-arm64-portable.tar.gz
https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.12.1/codebase-memory-mcp-linux-amd64-portable.tar.gz
```

Archives contain executable, LICENSE, install.sh and THIRD_PARTY_NOTICES.md. Extract only the approved executable through GNU tar; never invoke bundled/global installers. Caps are 64,000,000 bytes downloaded and 400,000,000 bytes extracted. Reuse binds extracted-byte SHA-256 to the verified archive record. Current extension selects its exact pin, not the newest arbitrary installed version.

MCP protocol: `2024-11-05`. Reviewed 17-tool name set:

```text
index_repository, search_graph, query_graph, trace_path, get_code_snippet,
get_file_outline, get_graph_schema, compare_graphs, get_architecture,
search_code, list_projects, delete_project, index_status,
check_index_coverage, detect_changes, manage_adr, ingest_traces
```

Unrestricted surface required; do not substitute restricted profiles or obsolete `get_code_context`/`get_impact` guidance. Validate backend/protocol versions, exact names, duplicates, pagination bounds, and clean stdio.

## 3. Managed layout and ownership primitives

`src/paths.ts` is the canonical resolver.

```text
~/.pi/pi-workbench/
  headroom.json                         # schemaVersion: 1
  headroom/v1/
    selected.json                      # immutable runtime descriptor
    selection.pending.json             # uncertain/interrupted publication only
    candidate-<version>.json
    selected.backup-<id>.json
    runtimes/<version>/<build-slot>/    # permanent venv location
    config/, home/, cache/
    proxy-state/                       # CCR SQLite and sidecars
    proxies/<port>/owner.json, proxy.log
    coordination/, consumers/
    memory/projects/<workspace-id>/    # explicit fresh opt-in
  codebase-memory-mcp/
    bin/<version>/<platform>/
    downloads/, coordination/install.lock
    projects/<workspace-id>/
    runtime/coordination/, consumers/, homes/, backups/
  g/<cache-path-hash>/                  # short, workspace-private native IPC parents
```

Custom Memory bases add `workbench-memory-v1` before project stores/coordination. Defaults and custom roots never interpret an old physical database as opt-in. Logical bundle paths remain project-relative and containment-checked.

`src/managed-lifecycle.ts` provides small component-neutral primitives, not a migration engine:

- Private directories/files, owner checks, symlink/unsafe writable-ancestor rejection, lexical containment.
- Atomic complete JSON publication with file/directory sync.
- Process-birth identities, host binding, private consumer leases, bounded locks.
- No age/PID-only mkdir lock stealing; stale/uncertain ownership needs diagnosed manual recovery.
- Full regular-file tree size, finite disk preflight, non-overlapping same-filesystem promotion, retained original backup, caught restoration.
- Linux CBM consumer metadata guards for pre-refactor clients lacking new leases; no external termination.

`src/managed-mcp.mjs` validates install/marker/runtime identities and acquires store/runtime leases tied to the actual backend child. Asynchronous unregister intent release cannot make a still-running child invisible. EOF/cancellation has bounded owned-child cleanup.

## 4. Headroom contracts

### Project startup choices

Compression defaults off without a validated per-workspace marker in `headroom/v1/compression/projects/<workspace-id>/opt-in.json`. Existing on/off commands persist project intent; on retains intent through activation failure, off preserves Memory and already-active peers. Passive missing-marker checks create no managed directories. Memory checks existing fresh-store opt-in before root/config preparation. Global config creation is deferred until opted-in use. Preference publication/removal is locked and durable; unsafe/unknown existing markers fail closed unchanged. Startup and context callbacks are fenced against later commands/session transitions.

### Fresh configuration

`schemaVersion:1`; optional managed port, compression, fresh Memory base/namespace/bundle settings. Missing configuration is created; incompatible existing files/URL fields are rejected without value conversion or rewriting. No legacy probing or setting reuse.

### Immutable installation and selection

`src/headroom-runtime.ts` constructs permanent inactive venv slots using `--copies`, resolves dry-run package hashes, installs with `--require-hashes`, and validates package/dependency/CPU/transport imports. Proxy and Memory share its descriptor: package/Python identity, permanent paths, installed inventory digest and embedding contract.

No built venv is renamed/copied. No live `pip --upgrade` or repair. Active consumers block selection changes. Ready candidates may be reused on safe retry. Previous selection snapshots remain. Caught publication failures restore the prior selection; uncertain restoration retains `selection.pending.json` and blocks even an apparently valid selected pointer. Automatic runtime downgrade is refused.

Current schema/store guards are for this fresh release and controlled new-layout fixtures. Future releases must supply reviewed compatible adapters/contracts; unknown future store/package pairs stay off. No nonexistent future release pair or pre-refactor transfer is claimed.

### Owned proxy and private transport

`src/proxy-manager.ts`, `src/managed-proxy.py`, `src/owned-transport.ts`, and the version-pinned `src/headroom-client.ts` SDK transport adapter bind records to process birth, executable/role, runtime slot, nonce, and leases. Reuse requires fresh HMAC challenge response rather than publicly replayable secret disclosure. AES-256-GCM seals requests/responses, binding request identity/method/path/status; a port-replacement race gets no plaintext context and cannot inject an unauthenticated compressed result. Other content routes require private transport. Redirects are not followed.

No unknown service is adopted or stopped. No silent port substitution. Creator is not sole owner; peer/watchdog handoff and last proxy-consumer shutdown preserve Memory/runtime peers. Healthy request failures do not trigger unhealthy-service restart behavior. Session shutdown/cancellation fences late startup/status/registration work.

### Fresh Memory and logical operations

`src/headroom-state.ts` and `src/memory-manager.ts` reject unmarked/incompatible stores before backend opening. Explicit new-format marker plus database controls opt-in. Identity includes package/store layout and CPU embedding dimensions/model/revision/weight/tokenizer digests. Preflight warms and checks exact CPU execution; Memory MCP then uses cached model assets offline.

Logical export/import/merge/show preserves namespace scoping, records, relationships and unrelated bundle siblings. Rebuild derived vectors/indexes with managed CPU ONNX. Coordinate actual child leases before direct operations. Full physical and bundle backups remain until manual cleanup. Failed operations do not blindly reconnect MCP; interrupted swaps cannot silently recreate a missing store.

## 5. Code Graph contracts

- Linux `x64` maps to `linux-amd64`; `arm64` retains `linux-arm64`. No Darwin/Windows ELF support.
- CLI arguments are exact arrays, not shell/raw positional JSON. Explicit JSON and bounded canonical `root_path` matching avoid first-project/string-entry/pagination mistakes.
- All CLI/probes/MCP use the same workspace-specific cache, private HOME/XDG, allowed root, and short hashed IPC parent. Separate staging cache gets a separate domain.
- Upstream binds one cache per daemon domain. Same-domain/different-cache is refused; no centralized cross-workspace cache workaround.
- The actual Unix socket suffix requires a short canonical parent. Overlong paths are diagnosed before backend work, never redirected to global `/tmp` rendezvous.
- New activation validates/indexes/handshakes before publishing opt-in and registering direct compatible tools. Status does read-only exact-pin inspection; off/corrupt/upgrading stores are not opened through an incompatible backend.
- Reviewed automatic adapter is v0.8.1 → v0.12.1. Newer/same-version mismatched/unknown pairs are deferred, not automatically downgraded.

Upgrade: lock activation, prove quiescence, preflight candidate/copy/backup capacity, full physical copy, inspect/rebuild/validate only staging, restore/project authored rows, drain staging daemon, record recovery intent, promote, clear intent on verified success. Original remains as a physical backup. Caught failures restore; interrupted/uncertain publication keeps identities and blocks silent fresh activation.

Old actual v0.8.1 preserves ADR tables. Its `ingest_traces` returned accepted/not-implemented; no old persisted trace rows are invented. v0.12.1 has persisted observed call/path tables. Source-row/column projection allows newly created empty target tables while preserving every existing source row. Current-layout trace fixtures exercise full retention/recovery separately.

Manual extension downgrade requires paired executable/install metadata/config/store. Archived Workbench `f0f549bca882cb77b871bbcf116be18786b62047` is ARM64-only; AMD64 stays off. No automatic old-backend fallback or general rollback engine. See RELEASE-NOTES.md.

## 6. Session integration and unchanged guidance

`src/index.ts` starts independent proxy/Memory/graph preparation in the background so cold package/model work cannot obstruct ordinary Pi tools. Generation/cancellation fences suppress late readiness, registrations and restart after shutdown. Scoped registration changes do not leak another workspace's tools. Failure removes inappropriate graph guidance; Study Mode stays branch-scoped and optional.

Direct Memory work unregisters the requesting session around guarded transactions and reconnects only after successful compatible work. Other consumers protect their lifetimes/data. Compression off is not a Memory-off or peer shutdown command.

Format bridge regressions cover text, tool calls/results, thinking, images, changed message counts and unapplied savings. No learner assessment/profile storage is added.

## 7. Available evidence and remaining gates

### Offline and test quality

- `npm test` isolates HOME/Pi/XDG and removes credentials. Enforced entry-point policy rejects external/default-proxy network, DNS, native service/package commands and shell execution; swallowed fail-open errors still fail worker exit.
- Current offline suite is green with zero unexplained skips/failures; typecheck and whitespace checks pass.
- Sixteen disposable-source mutations fail intended assertions: digest, backend version, tool-name set, namespace propagation, health proof, authored-data loss, direct MCP registration, SDK transport bypass, plaintext context leak, absent headless theme, concurrent shim publication, log-handle leak, normalized Memory tool names, Memory startup gating, compression startup gating and persistent compression intent. No working-tree mutation or setup/timeout substitute.
- Syntax checks include shipped Python and opt-in JS adapters. Runtime MCP helper rejects nonzero exit, malformed/truncated protocol stdout.

### Actual AMD64 runtime

`WORKBENCH_RUNTIME_TESTS=1 node test/runtime-code-graph.mjs --keep --old-fixture --debian11` exercises real managed install/index/MCP, two workspaces, same-workspace peers, watcher graph updates, guarded deletion and drain. Actual digest-verified v0.8.1 fixture ADRs upgrade with full backup file hashes; v0.12.1 traces persist; publication-failure restoration preserves originals. Manual fixture backend/data pairing and archived older extension ARM-only/AMD64-off mapping are checked.

The v0.12.1 portable artifact CLI/MCP passed a network-disabled Debian 11/glibc 2.31 container gate. The Node managed-adapter gate ran on current host userland. Record image identities, do not extrapolate to every kernel/CPU/filesystem or production-size database.

`WORKBENCH_RUNTIME_TESTS=1 node test/runtime-headroom.mjs --keep` exercises fresh hashed runtime, sealed compression, public route denial, owned SQLite CCR retrieval/TTL, creator/peer/crash lifetime, CPU Memory save/search, native relationship bundle preservation, physical backups, incompatible Memory/proxy independence, and Memory-only post-import search.

Legacy v0.8.1 CLI identifies 0.8.1 while its MCP metadata reports 0.10.0. Legacy fixture evidence records this quirk; production v0.12.1 checks stay strict.

### Earlier isolated live Pi (before project-opt-in follow-up)

The follow-up live harness explicitly seeds per-project compression intent. New host/live acceptance is user-owned and not yet verified; see TEST-PROJECT-OPT-IN.md.

`WORKBENCH_LIVE_TESTS=1 node test/live-pi.mjs --keep` passed fresh AMD64 setup, three actual SDK sessions, a separate RPC process and an interactive PTY. Exact already-loaded authorized local model completed native Memory tool turns in SDK and RPC. Actual Pi context compression saved 4,070 tokens on explicit synthetic historical tool-output input; fixture history was not model-generated. Turn system sections contained normalized Memory guidance. Peer/workspace isolation, tool removal, busy-data preservation, creator exit, last-consumer shutdown, Study Mode commands and normal retry after startup contention passed. Automatic startup upgrade used controlled old-pin metadata on disposable current-format data; real v0.8.1 artifact/data preservation remains separately evidenced by the native harness.

No shared router/model control, alternate inference provider or real user stores were used. Explicit `-e builtin:mcp` is required when CLI uses `--no-extensions`.

### External/uncompleted acceptance

- Native ARM64 execution: user-owned TEST-ARM64.md procedure, not claimed here.
- Production-size/real-user canary and unsupported-host verification: not implied by disposable AMD64 evidence.
- Future Headroom release-pair migration: reviewed contracts required when a real pair exists.
- Native ARM64 live Pi acceptance must be repeated there; AMD64 SDK/RPC/TUI evidence does not establish ARM64 execution.

## 8. Reproducible sources and operating docs

- Code Graph release: https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1
- Checksums: https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.12.1/checksums.txt
- API metadata: https://api.github.com/repos/DeusData/codebase-memory-mcp/releases/tags/v0.12.1
- Tagged CLI/MCP/configuration/daemon/store source: https://github.com/DeusData/codebase-memory-mcp/tree/v0.12.1
- Legacy trace stub: https://github.com/DeusData/codebase-memory-mcp/blob/v0.8.1/src/mcp/mcp.c
- Headroom metadata: https://pypi.org/pypi/headroom-ai/0.41.0/json
- Headroom source/extras/CPU embedder/CCR: https://github.com/headroomlabs-ai/headroom/tree/v0.41.0
- Cryptography authenticated-encryption API: https://cryptography.io/en/latest/hazmat/primitives/aead/
- Python permanent-venv portability constraints: https://docs.python.org/3/library/venv.html#how-venvs-work

Operational contracts: README.md and RELEASE-NOTES.md. Native ARM64 handoff: TEST-ARM64.md. Checked-in tests are reproducible evidence; old `/tmp` probes are not prerequisites or acceptance claims.
