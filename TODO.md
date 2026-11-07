# TODO: Managed Playwright MCP

Source of truth: [PLAN.md](PLAN.md), approved by the product owner in conversation.

Implementation is authorized under the product-owner contracts recorded in PLAN.md section 10. Checkboxes track completion, not approval alone. Current-host disposable runtime acceptance is authorized; live Pi/model acceptance remains pending.

## Execution rules

- Implement the approved scope: MCP `0.0.84`, managed headless Chromium, isolated live-session state, concurrent independent sessions, required Chromium sandbox, unrestricted HTTP(S), disabled WebMCP, and hidden `browser_run_code_unsafe`.
- Trust Playwright's browser-asset provisioning/verification. Preserve npm lockfile integrity checks; do not add a Workbench browser-archive checksum manifest.
- Require confirmation before off stops the owned session and deletes this workspace's data. Retain the shared installation and other workspaces.
- Keep managed state under `~/.pi/pi-workbench/`; do not adopt personal browser profiles, external browser services, global caches, or legacy Headroom locations.
- Run isolated `npm test`, `npm run typecheck`, and `git diff --check` after source/test changes. The assistant owns these checks.
- Current Debian 13 x64 disposable package/browser provisioning and runtime acceptance are explicitly authorized under PLAN.md section 10. Other hosts and live Pi/model tests require separate approval. Never trigger runtime/live tests from the default offline suite.
- Mark a task complete only after its implementation and applicable isolated checks pass. Record failures and blockers; do not treat mocked success as browser/runtime verification.
- Preserve unrelated work and keep changes scoped to this integration. Do not refactor Headroom, Memory, Code Graph, or the general backend architecture.

## Dependency order

| Work package | Depends on | Output |
| --- | --- | --- |
| PW-00: Finalize contracts | None | Recorded implementation parameters and acceptance targets. |
| PW-01: Protect offline tests | PW-00 | Guarded fixtures and test seams that cannot launch real backends accidentally. |
| PW-02: Add state and configuration | PW-01 | Safe paths, project intent, runtime/session schemas, fixed policy. |
| PW-03: Provision immutable runtimes | PW-02 | Pinned private package/browser runtime and atomic selection. |
| PW-04: Own child process lifetimes | PW-03 | Validated launcher, leases, isolation, process-tree cleanup. |
| PW-05: Implement feature manager | PW-04 | Restore/on/off/status transactions and diagnostics. |
| PW-06: Integrate with Pi | PW-05 | Commands, lifecycle hooks, tools, guidance, status. |
| PW-07: Complete regression and documentation work | PW-06 | Offline coverage, negative controls, gated acceptance harnesses, user/developer docs. |
| PW-08: Run browser acceptance | PW-07 plus explicit runtime approval | Real-browser evidence on the approved platform matrix. |
| PW-09: Run live Pi acceptance | PW-08 plus explicit live approval | Evidence from actual Pi tool use and session lifecycles. |
| PW-10: Review and hand off | PW-07; PW-08/PW-09 results or explicitly documented outstanding gates | Final scope review and evidence report. |

Tests accompany each implementation package; PW-07 is not a reason to postpone tests until the end.

## PW-00 — Finalize contracts and acceptance targets

References: PLAN.md sections 2, 4, 8, and 10.

- [x] Record the exact supported OS/architecture/distribution matrix and acceptance hosts. Do not infer Debian 11 support from Code Graph's tests.
- [x] Confirm supported host Node/npm prerequisites and executable discovery/validation. Do not introduce a managed Node/npm downloader without approval.
- [x] Set the MCP registration name, normal-tool exposure, initial capability set, and handling of same-name file-configured servers. Preserve the approved hidden unsafe tool.
- [x] Resolve artifact behavior: managed outputs only versus explicitly requested project-file outputs; choose managed MCP workspace handling or targeted output-filename guards accordingly.
- [x] Record artifact size/retention limits, or an explicit no-automatic-cleanup policy. Do not invent quotas, TTLs, or runtime deletion policies.
- [x] Finalize same-workspace peer behavior during off; carry forward the plan's proposed refusal/defer policy unless the owner directs otherwise. Do not stop peers implicitly.
- [x] Set command grammar and noninteractive destructive-confirmation syntax; retain the three approved command names.
- [x] Decide whether a user-editable feature configuration file is needed and define its permitted fields. Fixed security policies must not become opt-out switches.
- [x] Resolve opt-in failure/retry behavior and the conservative runtime-selection upgrade/consumer policy described in the plan.
- [x] Record the minimum supported Pi API contract and concrete runtime/live acceptance procedures. Incorporate resolved decisions into project documentation without reopening confirmed requirements.

