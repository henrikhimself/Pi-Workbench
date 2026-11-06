# Unreleased: managed runtime clean break and Code Graph v0.12.1

## Upgrade contract

Choosing this extension upgrade authorizes its pinned backend upgrades. Eligible setup/upgrade work is automatic, staged and validated, with no approval dialog, `--yes` requirement, or dedicated upgrade command. This is **not** permission to terminate peers, rewrite unknown stores, silently choose another endpoint, or fall back to an older backend.

Active peers, unverifiable/insufficient space, incompatible identities, and validation failures defer the affected feature. Original Pi context stays usable. Correct the condition, close peers normally where appropriate, and retry normal activation. There is no forced shutdown or unbounded restart/upgrade loop.

This release does not opt compression, Memory or Code Graph in merely to upgrade them. Compression now requires explicit per-project startup opt-in: `/wb:headroom-proxy on` persists intent; `off` removes it and disables the requesting session. Existing projects without that marker now start compression off. Global tuning or a running proxy is not opt-in. Already-active peers and Memory remain independent.

Memory startup checks project opt-in before preparing its managed root. When both Headroom features are off, startup creates no Headroom roots/configuration and emits no disabled-feature root/setup warnings. Symlink safety is unchanged: explicit activation or opted-in restore can still reject unsafe paths. Compression intent is saved before activation, retained through backend failure, and validated under managed-path/identity guards. Unknown state is not rewritten. User-owned follow-up acceptance: TEST-PROJECT-OPT-IN.md.

## Headroom: intentional first-release clean break

- Fresh configuration format: `{"schemaVersion":1,"port":8787}` at `~/.pi/pi-workbench/headroom.json`.
- Existing incompatible configuration is rejected without rewriting it. Supply a fresh file manually; reload/restart Pi.
- New shared runtime/config/cache/proxy/Memory namespace: `~/.pi/pi-workbench/headroom/v1/`.
- Old installation/store files are untouched. No old-install discovery, adoption, conversion, migration, automatic import, cleanup, or old-setting carry-forward.
- A pre-existing database does not opt Memory in. Use `/wb:headroom-memory on` explicitly for the fresh workspace store.
- External `url` configuration and unknown localhost proxy adoption are removed.

The shared Python installation uses permanent immutable venv slots, never live `pip --upgrade` repair or venv relocation. Both roles use `headroom-ai[proxy]==0.41.0`; resolved distributions are installed with SHA-256 requirements. `cryptography==50.0.2` supplies authenticated private transport. Memory remains CPU-only `OnnxLocalEmbedder`, 384-dimensional `Qdrant/all-MiniLM-L6-v2-onnx`; model revision and weight/tokenizer identities are checked.

Managed proxy reuse requires private process-birth/executable/role identities, leases, and fresh HMAC health proofs. Compression requests and responses are AES-256-GCM sealed so a port-replacement race cannot expose plaintext context or inject an unauthenticated compressed result. Content/stat/retrieval routes require the same private transport; `/health` remains an availability endpoint without disclosing the secret.

New-layout future releases must provide reviewed runtime/store contracts. Unknown future package/data pairs are deferred. Controlled new-layout recovery fixtures were tested; this release does not invent arbitrary future schema migration or cross-refactor restore support.

## Code Graph

- Fresh workspace startup now shows `○ Code Graph off`, matching the Headroom off labels.
- `/wb:code-graph on` announces preparation before waiting and exposes existing installer/indexer progress in the footer instead of suppressing it. Success/failure restores the appropriate steady label. Symlink/path safety is unchanged.

- Exact reviewed portable **v0.12.1**, Linux ARM64 and AMD64. No newest-arbitrary-version selection.
- Archive/member caps: **64,000,000 / 400,000,000 bytes**; checksums and strict executable-only extraction retained. Bundled installers are never executed.
- Explicit JSON CLI flags, bounded pagination, unique canonical workspace matching, protocol `2024-11-05`, and exact 17-tool name contract.
- UI disabled; workspace-private cache, HOME/XDG, and daemon domains.
- Short IPC parents: `~/.pi/pi-workbench/g/<cache-path-hash>/`. Canonical paths exceeding the Unix socket limit are refused, without global rendezvous fallback.
- v0.8.1 upgrades use quiescent full physical copies, separate staging domains, validated reindex, authored-data preservation, retained backups, and publication recovery.
- Newer/incomparable data identities are not automatically downgraded or reinterpreted.

### Legacy facts worth distinguishing

The digest-verified v0.8.1 artifact reports CLI version `0.8.1` but stale MCP server metadata `0.10.0`. This discrepancy is recorded only in legacy fixture evidence; production v0.12.1 checks remain strict.

v0.8.1 `ingest_traces` returned `accepted` with **“Runtime edge creation from traces not yet implemented”**. No persisted old trace rows are invented. Real old ADR preservation was tested; real v0.12.1 trace persistence and controlled authored-state recovery were tested separately.

## Retention and diagnostics

No backup expiration, automatic pruning, fixed aggregate quota, overwrite, or cleanup command. Runtime selection snapshots, full store/bundle backups, installed versions, and failed staging are retained until explicit manual cleanup. Logical Memory export/import/merge preserves native entities/relationships and regenerates derived indexes through CPU ONNX.

Relevant paths beneath `~/.pi/pi-workbench/`:

