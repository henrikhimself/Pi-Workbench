import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const study = await jiti.import("../src/study-mode.ts");

const discoveredSkills = new Set(["ilspycmd", "docs-reader"]);
const toolInfo = [
  { name: "read" },
  { name: "grep" },
  { name: "bash" },
  { name: study.STUDY_FETCH_TOOL, annotations: { readOnlyHint: true } },
  { name: study.STUDY_DECOMPILE_TOOL, annotations: { readOnlyHint: true } },
  { name: "mcp__docs__search", annotations: { readOnlyHint: true } },
  { name: "mcp__docs__write", annotations: { readOnlyHint: false } },
  { name: "mcp__other__search", annotations: { readOnlyHint: true } },
  { name: "mcp__headroom-memory__memory_search", annotations: { readOnlyHint: true } },
  { name: "mcp__headroom-memory__memory_save", annotations: { readOnlyHint: true } },
  { name: "mcp__resources__list", annotations: { readOnlyHint: true } },
];

test("Study permissions: missing configuration selects safe inspection defaults", () => {
  const { permissions, warnings } = study.parseStudyPermissions(undefined, discoveredSkills);
  assert.deepEqual([...permissions.builtInTools], ["read", "grep", "find", "ls"]);
  assert.deepEqual([...permissions.skills], []);
  assert.deepEqual([...permissions.mcpServers], ["headroom-memory"]);
  assert.deepEqual(warnings, []);
});

test("Study permissions file: creates documented defaults once without overwriting user permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-study-config-"));
  const configPath = join(directory, "nested", "study-mode.json");
  try {
    assert.equal(await study.ensureStudyPermissionsFile(configPath), true);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), study.DEFAULT_STUDY_MODE_CONFIG);
    await writeFile(configPath, '{"version":1,"allowedBuiltInTools":["read"]}\n');
    assert.equal(await study.ensureStudyPermissionsFile(configPath), false);
    assert.equal(await readFile(configPath, "utf8"), '{"version":1,"allowedBuiltInTools":["read"]}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Study permissions: valid configuration narrows built-ins and grants exact known optional names", () => {
  const { permissions, warnings } = study.parseStudyPermissions({
    version: 1,
    allowedBuiltInTools: ["read", "find"],
    allowedSkills: ["ilspycmd"],
    allowedMcpServers: ["docs"],
  }, discoveredSkills);

  assert.deepEqual([...permissions.builtInTools], ["read", "find"]);
  assert.deepEqual([...permissions.skills], ["ilspycmd"]);
  assert.deepEqual([...permissions.mcpServers], ["docs"]);
  assert.deepEqual(warnings, []);
});

test("Study permissions: malformed optional grants fail closed without widening built-ins", () => {
  const { permissions, warnings } = study.parseStudyPermissions({
    version: 1,
    allowedBuiltInTools: ["read", "bash"],
    allowedSkills: ["missing-skill"],
    allowedMcpServers: ["docs", "bad server"],
  }, discoveredSkills);

  assert.deepEqual([...permissions.builtInTools], ["read", "grep", "find", "ls"]);
  assert.deepEqual([...permissions.skills], []);
  assert.deepEqual([...permissions.mcpServers], []);
  assert.equal(warnings.length, 3);
});

test("restoreStudyModeState: latest valid state restores saved tool list and malformed state fails off", () => {
  const enabled = { type: "custom", customType: study.STUDY_ENTRY_TYPE, data: { enabled: true, savedToolNames: ["read", "grep"] } };
  assert.deepEqual(study.restoreStudyModeState([enabled]), { enabled: true, savedToolNames: ["read", "grep"] });
  assert.deepEqual(
    study.restoreStudyModeState([enabled, { type: "custom", customType: study.STUDY_ENTRY_TYPE, data: { enabled: true, savedToolNames: ["read", "read"] } }]),
    { enabled: false },
  );
  assert.deepEqual(
    study.restoreStudyModeState([enabled, { type: "custom", customType: study.STUDY_ENTRY_TYPE, data: { enabled: false } }]),
    { enabled: false },
  );
});