**Exit condition:** affected behavior has concrete, recorded contracts; no missing platform, artifact, confirmation, or retry values are silently assumed.

## PW-01 — Establish offline safety and test seams

References: PLAN.md section 9A; `test/offline.mjs`, `test/helpers/offline-guard.mjs`, and existing lifecycle tests.

- [x] Add reusable synthetic fixtures for private HOME/Pi/XDG roots, managed paths, workspace/session identities, and disposable ownership records.
- [x] Define injectable package metadata, npm provisioning, browser provisioning/readiness, process spawning, and publication seams for isolated tests.
- [x] Extend the offline guard to detect real npm/Playwright entrypoints invoked through Node and direct browser executables, not only command basenames.
- [x] Test that prohibited installation, download, or browser launch fails the suite even when fail-open production code catches the original error.
- [x] Add fake MCP and fake browser-descendant children for stdio, cancellation, signal, and process-tree tests without invoking upstream browser code.
- [x] Preserve the existing network guard and isolated test discovery; do not weaken another feature's offline restrictions to accommodate Playwright.

**Exit condition:** default tests can exercise lifecycle behavior without installing packages, downloading browsers, launching Chromium, or contacting a model/service.

Evidence: 300 isolated tests passed; TypeScript validation and `git diff --check` passed. Synthetic fixtures are not real-browser/runtime evidence.

## PW-02 — Implement paths, schemas, opt-in, and fixed configuration

References: PLAN.md sections 4–5 and 6.1; proposed `src/playwright-config.ts`, changes to `src/paths.ts`.

- [x] Extend `WorkbenchPaths` and `resolveWorkbenchPaths()` with the approved Playwright root, immutable runtimes, private cache, coordination, consumers, and workspace/session directories.
- [x] Implement canonical workspace hashing and unique live-session identities without sharing another feature's physical state store.
- [x] Define strict schemas for opt-in, runtime readiness/selection, session configuration, ownership references, and recovery records.
- [x] Implement passive absent-opt-in checks and atomic explicit intent writes/removal. Missing opt-in must not prepare directories, configuration, or a backend.
- [x] Apply private owner/permission checks, physical containment validation, and symlink guards before activation, publication, and deletion.
- [x] Generate effective configuration with headless Chromium, isolated state, `chromiumSandbox: true`, WebMCP disabled, and unrestricted HTTP(S) without an origin allowlist.
- [x] Prevent inherited environment/configuration from enabling headed mode, persistent profiles, unsafe policy overrides, external browser attachment, scripts, or unmanaged paths.
- [x] Apply the artifact/path policy settled in PW-00, including explicit filenames; do not rely on `outputDir` alone.
- [x] Test absent, malformed, incompatible, wrong-owner, symlinked, escaped, and interrupted-publication states, plus separation between workspaces and sessions.

**Exit condition:** safe state/configuration behavior passes isolated checks without creating managed roots for opted-out workspaces.


Evidence: 317 isolated tests passed; typecheck and whitespace checks passed. No real browser or installation executed.

## PW-03 — Implement private immutable runtime provisioning

References: PLAN.md sections 3, 5, 6.2–6.3; proposed `src/playwright-runtime.ts` and private runtime manifest/lockfile.

