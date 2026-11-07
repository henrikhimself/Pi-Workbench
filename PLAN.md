# Plan: Managed Playwright MCP for Pi Workbench

## 1. Status and goal

**Status: approved for implementation. Product-owner decisions and current-host runtime authorization are recorded in section 10. Live Pi/model acceptance remains unapproved.**

Add the official Playwright MCP server alongside Code Graph and Headroom so coding agents can inspect and interact with websites. Follow Workbench's managed installation, process ownership, project opt-in, storage, and upgrade conventions rather than starting an unmanaged `npx ...@latest` process.

This plan distinguishes confirmed requirements from proposed implementation details and unresolved product decisions. Runtime behavior described below is intended behavior, not a claim that it has been implemented or verified.

## 2. Confirmed requirements

| Area | Approved decision |
| --- | --- |
| Commands | `/wb:playwright on`, `/wb:playwright off`, `/wb:playwright status`. |
| Server | Official `@playwright/mcp`, pinned initially to `0.0.84`. |
| Browser | Managed headless Chromium only. Headed mode is not supported. |
| Session isolation | Each concurrent Pi session owns an isolated browser. Browser state survives tool calls within that live session, but not browser closure or session/runtime teardown. |
| Persistence | Persist project enablement and managed workspace data, not reusable login profiles or automatic login-state snapshots. Multiple concurrent isolated browser sessions must be supported. |
| Browser assets | Trust Playwright's browser provisioning and verification policy. Do not introduce a separate Workbench browser-archive checksum manifest. |
| Chromium sandbox | Explicitly enabled and required. Failure produces a diagnostic; no automatic unsandboxed fallback. |
| Browsing targets | Unrestricted HTTP(S), including local, LAN, and public targets. No origin allowlist. |
| WebMCP | Disable tools supplied by visited pages. |
| Server-side scripting | Hide `browser_run_code_unsafe`; keep normal Playwright tools and page evaluation. |
| Managed state | Store Playwright-managed installation and state under `~/.pi/pi-workbench/`. |
| Destructive off | After confirmation, stop the owned session and delete the current workspace's Playwright data. Retain the shared installation for other workspaces. |
| Validation ownership | The assistant runs isolated unit checks and TypeScript validation. Real-browser/runtime acceptance and live Pi tests require separate approval. |

“Persistent live session” does not mean a persistent Chromium profile. Isolated browsers still create temporary files; isolation is not a promise of zero disk writes.

## 3. Verified integration facts and limits

- Published MCP `0.0.84` pins both `playwright` and `playwright-core` to `1.65.0-alpha-2026-10-30`. Keep that upstream pairing; do not silently substitute a stable Playwright version underneath it.
- Playwright MCP supports stdio. Its browser backend is created lazily on a tool call, so `initialize` and `tools/list` alone do not prove browser launch readiness.
- Accessibility snapshots do not require a vision model. Screenshot tools return images; visual interpretation depends on the selected model's image support. The optional `vision` capability adds coordinate-oriented actions, not the basic screenshot tool.
- `outputDir` controls automatically named artifacts. Explicit filenames resolve against the MCP workspace root instead. Setting `outputDir` alone does not satisfy strict artifact containment.
- The investigated MCP configuration disables Chromium sandboxing by default for downloaded Chromium on Linux unless explicitly overridden. Workbench must explicitly require `chromiumSandbox: true`.
- Browser OS-library prerequisites are separate from npm packages and browser downloads. A private installation cannot supply every host dependency.
- Pi's `registerMcpServer()` is session-scoped and asynchronous with respect to connection. File-configured servers can override extension registrations with the same name. Built-in MCP support, or a compatible replacement, must be loaded.
- Pi's own transcripts and MCP logs remain controlled by Pi. The Workbench storage contract covers Workbench-managed state, not relocation of Pi's global logging/session infrastructure.

No real browser launch, browser download, package installation, sandbox acceptance, or live Pi integration has been verified during investigation. Platform support must not be claimed before acceptance on the selected targets.

## 4. Proposed architecture

These module boundaries are implementation proposals, not new product requirements.

