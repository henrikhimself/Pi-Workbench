# PLAN.md execution checklist

Status: implementation authorized by user. Execute dependency-ordered tasks below; testing owned by assistant. No staging, commits or publication authorized.

Scope: complete the managed Headroom and Code Graph work in `PLAN.md`, validate implementation, then validate the tests themselves. Assistant owns testing. No staging, commits, publication or production-data changes authorized. Installation/service changes are limited to isolated owned test environments.

## Follow-up authority: project startup opt-in

User approved Memory-aware startup and persistent per-project compression on/off. User owns host/live acceptance; assistant runs required offline development checks. Missing compression intent means off, including projects that previously auto-started without explicit intent. TEST-PROJECT-OPT-IN.md records acceptance steps; no follow-up host/live success is claimed.

## Decisions settled before unattended execution

These decisions supersede conflicting proposals in `PLAN.md`; task 1 reconciles that document before coding.

- **Automatic upgrades:** choosing an extension upgrade authorizes its pinned backend upgrade. New-layout Headroom and existing Code Graph data upgrade automatically through staging/validation/backup, with no approval prompt, `--yes` requirement, or dedicated upgrade command. Explain this contract in release notes.
- **Safe deferral:** active peers, insufficient/unverifiable disk space, incompatible data, or failed validation defer the affected feature. Preserve data/peers, report the blocker, and retry at a later safe activation. No forced peer termination, unsafe live-store opening, old-backend fallback, or restart/retry loop.
- **Initial Headroom clean break remains:** fresh shared runtime, fresh configuration and fresh stores. Reject incompatible existing `headroom.json` without rewriting it. No old runtime/config/store adoption or migration. Old files remain untouched; old databases never opt Memory in. Initial configuration/opt-in may require user action; that is not an upgrade-consent prompt.
- **Pins:** Headroom SDK/Python 0.41.0; Code Graph v0.12.1. Use reviewed portable Linux ARM64/AMD64 assets and hashes. Archive/member caps: 64,000,000 / 400,000,000 bytes. Keep all integrity checks.
- **Isolation:** protected per-workspace Code Graph runtime/cache domains; no shared global cache. Code Graph UI remains disabled. Unknown Headroom port occupants are never contacted with Pi context, adopted, terminated, or bypassed by silent endpoint substitution.
- **Technical discretion:** choose helper boundaries, explicit new schema/layout identifiers, protected paths, lease/lock records and tested bounded timeouts within approved invariants. Retain new-format port/compression/Memory options and default managed port 8787. No extra user-facing features/commands.
- **Lifetime:** compression off disables the requesting session and opts that project out of future startup; already-active peers and Memory remain unchanged. Creator exit cannot terminate a peer's managed service. Last-consumer release permits owned-service shutdown. Failed components do not disable unrelated healthy features.
- **Backups:** retain until explicit manual cleanup; no expiration, pruning, overwrite, fixed aggregate quota, or cleanup command. Estimate candidate/staging/backup space with a tested margin; refuse an upgrade if safe capacity cannot be established. Document quiescent manual cleanup.
- **Testing authority for future execution:** verified downloads, disposable containers, temporary venv/model installs, isolated owned services, and synthetic live Pi/compression tests are permitted. Never use real user stores or arbitrary running Headroom/Code Graph services.
- **Local inference only:** use `llama.cpp/Ornith-1.5-35B-A3B-q5-mtp0` through the configured router, currently `http://192.168.2.48:8000`. Never use paid/cloud-provider fallback. User keeps the model ready; tests must not load/unload models, restart/reconfigure the router, or change global defaults. Use bounded requests/timeouts and synthetic data only.
- **Credential handling:** user supplied router credential separately; intentionally absent here. Pass it securely to isolated test processes, for example through `LLAMA_API_KEY`; do not log it, commit it, save it in project fixtures, or rewrite existing credential stores. Authenticated read-only readiness and actual SDK/RPC inference verified the exact already-loaded ID; no router/model control calls were made.
- **ARM64:** no ARM64 execution requirement in this environment. Deliver `TEST-ARM64.md` for user-owned final acceptance on Apple Silicon using Linux ARM64 virtualization/containerization, not bare macOS execution of ELF. Preserve ARM64 support and tests. Do not claim ARM64 execution verified here or silently add Darwin Code Graph support.