- [x] Add a reviewed private manifest and lockfile pinning `@playwright/mcp` to `0.0.84` with upstream `playwright`/`playwright-core` pairing `1.65.0-alpha-2026-10-30`.
- [x] Provision into permanent unique runtime slots using the approved host Node/npm contract, private cache/configuration, integrity-enforced npm installation, and disabled lifecycle scripts.
- [x] Keep provisioning out of the user's coding-project manifest/lockfile; do not use global installation or runtime `npx ...@latest` resolution.
- [x] Use the pinned Playwright tooling to provision only the selected Chromium assets into the private slot-scoped browser directory. Do not add independent archive checksums or provision OS packages automatically.
- [x] Set private HOME/XDG/npm/temp paths for provisioning and validation subprocesses; do not inherit injection or backend-selection settings.
- [x] Validate exact package/dependency identities, host executable identity, owned JavaScript entrypoint, and browser paths before use.
- [x] Implement a disposable readiness probe covering the MCP handshake/tool contract and sandboxed browser launch, synthetic local navigation/DOM access, and screenshot production. Keep the real probe behind an injectable seam in offline tests.
- [x] Separate installed, browser-validated, selected, and failed/pending states; a tool listing alone must not publish browser readiness.
- [x] Coordinate preparation with the extension-owned install lock, recheck after locking, and publish readiness/selection atomically without moving an installed slot.
- [x] Implement approved consumer-based upgrade deferral and packaged-pin-only selection. Do not mutate active slots, poll npm for newer releases, terminate peers, or silently run a mismatched older runtime.
- [x] Preserve the prior selection on candidate failure; retain recovery evidence when publication/restoration is uncertain. Refuse unsafe automatic repair, downgrade, or lock stealing.
- [x] Test reuse, exact-pin rejection, integrity/identity failure, missing browser, failed sandbox/readiness, cancellation, concurrent preparation, active consumers, and publication/restoration failure using synthetic fixtures.

**Exit condition:** provisioning and upgrade transactions pass offline checks; no real install/browser success is claimed before PW-08.


Evidence: 352 isolated tests passed; typecheck and whitespace checks passed. Private lockfile resolved from npm metadata only; actual runtime installation/browser acceptance remains gated by PW-07.

## PW-04 — Implement the owned launcher and process-tree lifecycle

References: PLAN.md sections 4 and 6.4; proposed `src/playwright-launcher.mjs`, shared `src/managed-lifecycle.ts` primitives.

- [x] Implement the narrow Playwright-specific launcher; do not weaken the existing launcher's executable-inside-install-root rule or refactor other backends unnecessarily.
- [x] Validate the approved host Node executable separately from the owned MCP JavaScript entrypoint, immutable runtime identity, generated configuration, and workspace/session markers.
- [x] Recheck runtime selection and workspace intent under the appropriate locks before spawning; reject changed identities or cancelled startup.
- [x] Acquire runtime/workspace consumer leases and transfer lifetime evidence to the actual spawned child using process-birth identities.
- [x] Construct the effective child environment explicitly and forward stdio without contaminating the MCP protocol stream with diagnostics.
- [x] Keep browser state and generated paths private to each live Pi session; do not attach to personal/external browsers or share another session's context.
- [x] Handle EOF, cancellation, normal shutdown, reload/session replacement, broken pipes, spawn failures, and abnormal exit with bounded graceful shutdown and owned process-tree escalation.
- [x] Include browser descendants in quiescence verification. Do not release leases solely because the MCP server PID exited, or kill unowned processes to force success.
- [x] Preserve leases/recovery evidence when cleanup is uncertain; make repeated shutdown safe.
- [x] Test ownership races, signal handling, descendant survival, late spawn cancellation, repeated shutdown, and external-process protection with synthetic children.

**Exit condition:** isolated process-tree tests demonstrate safe ownership and cleanup; actual Chromium descendant behavior remains a PW-08 gate.


Evidence: 365 isolated tests passed; typecheck and whitespace checks passed. Includes detached synthetic descendants, MCP/supervisor crashes, safe recovery, peer protection, startup EOF, duplicate-session refusal, and fresh transient state on reconnect. Real Chromium remains unverified.

## PW-05 — Implement restore/on/off/status transactions