| Component | Responsibility |
| --- | --- |
| `src/playwright-config.ts` | Workspace identity, opt-in/state schemas, managed-path validation, fixed policy configuration. |
| `src/playwright-runtime.ts` | Exact package identity, private npm installation, matching browser provisioning, readiness checks, immutable runtime selection. |
| Private runtime manifest and lockfile | Reviewed, reproducible npm dependency graph for MCP `0.0.84`, separate from the user's project dependencies. Exact repository location to be settled during implementation. |
| `src/playwright-manager.ts` | Restore, activation, registration, shutdown, destructive off, and passive status. |
| `src/playwright-launcher.mjs` | Validate the owned JavaScript entrypoint, acquire child-lifetime leases, construct the child environment, forward stdio, and manage process-tree cleanup. |
| `src/playwright-guidance.ts` | Brief availability-aware browser guidance consistent with existing Workbench guidance. |
| `src/paths.ts` and `src/index.ts` | Canonical paths, command registration, lifecycle hooks, status, and prompt-preview integration. |

Reuse `src/managed-lifecycle.ts` for private directories, containment/symlink guards, locks, atomic JSON publication, process-birth identities, and consumer leases. Use `src/headroom-project.ts` as the project-intent pattern, `src/headroom-runtime.ts` as the immutable-slot pattern, and `src/code-graph-manager.ts` as the stdio MCP registration pattern.

Do not create a general backend-management framework or refactor unrelated features as part of this work. Do not change Headroom settings, proxy behavior, Memory stores, or Code Graph data.

The existing `src/managed-mcp.mjs` cannot be reused unchanged: it expects the child executable itself inside the managed installation root. Playwright needs a host Node executable plus an owned JavaScript entrypoint. Prefer a narrow Playwright-specific launcher sharing existing primitives; generalizing the existing launcher would require separate justification and regression coverage.

## 5. Proposed storage layout

```text
~/.pi/pi-workbench/playwright/
  config.json                       # feature configuration, if needed
  selected.json                     # published immutable runtime identity
  runtimes/<release>/<identity>/
    package.json
    package-lock.json
    node_modules/
    browsers/
    ready.json
  cache/npm/
  coordination/                     # installation and workspace locks
  consumers/                        # runtime/workspace consumer leases
  projects/<workspace-id>/
    opt-in.json
    sessions/<session-id>/
      config.json                   # generated effective MCP configuration
      artifacts/
      home/
      cache/
      tmp/
      diagnostics/
```

- Reuse canonical workspace-path hashing semantics, without sharing another feature's physical store.
- Shared package/browser installation is distinct from workspace/session data. Destructive off removes only the matching workspace data and its completed ownership records, never shared runtimes or another workspace.
- Set explicit browser storage, HOME, XDG/cache, npm-cache, and temporary-directory paths inside the feature root, including platform-specific equivalents where supported.
- Do not use global npm installation, the user's npm cache/configuration, a personal Chrome profile, or default `~/.cache/ms-playwright` storage as a fallback.
- Build candidates at permanent unique slot paths, then publish a selection pointer. Avoid relocating an installed runtime after tooling has recorded its paths.
- Install/launch subprocesses receive a deliberate environment. Inherited Node injection settings and Playwright attach, script, browser, policy, or path overrides must not defeat the fixed managed configuration.
- Do not place credentials in command-line arguments, durable diagnostics, test fixtures, or this repository. Screenshots, console/network output, and artifacts may themselves contain sensitive data.

Approved artifact destinations, retention, and idle-session policy are recorded in section 10.

## 6. Lifecycle and command behavior

### 6.1 Factory and session startup

- Register commands and handlers in the extension factory; do not install packages, launch processes, or start timers there.
- At `session_start`, check existing workspace opt-in before preparing managed roots or configuration. Missing opt-in is a no-op.
- Restore opted-in Playwright independently of compression, Memory, and Code Graph. Browser failures must not make ordinary Pi use unavailable.
- Use session cancellation and generation fencing so late installation/readiness results cannot register tools after off, reload, shutdown, or session replacement.
- Proposed intent behavior: save explicit `on` intent independently of backend readiness, matching compression. A failed activation retains opt-in and reports a retryable failure. This retry policy is subject to plan approval.

### 6.2 `/wb:playwright on`