## Execution rules

1. Follow `AGENTS.md`; never inspect or modify legacy `~/.pi/headroom-*` locations.
2. Implementation authorization received. Exactly one task in progress; complete only when its required checks pass. Record blockers without marking failed or partial work complete.
3. Run focused tests plus `npm test`, `npm run typecheck`, and `git diff --check` after source/test changes. Establish a fresh baseline; historical seven Linux-x64 wiring failures are not an acceptable final result.
4. Unit/smoke tests stay offline and hermetic: no real package/model/binary downloads or services. Real runtime tests are explicit opt-in and use private disposable roots, homes and namespaces.
5. Keep compression fail-open, healthy-request retries, format bridge semantics, logical Memory operations, CPU-only ONNX and Study Mode unchanged.
6. Use small shared helpers and component adapters, not a generic migration/rollback engine. Never rename/copy a built Python venv; publish selection metadata for permanent runtime slots.
7. Where a dependency is unavailable, preserve evidence and complete unrelated safe work. Do not weaken safety checks, substitute a model/platform, or claim unrun tests passed. Ask the user to coordinate remaining external verification on return.
8. Gate current Headroom refactor on fresh setup and controlled new-layout recovery fixtures. Do not invent pre-refactor compatibility or require a nonexistent future Headroom release pair.

## Dependency-ordered work

### 1. Reconcile the approved plan
- [x] Replace manual-consent/dedicated-upgrade-command proposals with automatic staged upgrades and safe retry/deferral.
- [x] Record approved artifact, ownership, retention, technical discretion and testing decisions.
- [x] Replace current-environment native ARM64 gates with the external acceptance handoff; preserve unverified-platform reporting.
- [x] Check scope, phases, tests and acceptance sections for contradictions. Do not weaken the clean break or data safeguards.

Done when: `PLAN.md` and this checklist agree, with no outstanding product choices needed to start authorized work.

### 2. Establish a green, hermetic offline baseline
Depends on: 1.
- [x] Read current source/tests and relevant Pi SDK, extension, MCP, lifecycle and provider docs fully before integration changes.
- [x] Record fresh test/typecheck results, repository/index state and available tool/runtime versions without exposing credentials.
- [x] Repair platform-hardcoded wiring fixtures, fake managed runtime injection and temporary-path dependencies so tests cannot install/start real services.
- [x] Keep failures visible; get the baseline suite/typecheck green instead of skipping seven historical failures or weakening assertions.

Done when: baseline tests/typecheck pass and offline fixtures cannot escape their private paths or call the network.

### 3. Implement protected lifecycle primitives
Depends on: 2.
- [x] Add focused private-path, identity, lock/lease, space-preflight, consistent-backup, staged-swap and atomic-metadata helpers.
- [x] Define lock order, bounded waits, stale/PID-reused records and active-consumer protection.
- [x] Test symlink/permission escape, contention, space-check failure, failed promotion/restoration and interrupted publication.
- [x] Diagnose incomplete swaps and retain recovery paths; do not claim two renames are one transaction or implement a general rollback journal.

Done when: helper failure/concurrency tests and standard checks pass.

### 4. Validate Code Graph lifecycle assumptions on AMD64
Depends on: 2.
- [x] Reacquire/check reviewed artifacts without relying on historical `/tmp` evidence.
- [x] Probe private namespaces, management CLI/MCP behavior, multiple workspaces/peers and final-session daemon exit.
- [x] Verify unknown/default/external domains remain untouched; preserve curl-deny and UI-disabled controls.
- [x] Record exact evidence/limits; if private-domain isolation is unsafe, treat it as a rollout blocker, not permission to centralize stores.