References: PLAN.md section 6; proposed `src/playwright-manager.ts`.

- [x] Implement restore as a passive opt-in check followed by independent activation only for opted-in workspaces; preserve normal Pi and other features on failure.
- [x] Implement idempotent on using approved project-intent semantics, runtime preparation, readiness evidence, and MCP registration without resetting an already live isolated session.
- [x] Fence lifecycle operations with cancellation and generation checks so results cannot register tools after off, shutdown, reload, or workspace/session replacement.
- [x] Request destructive confirmation before changing off state; cancellation must preserve the running session and workspace intent.
- [x] Implement confirmed off in order: fence startup, unregister the owned connection, verify owned process-tree cleanup, acquire workspace deletion protection, check peers, revalidate containment, delete only this workspace's data, and verify deletion.
- [x] Enforce the approved same-workspace peer policy and exclude other workspaces, shared installation/browser slots, shared npm cache, and other features from deletion.
- [x] Handle already-off state without root preparation, and report incomplete stop/deletion honestly while preserving recovery evidence.
- [x] Implement status as read-only inspection with no root creation, install, upgrade, MCP/browser launch, or navigation.
- [x] Report saved intent, target/selected identities, registration, observed tools, owned leases/processes, last readiness result, effective policies, managed paths, failures, and blockers separately where evidence exists.
- [x] Avoid treating another server's visible tools, an overridden registration, or historical readiness as proof that the current managed browser is connected.
- [x] Test activation/off races, confirmation refusal, noninteractive confirmation, unregister failure, peer-busy deletion, unsafe paths, partial deletion, retained shared installation, and passive status.

**Exit condition:** command/manager transactions pass offline tests, including no deletion before confirmation or verified quiescence.


Evidence: 389 isolated tests passed; typecheck and whitespace checks passed. Includes real owned Node-fixture manager/launcher composition, parent-to-child lease handoff, forced detached-descendant cleanup, peer-busy retention without deferred deletion, and interactive/headless command confirmation. No real Chromium or live Pi/model acceptance performed.

## PW-06 — Wire commands, MCP tools, lifecycle, and guidance into Pi

References: PLAN.md sections 4, 6.1, and 7; `src/index.ts`, proposed `src/playwright-guidance.ts`.

- [x] Register `/wb:playwright on`, `/wb:playwright off`, and `/wb:playwright status` with the approved grammar and mode-aware confirmation behavior.
- [x] Keep the extension factory free of backend processes, installation, timers, and browser preparation.
- [x] Restore Playwright through the existing independent background startup pattern and integrate idempotent shutdown/session replacement cleanup.
- [x] Register the owned stdio MCP server using supported Pi APIs, the selected normal-tool exposure, and the agreed conflict-handling contract.
- [x] Make `browser_run_code_unsafe` unreachable through direct and indirect/codemode invocation, not merely absent from one model declaration. Retain normal Playwright tools and `browser_evaluate`.
- [x] Keep `webmcp: false` effective and ensure page-authored tools cannot appear through later tool-list changes.
- [x] Add availability-aware prompt guidance and status that distinguish registration, readiness evidence, and live browser state. Keep new guidance consistent with the system-prompt preview without introducing new private Pi imports.
- [x] Add a Playwright footer indicator using `ctx.ui.setStatus()`, matching existing Code Graph, Headroom, and Study Mode conventions for labels, colors, lifecycle updates, and cleanup. Add isolated tests for state transitions and stale-update prevention.
- [x] Show user-visible installation progress matching existing Workbench tools: waiting for the installation lock, npm installation, Chromium download, readiness checks, and completion/failure. Connect provisioning progress to the existing UI/status conventions, keep diagnostics off MCP stdout, and add isolated tests for progress delivery, failure reporting, cleanup, and stale-update prevention.
- [x] Keep TUI/RPC/headless operation functional and diagnose unavailable MCP integration without starting an unmanaged fallback.
- [x] Test command registration, visible/hidden tools, unavailable/overridden MCP, SDK/RPC lifecycle, late activation results, and guidance restoration/removal.

