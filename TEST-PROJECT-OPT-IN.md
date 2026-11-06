# User acceptance: project-aware Headroom startup

User owns host/live acceptance for this follow-up. Assistant ran offline development checks: 274 tests passed, zero failures/skips; typecheck/whitespace passed; all 16 deliberate mutation controls were caught. No follow-up live inference or production-store tests were run by the assistant.

## 1. Original symlinked setup, features not opted in

Start the local checkout from a project without fresh Memory opt-in or a compression intent marker. For example, with the exact authorized local model already configured and ready:

```bash
SRC="/absolute/path/to/Pi-Workbench/src/index.ts"
cd /path/to/project
pi --no-extensions -e builtin:mcp -e builtin:codemode -e builtin:llama.cpp \
  -e "$SRC" --model llama.cpp/Ornith-1.5-35B-A3B-q5-mtp0
```

No chat prompt is needed for startup/command checks. Do not select another provider, load/unload a model, or alter the shared router to obtain success.

Expected:

- No `Headroom Memory root unavailable` or `Managed Headroom unavailable` startup warning for these opted-out features.
- `/wb:headroom-proxy status` reports `Headroom compression: off (this session)` and `Project startup: off`.
- Startup does not create Headroom configuration, runtime, models, or project data merely because Workbench loaded.
- Ordinary Pi tools and Study Mode remain available. Unrelated Code Graph diagnostics are separate.

**Symlink rejection is unchanged.** Explicitly enabling a Headroom feature in the existing symlinked managed root may still fail safely. Do not delete, move, replace, or bypass that root to make this test pass. If a valid fresh Memory store already opts this workspace in, its unsafe-root diagnostic is expected instead of silence.

## 2. Persistence and isolation in safe disposable storage

Use an independent, private, non-symlinked test HOME/Pi directory and synthetic workspaces A and B—not real user stores. TEST-ARM64.md section 5 documents isolated model/configuration setup; its platform-independent Pi steps apply here too.

1. Open A with both features off. Confirm quiet startup and saved compression choice `off`.
2. Run `/wb:headroom-proxy on`. Confirm saved startup choice `on`. When the backend is available, wait for managed readiness; if it is unavailable, the original context must remain usable and explicit intent must remain saved.
3. Close and reopen A with the same test HOME. Saved choice stays `on`, and startup attempts managed activation without another command.
4. Open B with that same test HOME. Its compression and Memory remain off until separately enabled.
5. Run `/wb:headroom-proxy off` in A. Confirm session and saved startup choice are off. Close/reopen A; it remains off.
6. Enable only Memory in a synthetic workspace. Restart: its opted-in Memory attempts restoration, but compression remains off. Compression off must not delete/unregister that Memory.
7. For peer protection, opt A in and open two ready A sessions. Run compression off in the first. The second keeps its current session state and usable Memory/tools; a newly opened A session starts compression off. Closing the creator must not stop active peers.
8. Record any persistence error. An unsaved opt-out must disable the requesting session but warn that future startup may retry; do not treat it as saved.

Compression preference path is `~/.pi/pi-workbench/headroom/v1/compression/projects/<workspace-id>/opt-in.json`. Missing marker means off. Unknown/foreign/unsafe markers are preserved, not repaired automatically. Project identity is the canonical workspace path, matching Memory and Code Graph.

## 3. Reproducible checks

```bash
npm test
npm run typecheck
git diff --check
node test/test-quality.mjs --keep

# Optional real SDK/RPC/TUI acceptance, fresh disposable roots and synthetic data:
# Exact authorized local model must already be loaded. Never substitute providers.
WORKBENCH_LIVE_TESTS=1 node test/live-pi.mjs --keep
```

The live harness now explicitly seeds compression intent in its disposable projects. It reads only the selected local-provider credential, does not copy it into configuration/logs, and never controls router/model loading.

Return startup warnings (if any), session/project status before and after restart, separate-workspace and peer outcomes, plus sanitized failing logs or the live report. Do not share credentials or real user context. Native ARM64 acceptance remains separate; earlier AMD64 evidence does not verify this follow-up on ARM64.