Done when: AMD64 safety spike passes without touching a production namespace. Keep task open if safety assumptions are blocked; record evidence and continue unrelated safe work.

### 5. Validate fresh Headroom packaging and CPU contracts
Depends on: 2.
- [x] Install 0.41.0 into a permanent owner-private disposable slot using reviewed proxy extras/constraints.
- [x] Inventory actual dependencies/imports and state writes; exclude PyTorch and alternate embedding stacks.
- [x] Verify 384-dimensional ONNX CPU inference, fresh Memory save/search and synthetic proxy/CCR contracts.
- [x] Separate optional model preparation from proxy readiness; confirm SDK/Python identity alignment and offline cached-model operation.

Done when: disposable runtime evidence supports implementation; no existing Headroom installation/store is inspected or adopted.

### 6. Implement pinned Code Graph installation
Depends on: 2.
- [x] Add Linux x64-to-amd64 mapping and reviewed ARM64/AMD64 v0.12.1 portable manifest entries.
- [x] Apply reviewed size caps, strict packaged-version selection and no legacy fallback.
- [x] Preserve digest-before-extraction, safe executable-only extraction, locking, quarantine, failure cleanup and existing files on failure.
- [x] Test both platform mappings and negative/boundary/concurrent-install cases offline.

Done when: installer/platform tests and standard checks pass; no manifest-only release is published.

### 7. Implement Code Graph v0.12.1 management and private lifecycle
Depends on: 3, 4, 6.
- [x] Propagate protected runtime/cache environments to every CLI, probe, registration and supervised operation; reject inherited unsafe overrides.
- [x] Use supported CLI flags and explicit JSON; validate typed/paginated project results and unique canonical workspace identity.
- [x] Enforce exact backend identity, MCP 2024-11-05 and reviewed 17-tool set with bounded pagination/stdout safety.
- [x] Test peer lifecycle, graceful disconnect/reaping, final daemon exit, unsafe paths and bounded failures.

Done when: adapter/ownership contract tests and standard checks pass.

### 8. Implement automatic staged Code Graph upgrades
Depends on: 3, 7.
- [x] At eligible activation, detect incompatible existing state and automatically prepare the pinned upgrade without prompting.
- [x] Prove writer quiescence, preflight space, make consistent full copies and validate/rebuild only staging data.
- [x] Preserve ADRs/traces, record backup/backend/config identities, promote and publish only verified state.
- [x] Restore original data on caught publication failure; retain backup/staging diagnostics on restoration failure/interruption.
- [x] Defer safely for peers/space/validation failures; retry later without unsafe fallbacks, deletion or a required upgrade command.

Done when: automatic upgrade, idempotency, preservation, safe retry and all failure paths pass offline tests.

### 9. Implement the shared immutable Headroom runtime
Depends on: 3, 5.
- [x] Extract an explicit runtime descriptor/resolver for both proxy and Memory.
- [x] Build/validate permanent inactive slots; publish selection metadata without moving venvs or mutating a live environment.
- [x] Record package/Python/dependency/embedding identities and consumer leases; separate runtime, proxy and Memory readiness.
- [x] Test first-use races, candidate failures, live-consumer protection and controlled future-generation publication/recovery.

Done when: both consumers use one validated installation contract and runtime tests/standard checks pass.

### 10. Implement managed-only Headroom configuration and proxy ownership
Depends on: 9.
- [x] Introduce explicit fresh-format configuration; reject incompatible files/URL fields without value conversion or rewriting.
- [x] Remove external URL routing, lifecycle/status/help branches and implicit adoption of healthy localhost services.
- [x] Implement protected process identity, peer reuse, watchdog ownership, stale-record handling and last-consumer release/handoff.
- [x] Keep port 8787 default, fail-open context and healthy-request retry behavior; never stop unknown occupants or silently change endpoint.
- [x] Isolate proxy CCR/config/state in the new owned layout; preserve independent Memory and peer-session lifetimes.