1. Validate command arguments, workspace identity, managed paths, and recovery state.
2. Persist explicit workspace intent under the appropriate lock.
3. Prepare or reuse the exact packaged runtime; never resolve npm `latest` during normal startup.
4. Install npm dependencies from the reviewed private lockfile with integrity enforcement and lifecycle scripts disabled. Do not modify the coding project's package manifest or lockfile.
5. Provision only the selected Chromium assets through the pinned Playwright tooling, using the private browser directory. Do not invoke privileged OS-package installation or silently disable sandboxing.
6. Validate package/dependency identities and owned entrypoint/browser paths.
7. On initial preparation, perform a disposable, sandboxed browser readiness check against synthetic local content. It must not visit an external website or use real user data. Check navigation/DOM access and screenshot production in addition to the MCP handshake/tool contract.
8. Publish the ready runtime identity and selection atomically, retaining useful failure diagnostics without publishing an incomplete runtime as ready.
9. Register the session-owned stdio MCP child through Pi. The actual session browser may remain lazy until its first browser tool call.
10. Report installation, registration, and browser validation separately. Do not label registration alone as a live, connected browser.

Real installation and browser-readiness execution are explicit runtime work, not part of the default offline test suite. Repeated `on` should be idempotent and should not discard an already active isolated session's state.

### 6.3 Runtime upgrade and recovery

- Upgrade only toward a version pin shipped in an updated Workbench release. No independent background registry polling or unreviewed version substitution.
- Use the extension-owned installation lock and recheck state after acquiring it.
- Prepare a new immutable package/browser slot; never update an active slot in place.
- Proposed conservative policy: defer selection changes while live runtime consumers remain. Do not terminate peers to complete an upgrade.
- Preserve the prior selection on candidate failure. Do not execute an older, mismatched runtime as an undocumented fallback for a newer Workbench pin.
- Retain publication recovery markers when restoration is uncertain. Refuse unsafe automatic repair, deletion, or downgrade.
- Do not rely on age-based lock stealing or browser cache garbage collection to establish writer quiescence. Keep browser assets slot-scoped so provisioning one runtime cannot remove assets belonging to an active runtime.

The initial version remains `0.0.84`; upgrade tests exercise a future packaged-pin transition using synthetic fixtures rather than changing the approved initial pin.

### 6.4 Process ownership, isolation, and shutdown

- Each concurrent Pi session gets its own owned MCP child and isolated browser state; do not share one browser context across unrelated sessions or workspaces.
- Track actual child lifetime and runtime/workspace leases, not only the parent extension's in-memory registration flag.
- Validate the host Node executable separately from the owned MCP JavaScript entrypoint and runtime identity. Do not weaken path validation simply to accept an arbitrary external script.
- Handle EOF, cancellation, normal shutdown, reload, session replacement, and abnormal exit. Use bounded graceful shutdown followed by cleanup of the owned process tree when necessary.
- Browser descendants must be included in cleanup verification; the MCP server exiting is not enough to prove the browser has exited.
- Preserve leases or recovery evidence when process-tree quiescence cannot be established. Never kill external browsers or other sessions to make cleanup appear successful.
- Normal shutdown releases session resources without deleting workspace artifacts or project opt-in. Browser cookies/local storage are not restored into the next isolated session.

### 6.5 `/wb:playwright off`

Approved intent: confirmation, stop the owned session, delete this workspace's Playwright data, and retain the shared installation.

1. Validate the calculated deletion target and request confirmation before changing state. Cancellation leaves the running session and workspace intent unchanged.
2. Fence pending activation and registration for this session.
3. Unregister the owned MCP connection and wait for verified owned-browser/process cleanup.
4. Under the workspace activation/deletion lock, establish that no other consumer can race with deletion.
5. Proposed same-workspace peer behavior: refuse/defer deletion while another session still uses that workspace. Report the blocker instead of stopping peers or deleting live data.
6. Revalidate physical containment, then delete the matching workspace directory, including opt-in, artifacts, session configuration, temporary/cache/home data, and diagnostics.
7. Verify deletion and remove only completed, matching ownership records. If stopping or deletion fails, report incomplete off and preserve recovery evidence; do not claim success.
8. Retain shared package/browser slots, shared npm cache, and all other workspaces and features.

If there is no workspace data or opt-in, off should report already off without preparing roots or starting a runtime. Noninteractive confirmation syntax remains a review decision.

### 6.6 `/wb:playwright status`

Status must not install, upgrade, launch a browser, start an MCP child, create an absent state root, or navigate to a site.

Report separately where evidence is available:

- Saved workspace startup intent and current-session activation state.
- Packaged target version, selected package/dependency versions, and browser identity/path.
- MCP registration, observed tool availability, and owned process/lease state; do not conflate these with browser readiness.
- Last disposable readiness result and its runtime identity, not a claim about a currently running browser.
- Effective fixed policies: headless, isolated, sandbox required, WebMCP disabled, unsafe code hidden, unrestricted HTTP(S).
- Managed workspace/artifact paths, last failure, and installation, cleanup, or upgrade blockers.

An overridden registration or an unrelated server's visible tools must not count as evidence that Workbench's managed child is healthy. Use supported Pi interfaces; do not build status on private Pi implementation imports.

## 7. Security and behavior boundaries

These controls are independent:

- **Chromium sandbox:** explicitly require `chromiumSandbox: true`; no `--no-sandbox` fallback or user-configurable opt-out in the approved scope. Headless operation does not require disabling the sandbox.
- **Isolated browser context:** separates session cookies/storage. It is not host-process or network isolation.
- **Page tools:** set `webmcp: false` / `--no-webmcp`. Ordinary navigation, snapshots, screenshots, and standard interaction tools remain available. Website-supplied tool definitions must not appear through tool-list updates.
- **Unsafe server execution:** make `browser_run_code_unsafe` unreachable through Pi tool exposure, including indirect/codemode calls, not merely absent from one model declaration. Retain `browser_evaluate`, which runs in page context and can still perform consequential page actions.
- **Browsing:** no HTTP(S) origin allowlist. This deliberately includes reachable loopback/LAN services as well as public sites. Do not represent unrestricted browsing as a network sandbox. Keep upstream file-access guardrails; do not enable unrestricted local-file access.
- **Trust:** upstream calls Playwright MCP's file/origin controls guardrails, not security boundaries. Hiding one tool and disabling WebMCP reduce exposed capabilities but do not prevent every prompt-injection or browser-exploit risk.

Do not automatically start an application dev server, attach to an external CDP endpoint/browser, reuse personal logins, bypass TLS validation, add firewall/container infrastructure, or grant browser permissions beyond the agreed scope. Any such additions require product-owner approval.

Browser sandbox support must be tested in the intended environment. Missing support produces an actionable diagnostic without privileged host changes. Trust in Playwright's asset provisioning does not imply trust in every visited website.

## 8. Implementation work packages

Complete these in dependency order after scope approval. Each package includes isolated tests; production runtime acceptance is separately gated.

1. **Approve remaining design choices and define contracts.** Set platform scope, artifact policy, runtime prerequisites, registration/exposure, peer deletion behavior, and configuration/confirmation interfaces. Document exact acceptance targets.
2. **Add paths, state schemas, and policy configuration.** Implement passive opt-in checks, canonical workspace/session identities, safe path validation, and fixed security policy. Test absent/unsafe/corrupt states and cross-workspace separation.
3. **Implement immutable runtime provisioning.** Add reviewed private npm manifest/lockfile, injectable installer/process seams, identity checks, browser provisioning, readiness results, atomic publication, cancellation, and upgrade deferral/recovery.
4. **Implement owned launcher and manager.** Add child-lifetime leases, strict effective environment/configuration, stdio registration, concurrent session isolation, process-tree shutdown, passive status, and destructive off transactions.
5. **Wire Pi integration.** Add the three commands, independent startup/shutdown hooks, availability-aware guidance/status, and prompt-preview consistency. Preserve existing features and headless/RPC behavior.
6. **Extend tests and documentation.** Add offline tests, negative controls, an explicitly gated browser acceptance harness, and approved live Pi coverage. Update `README.md`, `DEVELOP.md`, and `AGENTS.md` only where needed for the new feature and its validation.

## 9. Validation and evidence

### A. Assistant-run isolated checks

After implementation source/test changes:

```bash
npm test
npm run typecheck
git diff --check
```

Keep the existing isolated HOME/Pi/XDG and enforced offline policy. Mock package metadata, installers, browser readiness, and external process behavior; use synthetic owned-child fixtures where actual child lifecycle needs testing. Default tests must never run a real browser, npm installer, browser downloader, chat model, or existing user-managed service.

Extend the offline guard to recognize Node-invoked Playwright/npm entrypoints and browser executables, not only executable basenames. Fail the suite even when a forbidden operation's error is swallowed by fail-open handling.

Required offline cases:

- Opted-out startup/status/off create no roots and do not prepare a backend.
- Strict policy cannot be overridden through inherited environment or malformed configuration.
- Exact MCP/Playwright pins, lockfile identity, missing browser, failed readiness, and sandbox failure.
- Concurrent preparation, cancellation, late readiness after off/shutdown, and runtime-consumer upgrade deferral.
- Failed publication/restoration retains the prior selection or explicit recovery evidence.
- Separate workspaces and sessions never share browser state or delete each other's data.
- Off cancellation, noninteractive refusal, peer-busy refusal, failed child cleanup, unsafe deletion paths, and partial deletion reporting.
- Unsafe-code tool remains unreachable indirectly; page-provided tools remain disabled.
- Status distinguishes installation, registration, process ownership, and readiness without causing activation.
- Existing compression, Memory, Code Graph, Study Mode, and SDK/RPC lifecycle tests remain applicable.

Add deliberate-defect controls for the new opt-in gate, sandbox requirement, hidden unsafe tool, WebMCP policy, workspace deletion containment, and child-lifetime ownership rules.

### B. Real-browser/runtime acceptance: separate approval required

Proposed isolated runtime harness: `test/runtime-playwright.mjs`, following the existing explicit runtime-test gate. This is a proposed test entrypoint, not an available command yet.

Use a disposable HOME and Workbench root, approved host prerequisites, and a synthetic local website. Never use personal profiles, cookies, existing user stores, or arbitrary live sites. Verify:

- Fresh pinned npm/browser provisioning and reuse without in-place mutation.
- Actual headless Chromium launch with sandbox required and no unsandboxed retry; record evidence of the launch policy rather than relying on a successful screenshot alone.
- Navigation, accessibility snapshot, screenshot image, form interaction, console and network output.
- Live-session storage continuity, isolation between concurrent sessions/workspaces, and state loss after closing/restarting an isolated browser.
- Reload, normal off, forced termination, and descendant cleanup without leaked owned processes.
- Confirmed workspace-data deletion, shared-install retention, peer-busy handling, and safe upgrade/recovery behavior.
- Managed-state placement, explicit output-filename behavior, temporary/registry/cache paths, and absence of unexpected project/global cache writes under the chosen artifact policy.

### C. Live Pi acceptance: separate approval required

Verify actual tool discovery and execution with Pi's built-in MCP integration, including `-e builtin:mcp` when using `--no-extensions`. Test screenshot delivery and text snapshots with compression both on and off, tool visibility policy, command confirmation, and session replacement. Use only an explicitly authorized model and synthetic content; retain existing live-test authorization restrictions unless separately changed by the owner.

If sandboxing, a target platform, or a live dependency is unavailable, state what remains unverified, provide the exact acceptance procedure, and ask the user to run or coordinate it. Do not declare the integration working based on mocks or a handshake alone.

## 10. Approved implementation contracts

The product owner approved the following contracts before unattended implementation. These supersede earlier proposal/review wording in this document.

