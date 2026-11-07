# Plan: Plug a Vision Model Into the Playwright Output Pipeline

**Status: draft for product-owner review.**
**Author's note:** this adds the ability to see a screenshot taken by Playwright.

**Prerequisite met:** `Qwen3-VL-4B-q8` is already registered in
`~/.pi/agent/models-store.json` under provider `llama.cpp` with
`input: ["text", "image"]` and `baseUrl: http://192.168.2.48:8000/v1`. No model
registration step is required.
The agent's own model has no vision, so a separate vision model (local
`Qwen3-VL-4B` on the host via `llama-server`) is used. This doc describes only
that wiring; existing work in `PLAN.md` (managed Playwright) is unchanged.

---

## 1. Problem / Goal

- Playwright produces screenshots (and, with a vision model, coordinate actions).
- The agent running inside Pi may lack vision capability, so it cannot interpret
  the screenshot to decide the next action or to answer "what does the page show".
- Goal: when Playwright emits a screenshot, hand it to a host-side vision model
  over HTTP and return the model's textual understanding back to the agent, so
  the agent can reason from the image without needing vision itself.

## 2. Architecture (data flow)

```
Playwright (browser)  ->  saved image (device-attested, managed path)
                            |
                            v
        screenshot-to-base64 (agent-side glue)
                            |
HTTPS/HTTP POST -> /v1/chat/completions  (host `llama-server`, router mode)
        (vision model `Qwen3-VL-4B-q8`, mmproj-F16)
                            |
          model returns textual description (JSON)
                            |
        agent interprets, decides next action, forgets raw image
```

- The vision model runs on the **host rig** (`llama-server` router mode,
  port `8000`, `--models-max 2`, SYCL `level_zero:gpu`).
- Playwright runs in the **Pi session sandbox** (isolated browser). The two are
  separate processes; the bridge is a plain HTTP POST of the base64 image.

## 3. Requirements & decisions (confirmed)

| Item | Decision |
| --- | --- |
| Vision model | Local `Qwen3-VL-4B-Instruct` (Dense, per Unsloth guidance). Not `30B`/`235B` MoE. |
| Vision endpoint & key | **Not stored** in `playwright.json`. Resolved at runtime: endpoint from `~/.pi/agent/models-store.json` (the model's `baseUrl`); API key from `~/.pi/agent/auth.json` under the config `vision.provider`. |
| Quantization | `Q8_0` (quality); `Q4_K_M` alternative if VRAM is tight. |
| mmproj | Per-model `mmproj-Qwen3-VL-4B-Instruct-F16.gguf`. **Not** generic; must match the exact model size. |
| Server | `llama-server` in router mode (`llama.sh`), port `8000`, auth header `Bearer <api-key>`. |
| Load/unload | Automatic per request via `--models-max` / router preset; keep the model in a preset with `load-on-startup = false`. |
| Chat settings (Instruct, per Unsloth) | `temp 0.7`, `top-p 0.8`, `top-k 20`, `ctx-size 8192` (start here), `n-predict 2048`. |
| Payload format | OpenAI-compatible `POST {endpoint}/chat/completions` with `messages[].content[]` `image_url` data URL. |
| Input size | Cap the screenshot (e.g. max edge 1600px) before base64 to bound cost/latency. |
| Scope of sent data | Only the single screenshot for this step. No browsing history, cookies, or credentials. |
| Local vs cloud | Local model only. No cloud/vision fallback. |

## 4. Failure handling

- Server unreachable / connection refused -> return a clear error; agent asks the
  user to describe the screenshot or retries once.
- Model not loaded (router still loading) -> retry once with a short delay.
- Model errors (bad mmproj mismatch, format error) -> fail loudly; do not guess.
- Auth key missing/misconfigured -> fail loudly; do not send the request.
- Always local, always bounded; never send images anywhere but the configured host.

## 5. Where the glue lives

- A small agent-side step (in the Playwright integration) that:
  1. takes the managed screenshot path,
  2. resizes/caps dimensions,
  3. base64-encodes it,
  4. resolves endpoint (`models-store.json` model `baseUrl`) + auth key
     (`auth.json[vision.provider]`),
  5. POSTs to the configured vision model,
  6. returns the model's text to the agent as a tool result.
- Config for the bridge lives in `~/.pi/pi-workbench/playwright.json`:
  ```json
  { "schemaVersion": 1, "vision": { "provider": "llama.cpp",
    "model": "Qwen3-VL-4B-q8" } }
  ```
  - `vision.provider` = provider id to look up the API key in `auth.json`.
  - `vision.model` = model id to look up the endpoint in `models-store.json`
    (must be registered there with `input` including `image`).
- The API key is never written to `playwright.json`; it is read from the Pi
  harness's `auth.json` at runtime and never logged.