Done when: configuration, ownership, lifetime and fail-open tests plus standard checks pass.

### 11. Implement fresh Memory stores and owned Headroom state
Depends on: 9.
- [x] Use distinct new-layout Memory namespaces, including custom-root handling, and require fresh opt-in.
- [x] Prove old runtime/store files are never opened, adopted, migrated or changed; canonical config is only validated/rejected.
- [x] Retain project scoping and supported logical import/export/merge semantics without legacy-store compatibility features.
- [x] Test CPU-only save/search/relationships and proxy-only/Memory-only/model-failure independence.
- [x] Exercise full new-layout store/SQLite-sidecar backups and controlled future-generation failure recovery without promising arbitrary future version migration.

Done when: freshness, preservation, logical operations and independent readiness tests plus standard checks pass.

### 12. Wire automatic activation, commands and guidance
Depends on: 8, 10, 11.
- [x] Integrate session start/shutdown, restore/on/reindex/status/off and safe later activation/retry.
- [x] Automatically upgrade eligible active/opted-in components; do not enable opted-out features merely to upgrade them.
- [x] Provide clear progress/deferred/error status without approval dialogs, `--yes` flags or a dedicated upgrade command.
- [x] Register only compatible direct MCP tools; remove unavailable guidance and nonexistent tool references.
- [x] Preserve branch-scoped Study Mode, prompt previews, format bridge semantics and component independence.

Done when: wiring/command/guidance regressions and standard checks pass.

### 13. Complete fault, concurrency and recovery coverage
Depends on: 12.
- [x] Cover multi-Pi installers/consumers, creator exit, mixed extension pins, concurrent workspaces, busy stores and failed unregister.
- [x] Inject installation, disk, model, health, backup, promotion, restoration and interrupted-swap failures.
- [x] Verify no context reaches unknown proxies, no external process is terminated and no old backend is selected to hide failure.
- [x] Test manual Code Graph extension downgrade/data pairing and AMD64 unsupported-old-extension outcome.
- [x] Test controlled within-new-layout Headroom recovery; document cross-refactor downgrade boundary without adding compatibility code.

Done when: required failure/concurrency tests pass repeatedly without leaked services, files or flaky sleeps.

### 14. Test the tests and eliminate false positives
Depends on: 13.
- [x] Audit skips, mocks, fixture realism, cleanup assertions, timeouts and test discovery.
- [x] In disposable fixtures/worktrees, prove selected deliberate faults are caught: bad digest/version/tool set, lost namespace propagation, unsafe ownership, data loss and broken direct MCP registration.
- [x] Prove negative controls fail the intended checks, not unrelated setup; restore all probes afterward.
- [x] Prove offline suite rejects accidental network/service/package access; real-runtime suites cannot silently pass with every case skipped.

Done when: negative-control/mutation evidence demonstrates meaningful assertions, and the restored full suite passes.

### 15. Run implemented AMD64 runtime and recovery integration
Depends on: 14.
- [x] Exercise actual installer/manager/runtime paths, not only direct upstream probes or callback mocks.
- [x] Test reviewed Code Graph artifacts on current and Debian 11/glibc 2.31 userlands; verify watchers, peers and clean daemon exit.
- [x] Exercise copied old-data fixtures with ADR/trace records, automatic staged upgrade, backup hashes and injected failed publication.
- [x] Exercise fresh shared Headroom proxy/Memory runtime, CPU inference, owned CCR retrieval/TTL and original-slot behavior.
- [x] Record limits: no ARM64 execution or production-size/real-user canary claim from AMD64 disposable fixtures.

Done when: available AMD64 runtime gates pass with reproducible commands and retained evidence.

