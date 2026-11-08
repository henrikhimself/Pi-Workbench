import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url);
const { detectMcpConflict, mcpNamespaceKey } = await jiti.import("../src/mcp-conflict.ts");

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "wb-mcp-conflict-"));
  try {
    const agent = join(root, "agent"), cwd = join(root, "project");
    await mkdir(agent, { recursive: true }); await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    const registered = [];
    const pi = { getMcpServers: () => registered, registerMcpServer() {}, unregisterMcpServer() {}, getAllTools: () => [], getActiveTools: () => [] };
    const check = (extra = {}) => detectMcpConflict(pi, { serverName: "headroom-memory", cwd, agentDir: () => agent, ...extra });
    await fn({ agentFile: join(agent, "mcp.json"), projectFile: join(cwd, CONFIG_DIR_NAME, "mcp.json"), registered, check, pi });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const declare = (name) => JSON.stringify({ mcpServers: { [name]: { command: "x" } } });

test("no files and no registrations means no conflict", () => fixture(async ({ check }) => assert.equal(await check(), null)));

test("a same-name declaration is reported with the server name and the file", () => fixture(async ({ agentFile, check }) => {
  await writeFile(agentFile, declare("headroom-memory"));
  const result = await check();
  assert.match(result, /same-name MCP declaration "headroom-memory" in /);
  assert.ok(result.includes(agentFile));
}));

test("names that differ only in '-' and '_' are the same server", () => fixture(async ({ agentFile, check }) => {
  assert.equal(mcpNamespaceKey("headroom-memory"), mcpNamespaceKey("headroom_memory"));
  await writeFile(agentFile, declare("headroom_memory"));
  assert.match(await check(), /"headroom_memory"/);
  await writeFile(agentFile, declare("headroom-memories"));
  assert.equal(await check(), null, "different names are not conflicts");
}));

test("a UTF-8 BOM does not hide a declaration", () => fixture(async ({ agentFile, check }) => {
  await writeFile(agentFile, "﻿" + declare("headroom-memory"));
  assert.match(await check(), /same-name MCP declaration/);
}));

test("the project file is read at <cwd>/<CONFIG_DIR_NAME>/mcp.json, only for trusted projects", () => fixture(async ({ projectFile, check }) => {
  assert.ok(projectFile.includes(`/${CONFIG_DIR_NAME}/mcp.json`));
  await writeFile(projectFile, declare("headroom-memory"));
  assert.match(await check({ projectTrusted: () => true }), /same-name MCP declaration/);
  assert.equal(await check({ projectTrusted: () => false }), null, "Pi ignores an untrusted project's mcp.json");
  assert.match(await check(), /same-name MCP declaration/, "unknown trust errs on the side of reporting a conflict");
}));

test("invalid JSON or a bad shape fails closed", () => fixture(async ({ agentFile, check }) => {
  await writeFile(agentFile, "{ not json");
  assert.match(await check(), /invalid; conflict cannot be ruled out/);
  await writeFile(agentFile, JSON.stringify({ mcpServers: [] }));
  assert.match(await check(), /shape is invalid/);
  await writeFile(agentFile, JSON.stringify({ other: true }));
  assert.equal(await check(), null, "no mcpServers key is fine");
}));

test("another extension's registration conflicts, our own does not", () => fixture(async ({ registered, check }) => {
  registered.push({ name: "headroom_memory", config: {} });
  assert.match(await check(), /same-name extension MCP registration "headroom_memory"/);
  assert.equal(await check({ ownRegistration: true }), null);
}));

test("Memory and Code Graph tolerate a minimal Pi API, Playwright requires the public one", () => fixture(async ({ check, pi }) => {
  const minimal = {};
  assert.equal(await detectMcpConflict(minimal, { serverName: "x", cwd: "/nonexistent", agentDir: () => "/nonexistent" }), null);
  assert.match(await detectMcpConflict(minimal, { serverName: "x", cwd: "/nonexistent", agentDir: () => "/nonexistent", requireApis: true }), /public Pi MCP APIs unavailable/);
  assert.equal(await check({ requireApis: true }), null);
}));