**Exit condition:** integrated offline tests pass with existing compression, Memory, Code Graph, and Study Mode behavior preserved.


Evidence: 410 offline tests passed; typecheck and whitespace checks passed. Pi API/context simulations cover command registration, RPC/headless confirmation, guidance/footer transitions, stage progress, conflicts, hidden/dynamic/nested-tool guards, canonical managed outputs, stale results and cleanup. Existing compression/Memory/Code Graph/Study Mode checks pass. No actual Pi/model or real Chromium acceptance claimed.

## PW-07 — Complete regression coverage, negative controls, and documentation

References: PLAN.md sections 8–9 and 11.

- [x] Review the full offline matrix against each lifecycle, storage, policy, cancellation, upgrade, ownership, and deletion requirement; fill gaps left by package-level tests.
- [x] Add deliberate-defect checks for missing opt-in, disabled sandbox enforcement, reachable unsafe code, enabled WebMCP, escaped deletion, and premature ownership/lease release.
- [x] Implement `test/runtime-playwright.mjs` as an explicit runtime-gated harness using disposable roots, synthetic content, approved prerequisites, preserved failure evidence, and bounded cleanup. It must not run through `npm test`.
- [x] Add separately gated live Pi fixtures for actual tool discovery/execution, image delivery, confirmation, and session replacement without changing existing model/service authorization restrictions.
- [x] Update `README.md` with prerequisites, commands, managed paths, isolated-session lifetime, sandbox failures, unrestricted HTTP(S) reach, and destructive off/shared-install retention.
- [x] Update `DEVELOP.md` and `AGENTS.md` with the exact implemented offline/runtime/live procedures and approval gates. Do not document proposed commands as already available.
- [x] Document that screenshots require suitable model support for visual interpretation, that browser sandboxing does not sandbox the MCP Node process, and that page/file/origin guardrails are not hard security boundaries.
- [x] Document the chosen artifact/retention, peer-deletion, conflict, configuration, and retry contracts, plus any unresolved external acceptance limits.
- [x] Run and record `npm test`, `npm run typecheck`, `git diff --check`, and the applicable deliberate-defect checks in disposable copies. Keep failures open rather than marking implementation complete.

**Exit condition:** offline evidence passes and gated harnesses/docs are ready; real-browser and live evidence are still separately authorized work.


Evidence: 422 offline tests passed; typecheck, whitespace and gated-script syntax checks passed. All 22 deliberate defects were killed by intended assertions in disposable copies (retained `/tmp/wb-test-quality-xaTouX`). Runtime/live scripts reject missing authorization gates before backend/model work. Review added reconnect-safe ownership-policy proof and prefix-adjacent external-namespace protection. Real Chromium and actual live Pi/model remain unverified at this gate.

## PW-08 — Obtain approval and run real-browser/runtime acceptance

References: PLAN.md section 9B and approved contracts in section 10. **Current Debian 13 x64 runtime approval granted; blocked until PW-07 completion. Other hosts remain unapproved.**

- [x] Obtain explicit approval for current Debian 13 x64 disposable pinned-package/Chromium provisioning and synthetic runtime acceptance. No OS-package installation, container setup, privileged changes, or other-host execution is authorized.
- [x] Run the implemented runtime harness on every approved platform/architecture target without inspecting or modifying real user profiles, stores, services, or normal caches.
- [x] Verify fresh exact-pin provisioning and reuse without in-place mutation; record the actual package/dependency/browser identities.
- [ ] Verify headless sandboxed launch using effective launch-policy/sandbox evidence, not a screenshot alone; verify sandbox failure produces a diagnostic without unsandboxed retry or privileged host changes.
- [x] Verify navigation, accessibility snapshots, screenshot image production, form interaction, page evaluation, console messages, and network output using synthetic local sites.
- [x] Verify live-session storage continuity, isolation of concurrent sessions/workspaces, and storage-state loss after browser closure/restart.
- [ ] Verify EOF, reload, normal off, forced termination, and descendant cleanup without leaked owned processes or disruption of peers/external processes.
- [ ] Verify confirmed workspace-data deletion, shared-install retention, peer-busy handling, and safe upgrade/recovery behavior without changing the approved initial production pin.
- [x] Verify managed artifact, explicit filename, temporary, registry, cache, and diagnostic placement under the approved storage policy, and inspect effective browsing/tool restrictions using synthetic fixtures.
- [x] Record per-target results and retained failure evidence. If a target or dependency is unavailable, provide the exact procedure for user-coordinated testing and leave that gate unverified.