test("Study tool authorization: permits only configured read tools, bounded tools, and annotated exact MCP tools", () => {
  const { permissions } = study.parseStudyPermissions({
    version: 1,
    allowedBuiltInTools: ["read"],
    allowedSkills: ["ilspycmd"],
    allowedMcpServers: ["docs"],
  }, discoveredSkills);

  assert.equal(study.isStudyToolAllowed("read", {}, permissions, toolInfo), true);
  assert.equal(study.isStudyToolAllowed("grep", {}, permissions, toolInfo), false);
  assert.equal(study.isStudyToolAllowed(study.STUDY_FETCH_TOOL, {}, permissions, toolInfo), true);
  assert.equal(study.isStudyToolAllowed(study.STUDY_DECOMPILE_TOOL, {}, permissions, toolInfo), true);
  assert.equal(study.isStudyToolAllowed("mcp__docs__search", {}, permissions, toolInfo), true);
  assert.equal(study.isStudyToolAllowed("mcp__docs__write", {}, permissions, toolInfo), false);
  assert.equal(study.isStudyToolAllowed("mcp__other__search", {}, permissions, toolInfo), false);
  assert.equal(study.isStudyToolAllowed("bash", {}, permissions, toolInfo), false);
});

test("Study tool authorization: configured Headroom Memory permits search but never saves", () => {
  const { permissions } = study.parseStudyPermissions({ version: 1, allowedMcpServers: ["headroom-memory"] }, discoveredSkills);
  assert.equal(study.isStudyToolAllowed("mcp__headroom-memory__memory_search", {}, permissions, toolInfo), true);
  assert.equal(study.isStudyToolAllowed("mcp__headroom-memory__memory_save", {}, permissions, toolInfo), false);
});

test("Study tool authorization: resource tools require matching configured server", () => {
  const { permissions } = study.parseStudyPermissions({ version: 1, allowedMcpServers: ["docs"] }, discoveredSkills);
  assert.equal(study.isStudyToolAllowed("mcp__resources__list", { server: "docs" }, permissions, toolInfo), true);
  assert.equal(study.isStudyToolAllowed("mcp__resources__list", { server: "other" }, permissions, toolInfo), false);
  assert.equal(study.isStudyToolAllowed("mcp__resources__list", {}, permissions, toolInfo), false);
});

test("Study tool loadout: preserves captured order and only adds authorized bounded tools", () => {
  const { permissions } = study.parseStudyPermissions({
    version: 1,
    allowedBuiltInTools: ["read"],
    allowedSkills: ["ilspycmd"],
    allowedMcpServers: ["docs"],
  }, discoveredSkills);
  assert.deepEqual(
    study.buildStudyToolLoadout(["bash", "read", "mcp__docs__search", "grep"], toolInfo, permissions),
    ["read", "mcp__docs__search", study.STUDY_FETCH_TOOL, study.STUDY_DECOMPILE_TOOL],
  );
});

test("Study skill gates: block explicit non-allowed skills and reads below their roots", () => {
  const { permissions } = study.parseStudyPermissions({ version: 1, allowedSkills: ["ilspycmd"] }, discoveredSkills);
  assert.equal(study.isAllowedSkillInvocation("/skill:ilspycmd inspect Foo", permissions), true);
  assert.equal(study.isAllowedSkillInvocation(" /skill:docs-reader", permissions), false);
  assert.equal(study.isAllowedSkillInvocation("explain architecture", permissions), true);

  const roots = new Map([["ilspycmd", "/skills/ilspycmd"], ["docs-reader", "/skills/docs-reader"]]);
  assert.equal(study.isBlockedSkillPath("/skills/docs-reader/SKILL.md", roots, permissions), true);
  assert.equal(study.isBlockedSkillPath("/skills/ilspycmd/SKILL.md", roots, permissions), false);
  assert.equal(study.isBlockedSkillPath("/project/README.md", roots, permissions), false);
});