### 16. Write release notes, operating docs and ARM64 handoff
Depends on: 12, 13, 15.
- [x] Update README/configuration/help/recovery/retention docs to match implemented behavior.
- [x] Add/update release notes explaining that extension upgrade authorizes automatic backend/data upgrades, backups, safe deferral and initial Headroom clean break.
- [x] Write `TEST-ARM64.md` using actual checked-in harness commands, not invented future interfaces or old `/tmp` evidence.
- [x] Explain Apple Silicon prerequisites and native Linux ARM64 VM/container execution; verify architecture and avoid amd64 emulation. Bare macOS Code Graph stays unsupported.
- [x] Include fresh setup, old ARM64 fixture upgrade, ADR/trace preservation, peers/watchers, failure recovery, manual downgrade, Headroom CPU checks, expected evidence and cleanup.
- [x] Separate user-owned ARM64 acceptance and any real-user canary from automated evidence; do not publish unsupported verification claims.

Done when: docs agree with real CLI/tests, commands receive available syntax/help validation and user has an executable ARM64 acceptance procedure.

### 17. Run final clean offline and test-quality audit
Depends on: 14, 16.
- [x] Run `npm test`, `npm run typecheck`, and `git diff --check` from a cleanly configured, isolated test environment.
- [x] Repeat concurrency-sensitive cases and the full suite as appropriate; investigate flakes instead of rerunning until lucky.
- [x] Verify discovery, justified skips, no untracked test artifacts, no leaked services, no credential output and no changes to the Git index/real user data.
- [x] Assemble requirement-to-test evidence and unresolved external-acceptance limits.

Done when: full available offline checks pass with zero unexplained failures and audited test-quality evidence.

### 18. Run isolated live Pi acceptance and deliver evidence
Depends on: 15, 16, 17.
- [x] Preflight configured local router/authentication and exact model; never select a paid/default fallback or alter shared model state.
- [x] Use isolated Pi homes/workspaces, only required Workbench/llama.cpp resources, synthetic prompts and owner-private managed service roots.
- [x] Exercise interactive and headless behavior, real direct MCP registration/calls/removal, automatic upgrade without approval, compression/CCR and failure independence.
- [x] Exercise two workspaces and same-workspace peers; verify shutdown, safe deferral and later retry.
- [x] Capture sanitized command/results, exact artifact versions and test-quality evidence; clean only owned temporary services/data.
- [x] Report completed work, exact passing/failing/unrun checks, `TEST-ARM64.md`, retained backups and blockers. Do not stage, commit, publish or call ARM64 verified.

Done: permitted AMD64 live acceptance passed with exact already-loaded local model, actual SDK/RPC/TUI, controlled startup upgrade/deferral/retry, native tools, sealed context compression and clean peer shutdown. IMPLEMENTATION-REPORT.md records scope and retained evidence. Final suite: 256 pass, zero failures/skips, three runs; 13 intended mutation assertions caught. Native ARM64/production-size/real-user canaries remain external, not claimed. No staging, commit or publication performed.

### 19. Make Headroom startup project-opt-in aware

- [x] Check existing Memory opt-in before root/config/runtime preparation.
- [x] Default compression off without explicit canonical-workspace intent.
- [x] Persist existing compression on/off commands per project; restore on restart without affecting active peers/Memory.
- [x] Keep symlink/ownership guards and original-context fail-open behavior; fence pending startup/context work after off.
- [x] Update isolated live fixtures, docs and user test procedure; pass 274 offline regressions, typecheck/whitespace and all 16 mutation controls.
- [ ] User verifies original symlinked setup, safe isolated persistence/peer behavior and optional live Pi acceptance using TEST-PROJECT-OPT-IN.md.

Implementation and offline checks complete. Host/live acceptance remains user-owned and unverified for this follow-up; prior AMD64 live evidence predates the new startup behavior.

### 20. Show Code Graph startup state and activation progress

- [x] Show Code Graph off immediately in new projects and retain it after off restore.
- [x] Announce preparation/waiting on explicit on; expose download/verification/indexing/activation footer phases using the current command UI.
- [x] Preserve symlink safety, final ready/off labels and headless behavior; pass 276 offline regressions, typecheck/whitespace and all 16 existing mutation controls.
- [ ] Verify actual host footer and live download UI feedback; no host/network acceptance claimed for this follow-up.
