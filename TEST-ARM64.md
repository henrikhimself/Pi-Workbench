# User-owned final acceptance: Linux ARM64 on Apple Silicon

**Native ARM64 execution was not performed in the AMD64 implementation environment.** This is the external acceptance handoff, not a verification claim. Do not run Linux ELF on bare macOS, use AMD64 emulation as ARM64 evidence, or point tests at real Memory/Code Graph stores.

## 1. Environment and prerequisites

Use a native **Linux ARM64 VM** on Apple Silicon, or a native Linux ARM64 development container with its own writable home and access to an ARM64 Docker engine. Run the Node/Pi harnesses inside Linux, not from the macOS host.

Required:

- Node.js 22+, Pi 1.0+, Python 3.10+ with venv/pip, GNU tar and Git.
- ARM64 Docker images for the isolated legacy fixture, plus registry/download access for setup. Native container tests subsequently use `--network none`.
- Approximately 8 GiB free scratch capacity and enough RAM for Node/Python/ONNX. Tests retain binaries, model cache, snapshots and failed staging with `--keep`; no automatic backup quota/pruning.
- For optional live Pi checks, the configured router and exact `Ornith-1.5-35B-A3B-q5-mtp0` must already be ready. Do not load/unload models or restart/reconfigure that shared router.

Capture architecture evidence before any test:

```bash
uname -s
uname -m
node -p 'process.platform + "/" + process.arch'
python3 --version
tar --version
docker info --format '{{.Architecture}}'
```

Expected: Linux, `aarch64`, Node `linux/arm64`, GNU tar, native ARM64 engine. Stop if Node reports `x64`, kernel reports `x86_64`, or the engine is AMD64/emulated. Docker Desktop on macOS alone does not make a macOS Node process a supported Linux manager host.

Use a full repository clone: the downgrade fixture reads historical Workbench commit `f0f549bca882cb77b871bbcf116be18786b62047` locally. Do not silently skip this fixture because a shallow clone omitted it.

```bash
git clone https://github.com/henrikhimself/Pi-Workbench.git
cd Pi-Workbench
npm install
git cat-file -e f0f549bca882cb77b871bbcf116be18786b62047^{commit}
```

Install Pi separately if needed through its documented installation procedure; do not use an upstream Code Graph global installer.

## 2. Offline and negative-control gates

```bash
npm test
npm run typecheck
git diff --check
node test/test-quality.mjs --keep > arm64-test-quality.json 2> arm64-test-quality.log
```

`npm test` isolates HOME/Pi/XDG and credentials. It must finish with no unexplained failures/skips. Policy self-tests deliberately reject external/default-proxy access, DNS, installers and shell execution. Syntax checks include opt-in adapters. The mutation report must contain **thirteen caught deliberate defects** with intended assertions, not setup/timeout errors.

## 3. Actual native Code Graph, old-data upgrade and recovery

Prepare a native image:

```bash
docker pull --platform linux/arm64 debian:trixie-slim
docker image inspect debian:trixie-slim --format '{{.Architecture}} {{.Id}}'
```

Expected image architecture: `arm64`. The harness checks architecture and mapped mount ownership; never substitute an AMD64 image. A fresh Docker image may be shared with other work, so cleanup must not broadly stop containers or remove unrelated images.

```bash
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-code-graph.mjs --keep --old-fixture \
  > arm64-code-graph.json 2> arm64-code-graph.log
```

**Do not add `--debian11` on ARM64.** That checked-in gate is explicitly AMD64-only. This ARM64 acceptance uses the actual Linux host manager and native ARM64 legacy fixture container.

Expected successful report:

- `platform: linux/arm64`.
- v0.12.1 archive SHA `ed0f1f548cd79b121c401c2e9f7841c189a001af26d3768368088c24f6a53533`; archive 48,466,763 bytes, executable 331,161,408 bytes.
- Actual installer, initial index, strict 17-tool direct MCP, two workspace-private domains.
- Same-workspace peer survives creator release; another consumer blocks deletion.
- A **graph query**, not only live text grep, observes synthetic watcher edit.
- Actual v0.8.1 fixture ADR upgrades without approval; full pre-upgrade backup file hashes match.
- v0.12.1 trace rows persist and publication-failure restoration preserves original state/data.
- Old backend/data fixture pair is readable; archived older extension platform mapping is ARM64-only and AMD64-off.
- All last owned clients/daemons drain. No unknown/external service is killed.

The legacy v0.8.1 ARM64 portable fixture SHA is `13526acc2a6a0697dff3c763fb443a416589bc10ad8b12015b63d87e515dd72b`. This fixture is **not** an automatic backend fallback or an instruction to fabricate an older Workbench install record. Old Workbench's ARM64 manifest used its standard v0.8.1 artifact identity.

Legacy upstream quirks are intentionally checked: CLI 0.8.1 may report stale MCP metadata 0.10.0; `ingest_traces` returned accepted/not-implemented rather than persisting old observations. Do not claim old trace preservation from that stub. Production v0.12.1 checks remain strict.

If the run fails, retain the printed private home, report, schema snapshots, logs and recovery paths. Do not change checksum/version/name/ownership checks to obtain a pass. Report the first reproducible failure and relevant environment details.

## 4. Actual fresh shared Headroom and CPU Memory

```bash
WORKBENCH_RUNTIME_TESTS=1 node test/runtime-headroom.mjs --keep \
  > arm64-headroom.json 2> arm64-headroom.log
```

Expected:

- Architecture `arm64`; Headroom 0.41.0, hash-frozen permanent slot, cryptography 50.0.2.
- Sealed compression; unauthenticated content/retrieval routes refused.
- Owned SQLite CCR retrieval and expiration.
- Creator exit preserves peer; owned crash recovery and last proxy-consumer shutdown.
- CPU ONNX 384-dimensional Memory save/search and same-store peers.
- Incompatible Memory does not disable healthy compression.
- Logical bundle export/import preserves native entities/relationships and physical backups.
- Post-import Memory-only search works without launching proxy.

All homes/stores are synthetic and private. First use may download public CPU model/package assets. No chat model is called by these native harnesses. No PyTorch, MPS, CUDA, Ollama or cloud embedding fallback is acceptable.

## 5. Isolated live Pi checks

These checks remain user-owned on ARM64. AMD64 SDK/RPC/TUI acceptance is recorded separately and does not establish ARM64 execution. Prefer the reproducible full harness before additional manual checks:

```bash
# From repository; exact authorized router/model must already be ready.
# Securely supply LLAMA_API_KEY/LLAMA_BASE_URL or use existing selected-provider auth.
WORKBENCH_LIVE_TESTS=1 node test/live-pi.mjs --keep
```

The harness provisions its own short private roots and model definition from authenticated read-only model metadata. It tests SDK peers, actual RPC MCP inventory/calls/removal and a real interactive PTY. Historical compression input and old-pin startup identity are explicit controlled fixtures; native real-v0.8.1 migration remains a separate gate.

For additional manual checks: Use only `llama.cpp/Ornith-1.5-35B-A3B-q5-mtp0`; never paid/default-provider fallback. Do not call `/llama`, model load/unload APIs, or save global model/provider defaults.

Create an independent scratch home, agent directory and two synthetic workspaces. Preserve the source checkout path before changing directories:

```bash
SRC="$PWD/src/index.ts"
CASE="$(mktemp -d /tmp/wa-XXXXXX)"
mkdir -p "$CASE/home/.pi/pi-workbench" "$CASE/agent" "$CASE/a" "$CASE/b"
chmod 700 "$CASE" "$CASE/home" "$CASE/agent"
export HOME="$CASE/home" PI_CODING_AGENT_DIR="$CASE/agent"
export LLAMA_BASE_URL='http://192.168.2.48:8000'
read -rs -p 'Router credential: ' LLAMA_API_KEY; printf '\n'
export LLAMA_API_KEY
```

Use your verified local-model definition in the **isolated** `agent/models.json`. Pi compatible-provider fields are `providers`, `baseUrl`, `api`, `apiKey`, `models`; the API is `openai-completions`. Use `"apiKey":"${LLAMA_API_KEY}"` environment interpolation rather than a literal credential. Copy verified input/context metadata, not guessed model limits. Do not rewrite existing auth/models stores. Ensure the exact model is already loaded; if it is unavailable, stop and coordinate with its owner.

Supply a fresh schema-1 `headroom.json` in this scratch home. Choose an explicit unused loopback test port; do not stop an existing port occupant. Use the same scratch configuration for peers.

From workspace A:

```bash
cd "$CASE/a"
pi --no-extensions -e builtin:mcp -e "$SRC" --model llama.cpp/Ornith-1.5-35B-A3B-q5-mtp0
```

Then test:

1. `/wb:headroom-health`, `/wb:headroom-proxy status`, `/wb:headroom-memory on`, `/wb:code-graph on`. Wait for actual direct MCP tools, not only a progress label.
2. Ask the exact local model to save/search a clearly labeled synthetic Memory sentinel and query a synthetic code symbol. Inspect tool-call evidence.
3. `/wb:show-system-prompt` before/after Study Mode and Code Graph off; unavailable/disabled guidance must disappear. Study Mode is guidance, not an action sandbox.
4. Open a second Pi peer with the same scratch home/workspace. Compression off or creator exit must not stop the peer or Memory. Close the last peer and verify owned drain.
5. Open workspace B with the same scratch runtime and verify separate Memory/graph stores and IPC domains.
6. Exercise status/reindex and synthetic destructive off confirmations; busy peers must preserve data and report deferral. Retry after normal peer closure.
7. With an unknown occupant on the scratch configured proxy port, compression fails open and sends no plaintext context; never kill that process to obtain success.

Headless form uses the same isolated environment/model:

```bash
pi --mode rpc --no-session --no-extensions -e builtin:mcp -e "$SRC" \
  --model llama.cpp/Ornith-1.5-35B-A3B-q5-mtp0
```

Capture sanitized RPC initialization/tool/prompt/shutdown evidence. Do not include credentials, real user facts, or full real-user histories. A timeout, unavailable router, missing model or tool failure is an unresolved acceptance item—not a reason to select another model.

## 6. Manual recovery/downgrade and cleanup

Follow RELEASE-NOTES.md. Keep all live/staging/backup identities before any manual restore; close relevant consumers and verify real backend drain. A `.pending.json` is recovery evidence, not a switch to delete casually. Restore only a reviewed backend/config/data pair. Older Workbench cannot run Code Graph on AMD64; native ARM64 pairing still needs user acceptance. No cross-refactor Headroom adoption/restore layer exists.

The checked-in native harness tests an isolated old backend/data pair and older platform mapping. If you additionally accept an older extension deployment, use only a separate synthetic environment and its exact reviewed ARM64 manifest, never point it at current production stores or new-layout Headroom data.

After collecting evidence, exit only your test Pi processes. Confirm their owned services/consumers are gone. Remove only the exact printed scratch roots you created, and only after retaining required backups/logs. Never broadly kill processes, stop external services, remove arbitrary `/tmp` directories, or prune shared Docker images.

Return: architecture/version evidence, three native/offline reports plus optional live report and sanitized logs, exact commands, first failures if any, daemon/peer cleanup evidence, and explicit distinction between completed native ARM64 gates and unrun live/production canaries.