| Area | Approved contract |
| --- | --- |
| Platform targets | Linux x64 and ARM64 on Debian 12/13 and Ubuntu 22.04/24.04. Only the available Debian 13 x64 host is authorized for initial runtime acceptance; other matrix entries remain unverified targets, not verified support. No other OS/distribution or unsupported-host binary fallback. |
| Host prerequisites | Node >=22.19.0, npm >=10; validate resolved executables. No managed Node/npm downloader, privileged OS-package installation, or host security changes. Missing prerequisites produce actionable failure. |
| Pi compatibility | Feature baseline Pi >=1.4.0 with required public MCP APIs. Do not globally tighten unrelated features' peer dependencies or rely on private Pi imports. |
| Registration and tools | Server name `playwright`, stdio, direct normal tools plus upstream `vision` coordinate-action capability. Do not enable optional pdf/devtools capabilities. Screenshots/evaluate retained; unsafe server execution unreachable directly and indirectly; WebMCP disabled. Vision tools do not grant a model image support. |
| Registration conflict | Do not override/edit same-name configured servers or silently rename the managed registration. Diagnose conflict and leave managed activation unavailable. |
| Commands | No arguments means status. on/status reject extra arguments. Interactive off asks confirmation; `off --confirm-delete` explicitly confirms deletion in any mode. No implicit noninteractive confirmation; reject other arguments. |
| Off with workspace peers | After confirmation stop only invoking session, refuse deletion while other workspace consumers remain, retain workspace intent/data, and report incomplete off. No peer termination or deferred background deletion. |
| Failure/retry | Retain explicit opt-in after activation failure. Retry once at next session startup or explicit on; no polling/retry loop. |
| Upgrades | Shipped pins only; defer selection changes while live consumers remain; no mismatched older-runtime fallback or automatic registry polling. |
| Feature configuration | No user-editable feature configuration in this release. Internal/generated configuration remains validated and fixed security policies cannot be disabled. |
| Footer/progress | Use existing `setStatus` conventions for off, preparation/progress, availability, and failure. Availability reflects validated managed registration/tool evidence, not proof a browser is open. Show lock wait, npm installation, Chromium download, readiness checks, and completion/failure. Stage-level feedback required; percentages only when reliable. |
| Artifact destinations | All generated outputs, including downloads/screenshots/diagnostics and explicit filenames, remain in managed session storage. Reject project/external output destinations. Preserve workspace-file upload use under upstream file guardrails; no unrestricted local-file access or personal profiles. |
| Retention/resources | Keep artifacts/diagnostics until confirmed workspace off; normal shutdown cleans transient browser resources. No new artifact-size quota, retention TTL, runtime GC, or silent deletion policy. Document possible disk growth. No automatic tracing/video/HAR beyond standard behavior or explicitly requested approved tools. |
| Browser lifetime | Disable idle browser closure with idle timeout 0. Preserve live state until explicit browser closure or session/runtime teardown; no reusable login snapshots/profile restoration. |
| Diagnostics | Keep credentials out of durable diagnostics. Pi-owned transcripts/logs remain Pi-managed and outside Workbench's relocation contract. |
| Runtime acceptance authorization | Assistant may install exact pinned npm packages, download official Chromium assets, launch sandboxed browsers, and run runtime acceptance on current Debian 13 x64 host only. Use disposable HOME/Pi/XDG/Workbench roots and synthetic loopback sites/content; no user profiles/stores, arbitrary live sites, normal-user caches, external service control, OS-package installation, container/image setup, or privileged changes. |
| Live Pi acceptance | Not authorized. Keep live Pi/model acceptance pending; do not make model/service changes or claim live verification. |
| Unattended implementation | Assistant owns isolated tests/typecheck/whitespace and disposable deliberate-defect checks. May choose internal module/schema details, bounded operation timeouts, and UI wording within these contracts. Preserve existing staged work/index; no commits, staging, or branch changes. Unexpected product/security choices block affected work; document blockers and continue only independently approved work. |

If prerequisites, sandboxing, downloads, or another dependency are unavailable, preserve evidence and provide the exact remaining procedure. Do not bypass protections or claim success.

## 11. Completion criteria

- Approved requirements in section 2 are implemented without adding unapproved browser modes, profiles, targets, commands, or cleanup policies.
- Review decisions are resolved and documented; proposed behavior is not silently treated as approved.
- Offline checks and strict TypeScript validation pass after source/test changes.
- Approved real-browser and live Pi acceptance gates have recorded evidence, or outstanding external gates are clearly reported as unverified.
- Off removes only confirmed workspace data after owned-process quiescence, while shared installation and other workspaces remain intact.
- Documentation explains prerequisites, state locations, isolated-session lifetime, sandbox failures, unrestricted HTTP(S) reach, and destructive off behavior.
- No unrelated source changes, legacy Headroom-path handling, external service control, or user-store migrations are included.

## 12. Sources

- [Official Playwright MCP 0.0.84 documentation](https://github.com/microsoft/playwright-mcp/blob/v0.0.84/README.md).
- [Published MCP source snapshot](https://github.com/microsoft/playwright-mcp/tree/be26c080edfae7c761db1e757c4aff9f6453b4d7).
- [Pinned Playwright MCP/browser backend source](https://github.com/microsoft/playwright/tree/018adb570c757898e7035f23e29ebb689d1d6ead/packages/playwright-core/src/tools).
- [Playwright browser management](https://playwright.dev/docs/browsers).
- Installed Pi 1.4.0 extension/MCP documentation and public extension declarations. Check the supported host-version contract during implementation; do not depend on private Pi internals.
- Local source: `src/paths.ts`, `src/managed-lifecycle.ts`, `src/managed-mcp.mjs`, `src/headroom-project.ts`, `src/headroom-runtime.ts`, `src/code-graph-manager.ts`, `src/index.ts`, and `test/helpers/offline-guard.mjs`.