**Exit condition:** real-browser evidence exists for the claimed support matrix; failed/unavailable targets are not reported as supported.


Current approved target evidence: Debian 13 x64, Node 22.22.2, npm 10.9.7; runtime `e0aaf488-1163-4224-ba57-392f7e12286b`, Chromium 157.0.0.0. Full implemented harness passed at `/tmp/wb-playwright-runtime-LBQWH8/acceptance.json`; three controller cleanup outcomes fulfilled. Verified effective sandbox page, default browser stdin, managed private CWD, immutable slot reuse, actual HTTP tools/PNG/uploads/downloads, state isolation/reset, forced MCP exit and scoped off/peer retention. Runtime exposed and fixed Linux UNIX-socket path limits and corrected explicit-filename screenshot test expectations. Current isolated checks: 425 passing tests; 22 intended negative controls caught (`/tmp/wb-test-quality-984u0L`).

Outstanding runtime gates remain unchecked: deliberately sandbox-restricted environment; trusted synthetic HTTPS/LAN/public connectivity outside supplied targets; actual Pi reload (live approval absent); actual shipped-pin upgrade (initial release has one pin); other unapproved hosts/architectures. No host-security changes, containers, OS-package installation, sandbox bypass, Pi execution, or model inference occurred. Current-host positive evidence is not full-matrix/live acceptance.

## PW-09 — Obtain approval and run live Pi acceptance

References: PLAN.md section 9C. **Blocked until explicit live approval and PW-08 completion for the live acceptance host.**

- [ ] Obtain approval for the exact existing authorized model, Pi execution modes, synthetic fixtures, and disposable roots. Do not load/unload models, control a shared router, or add paid/default fallback.
- [ ] Verify actual MCP connection/tool discovery with built-in MCP enabled, including `-e builtin:mcp` when using `--no-extensions`.
- [ ] Verify actual navigation and text snapshots, and screenshot/image delivery with the authorized model's supported capabilities. Distinguish image delivery from verified visual interpretation.
- [ ] Verify normal tools remain available while unsafe server code and page-provided WebMCP tools remain unavailable through direct and indirect paths.
- [ ] Exercise browser interaction with compression both on and off, preserving image/tool semantics and fail-open behavior.
- [ ] Verify command confirmations, on/off/status reporting, concurrent session behavior, reload, and session replacement in the approved modes.
- [ ] Record runtime identities, actual results, cleanup evidence, and any unverified capability/model/mode limits; retain failure fixtures without exposing credentials or real user content.

**Exit condition:** live behavior has evidence for the claimed capabilities; no live-success claim rests only on mocks or the MCP handshake.

## PW-10 — Final review and handoff

References: PLAN.md section 11.

- [ ] Compare the implementation and evidence against every approved requirement and recorded contract; remove or seek approval for scope additions.
- [ ] Review destructive paths and process ownership separately, including shared-install retention, other-workspace protection, and incomplete-cleanup reporting.
- [ ] Re-run final isolated checks and inspect the complete diff for unrelated edits, legacy path handling, external service control, accidental credentials, user-store migration, or personal-profile use.
- [ ] Verify documentation and advertised support match actual commands, prerequisites, package/browser identities, security policies, and acceptance evidence.
- [ ] Report changed files, passing checks, real-browser/live results, unresolved blockers, and any still-unapproved/unverified gates. Do not mark outstanding acceptance tasks complete merely to close the checklist.

**Exit condition:** the owner receives an evidence-backed handoff with remaining limitations explicit; feature functionality is not claimed beyond completed acceptance gates.
