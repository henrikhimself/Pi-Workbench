"""Internal owned Headroom entry point: health attestation and orphan drain.

Uses the pinned upstream CLI unchanged. No model/provider fallbacks or shared
router control. Health uses challenge-response; all other HTTP routes require authenticated encryption.
"""
import base64
import hmac
import hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

nonce = os.environ.pop("WB_PROXY_OWNER")
lease_root = Path(os.environ.pop("WB_PROXY_CONSUMERS"))
resource = os.environ.pop("WB_PROXY_RESOURCE")
service_lease = Path(os.environ.pop("WB_PROXY_SERVICE_LEASE"))
from importlib.metadata import version
runtime_identity = hashlib.sha256((os.path.realpath(sys.executable) + "|" + version("headroom-ai")).encode()).hexdigest()


def birth(pid):
    if sys.platform.startswith("linux"):
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rfind(")") + 2:].split()
        return ("linux-dead:" if fields[0] in ("Z", "X") else "linux:") + fields[19]
    if sys.platform == "win32":
        raw = subprocess.check_output([
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
            f"(Get-Process -Id {int(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks",
        ], timeout=5, text=True).strip()
        return "win32:" + raw
    # Same fixed locale and time zone as managed-lifecycle.ts psEnvironment(): lstart is local time.
    ps_env = {**os.environ, "LC_ALL": "C", "TZ": "UTC"}
    raw = subprocess.check_output(["ps", "-p", str(pid), "-o", "lstart="], timeout=5, text=True, env=ps_env).strip()
    return sys.platform + ":" + raw


def consumers_present():
    for path in lease_root.glob("*.json"):
        record = json.loads(path.read_text())
        if record.get("resource") != resource:
            continue
        if record.get("schemaVersion") != 1:
            return True  # Unknown identity: never terminate a possible peer.
        # The recorded host is informational: state is local, so PID + birth identity decide, and
        # a renamed host must not keep the proxy alive forever (see identityLive in managed-lifecycle.ts).
        try:
            if birth(int(record["pid"])) == record["start"]:
                return True
        except (FileNotFoundError, ProcessLookupError, subprocess.CalledProcessError):
            continue
    return False


def monitor():
    missing_since = None
    while True:
        time.sleep(2)
        try:
            if consumers_present():
                missing_since = None
            elif missing_since is None:
                missing_since = time.monotonic()
            elif time.monotonic() - missing_since > 10:
                os.kill(os.getpid(), signal.SIGTERM)
                return
        except Exception:
            # Unverifiable records are a recovery diagnostic, not kill authority.
            missing_since = None


import uvicorn
_original_load = uvicorn.Config.load


class OwnedHealth:
    def __init__(self, app):
        self.app = app
        self.key = bytes.fromhex(nonce)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        if scope.get("path") == "/health" and headers.get(b"x-pi-workbench-encrypted") != b"1":
            challenge = headers.get(b"x-pi-workbench-challenge", b"")
            async def owned_send(message):
                if message["type"] == "http.response.start" and 0 < len(challenge) <= 128:
                    proof = hmac.new(self.key, b"health:" + challenge + b":" + runtime_identity.encode(), hashlib.sha256).hexdigest()
                    message = {**message, "headers": [*message.get("headers", []),
                               (b"x-pi-workbench-owner", proof.encode()),
                               (b"x-pi-workbench-runtime", runtime_identity.encode())]}
                await send(message)
            return await self.app(scope, receive, owned_send)
        if headers.get(b"x-pi-workbench-encrypted") != b"1":
            await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"application/json")]})
            return await send({"type": "http.response.body", "body": b'{"error":"Managed compression requires authenticated transport"}'})
        request_id = headers.get(b"x-pi-workbench-request", b"").decode("ascii", errors="replace")
        method = headers.get(b"x-pi-workbench-method", b"POST").decode("ascii", errors="replace")
        cipher = AESGCM(self.key)
        async def reply(status, body):
            iv = os.urandom(12)
            aad = f"pi-workbench:headroom:v1:response:{request_id}:{status}".encode()
            frame = json.dumps({"v": 1, "iv": base64.b64encode(iv).decode(),
                                "data": base64.b64encode(cipher.encrypt(iv, body, aad)).decode()}).encode()
            await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": frame})
        chunks, size = [], 0
        while True:
            event = await receive()
            if event["type"] == "http.disconnect":
                return
            size += len(event.get("body", b""))
            if size > 64 * 1024 * 1024:
                return await reply(413, b'{"error":"Owned request exceeds safe frame limit"}')
            chunks.append(event.get("body", b""))
            if not event.get("more_body", False):
                break
        try:
            frame = json.loads(b"".join(chunks))
            if frame["v"] != 1 or len(request_id) != 36 or method not in ("GET", "POST"):
                raise ValueError("Invalid owned frame")
            aad = f"pi-workbench:headroom:v1:request:{request_id}:{method}:{scope['path']}".encode()
            plaintext = cipher.decrypt(base64.b64decode(frame["iv"], validate=True),
                                       base64.b64decode(frame["data"], validate=True), aad)
        except Exception:
            return await reply(400, b'{"error":"Owned request authentication failed"}')
        forwarded = {**scope, "method": method, "headers": [(key, value) for key, value in scope["headers"]
                     if key.lower() not in (b"content-length", b"accept-encoding")] +
                     [(b"content-length", str(len(plaintext)).encode()), (b"accept-encoding", b"identity")]}
        consumed = False
        async def forwarded_receive():
            nonlocal consumed
            if not consumed:
                consumed = True
                return {"type": "http.request", "body": plaintext, "more_body": False}
            return await receive()
        response, response_size, status = [], 0, 500
        async def captured_send(message):
            nonlocal status, response_size
            if message["type"] == "http.response.start":
                status = message["status"]
            elif message["type"] == "http.response.body":
                response_size += len(message.get("body", b""))
                if response_size > 32 * 1024 * 1024:
                    raise ValueError("Owned response exceeds safe frame limit")
                response.append(message.get("body", b""))
        try:
            await self.app(forwarded, forwarded_receive, captured_send)
        except Exception:
            return await reply(500, b'{"error":"Owned compression failed"}')
        return await reply(status, b"".join(response))


def owned_load(config):
    _original_load(config)
    config.loaded_app = OwnedHealth(config.loaded_app)


uvicorn.Config.load = owned_load
threading.Thread(target=monitor, daemon=True, name="workbench-proxy-lifetime").start()
try:
    from headroom.cli import main
    sys.argv = ["headroom", "proxy", "--host", "127.0.0.1", "--port", sys.argv[1], "--workers", "1"]
    main()
finally:
    # This file is created by the parent with our verified process birth identity.
    # Removing only our own exact lease path cannot affect another consumer.
    service_lease.unlink(missing_ok=True)