| State | Location |
|---|---|
| Headroom selection/candidates/slots | `headroom/v1/selected.json`, `candidate-<version>.json`, `runtimes/<version>/<build-slot>/` |
| Headroom selection recovery intent | `headroom/v1/selection.pending.json` |
| Proxy ownership/log | `headroom/v1/proxies/<port>/owner.json`, `proxy.log` |
| Proxy CCR | `headroom/v1/proxy-state/ccr_store.db` and SQLite sidecars |
| Default Memory | `headroom/v1/memory/projects/<workspace-id>/` |
| Memory coordination/recovery | Its fresh root's `coordination/<workspace-id>.lock` / `.pending.json` |
| Code Graph stores | `codebase-memory-mcp/projects/<workspace-id>/` |
| Code Graph physical backups | `codebase-memory-mcp/runtime/backups/` |
| Code Graph activation/recovery | `codebase-memory-mcp/runtime/coordination/` |
| Code Graph installer lock | `codebase-memory-mcp/coordination/install.lock` |
| Code Graph private IPC | `g/<cache-path-hash>/` |

Custom Memory bases use `workbench-memory-v1`; coordination and backups remain in that fresh namespace. Bundle backups live beside the configured bundle, including preservation of unrelated siblings.

### Safe recovery procedure

1. Stop using the affected feature. Keep unrelated healthy features running.
2. Read the diagnostic and preserve its marker, logs, live store, candidate/staging, and backup paths. Do not remove a `.pending.json` to make an error disappear.
3. Close relevant Pi/MCP consumers normally. Confirm actual backend children/daemons have drained, not merely that a registration callback returned. Never kill unknown/external processes.
4. Establish which complete backend/config/store identity is valid. Caught restoration succeeds automatically; interrupted or failed restoration requires operator review of recorded identities.
5. Preserve every candidate/original copy before a manual restore. Restore only a known compatible pair while quiescent, then retry normal activation.
6. Remove stale locks only after proving owner/process quiescence. Locks are never stolen automatically by age or PID-only guesses.

Manual cleanup has the same quiescence requirement. Keep backups needed for a downgrade or unresolved failure. Never inspect, migrate, or fall back to legacy `~/.pi/headroom-*` locations.

## Manual extension downgrade

There is no general rollback engine or dual-version backend mode.

### Code Graph

- Close all affected consumers and verify daemon drain.
- Keep post-upgrade data and current binaries in protected holding locations; do not overwrite them with an old snapshot.
- Restore the matching pre-upgrade workspace backup and the exact executable/install metadata expected by the older extension. Older selectors may prefer a retained higher installed version: move higher slots out of their discovery directory into protected holding storage rather than deleting them.
- The old Workbench ARM64 manifest used its reviewed v0.8.1 asset identity. A portable fixture backend is not an excuse to fabricate an older extension's install record.
- Older Workbench supports Code Graph only on Linux ARM64. On AMD64, downgrade leaves Code Graph off and preserves data. Do not substitute an ARM64 executable or claim old AMD64 extension support.
- Re-enable only after backend/data/config pairing is verified. [TEST-ARM64.md](TEST-ARM64.md) includes user-owned native acceptance.

### Headroom

Within the new layout, restore only a reviewed package/Python/dependency/embedding/config/store pair, including SQLite sidecars and identity markers. Selecting an old runtime alone does not authorize opening newer stores; automatic downgrade is refused.

Across this initial refactor, new-layout data is **not** adopted by the older extension. Old files were left untouched. No automatic transfer or old-layout restore is promised, and no compatibility layer is added.

## Evidence and limits

Available AMD64 gates exercised actual managed installer/manager paths, two workspace domains, same-workspace peers, watcher graph updates, final daemon drain, real v0.8.1 ADR fixtures, full backup hashes, publication-failure restoration, manual fixture backend/data pairing, and older extension ARM-only platform mapping. The portable v0.12.1 artifact's CLI/MCP passed a network-disabled Debian 11/glibc 2.31 container gate; the Node manager gate ran on the host userland.

Fresh Headroom runtime acceptance exercised sealed compression, public content-route denial, owned SQLite CCR retrieval/TTL, creator exit/crash recovery, CPU Memory save/search, native relationship bundle preservation, backups, model/store-validation failure independence, and Memory-only operation.

Offline tests use isolated HOME/Pi/XDG roots and enforced network/installer/service policy. Sixteen deliberate source defects fail the intended assertions in disposable copies. Syntax checks cover shipped Python and opt-in JS adapters; runtime clients reject nonzero exits, protocol garbage, and truncated frames.

Before the project-opt-in follow-up, isolated AMD64 live Pi acceptance passed actual SDK peers, separate RPC and interactive PTY processes, exact already-loaded local-model Memory tool calls, direct-tool removal, normalized prompt guidance, Study Mode commands and last-consumer shutdown. Pi's context hook saved 4,070 tokens on explicitly synthetic historical tool-output input. Fresh startup automatically upgraded a controlled old-pin fixture with retained backup and safely deferred/retried a contending peer. Real v0.8.1 data migration is covered separately by the native harness, not inferred from that controlled fixture.

Live gates found and fixed absent headless UI themes, normalized Memory tool names, same-process curl-shim temporary-name collisions and log-handle cleanup on callback failure. With `--no-extensions`, add `-e builtin:mcp` explicitly; startup progress alone does not prove direct tools are connected.

The opt-in follow-up has 274 passing offline regressions and 16 caught mutation controls; its host/live acceptance remains user-owned and has not been rerun by the assistant. The live harness now explicitly seeds compression opt-in in its disposable workspaces.

These are synthetic, disposable tests—not native ARM64 execution, production-size upgrade evidence, or a real-user canary. ARM64 final acceptance belongs to the user. No shared router/model controls, paid/default inference or real user stores were used.
