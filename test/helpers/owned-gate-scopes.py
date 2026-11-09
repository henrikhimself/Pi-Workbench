"""Drives the managed proxy's OwnedHealth gate with non-health scopes and prints what reached the app.

Never imports src/managed-proxy.py: that module pops env vars and starts uvicorn. Only the
OwnedHealth class is extracted from the source and executed against stubs.
"""
import ast
import asyncio
import base64
import hashlib
import hmac
import json
import os
import sys

source = open(sys.argv[1], encoding="utf-8").read()
cls = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == "OwnedHealth")
namespace = {
    "nonce": "aa" * 32, "runtime_identity": "x", "AESGCM": object,
    "hmac": hmac, "hashlib": hashlib, "json": json, "base64": base64, "os": os,
}
exec(compile(ast.Module([cls], []), "OwnedHealth", "exec"), namespace)


async def drive(scope):
    called, sent = [], []

    async def app(inner_scope, receive, send):
        called.append(inner_scope["type"])

    async def receive():
        return {"type": "websocket.connect"}

    async def send(message):
        sent.append(message)

    await namespace["OwnedHealth"](app)(scope, receive, send)
    return {"called": called, "sent": sent}


scopes = {
    "websocket": {"type": "websocket", "path": "/v1/responses", "headers": []},
    "lifespan": {"type": "lifespan"},
    "http": {"type": "http", "path": "/v1/compress", "headers": []},
}


async def main():
    return {name: await drive(scope) for name, scope in scopes.items()}


print(json.dumps(asyncio.run(main()), default=lambda value: value.decode("latin-1")))
