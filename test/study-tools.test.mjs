import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const tools = await jiti.import("../src/study-tools.ts");

test("Study decompilation: only real DLLs below project bin/obj roots are accepted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-study-tools-"));
  const bin = join(cwd, "bin");
  const dll = join(bin, "Library.dll");
  const outside = join(cwd, "Outside.dll");
  await mkdir(bin);
  await writeFile(dll, "fixture");
  await writeFile(outside, "fixture");
  try {
    assert.equal(await tools.resolveStudyAssembly(dll, cwd), dll);
    await assert.rejects(() => tools.resolveStudyAssembly(outside, cwd), /bin\/obj|\.nuget/);
    await assert.rejects(() => tools.resolveStudyAssembly(join(bin, "Library.txt"), cwd), /only accepts .dll/);

    const escaped = join(bin, "Escaped.dll");
    await symlink(outside, escaped);
    await assert.rejects(() => tools.resolveStudyAssembly(escaped, cwd), /bin\/obj|\.nuget/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Study decompilation: argument vector is fixed and always disables update checks", () => {
  assert.deepEqual(
    tools.buildIlspyArguments({ operation: "list-types" }, "/safe/Library.dll"),
    ["--disable-updatecheck", "-l", "class,interface,struct,delegate,enum", "/safe/Library.dll"],
  );
  assert.deepEqual(
    tools.buildIlspyArguments({ operation: "decompile-type", typeName: "Example.Widget" }, "/safe/Library.dll"),
    ["--disable-updatecheck", "-t", "Example.Widget", "/safe/Library.dll"],
  );
  assert.throws(() => tools.buildIlspyArguments({ operation: "decompile-type", typeName: "Widget; rm -rf" }, "/safe/Library.dll"), /exact fully qualified/);
  assert.throws(() => tools.buildIlspyArguments({ operation: "list-types", typeName: "Example.Widget" }, "/safe/Library.dll"), /does not accept/);
});

test("Study decompilation: runs ilspycmd through argument vector and preserves bounded output metadata", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-study-tools-"));
  const bin = join(cwd, "bin");
  const dll = join(bin, "Library.dll");
  await mkdir(bin);
  await writeFile(dll, "fixture");
  const calls = [];
  try {
    const result = await tools.runStudyDecompilation(
      { operation: "decompile-type", typeName: "Example.Widget", assemblyPath: dll },
      cwd,
      undefined,
      async (command, args) => {
        calls.push({ command, args });
        return { text: "class Widget {}", truncated: false };
      },
    );
    assert.deepEqual(calls, [{ command: "ilspycmd", args: ["--disable-updatecheck", "-t", "Example.Widget", dll] }]);
    assert.equal(result.assemblyPath, dll);
    assert.equal(result.text, "class Widget {}");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Study fetch: URL and address validation rejects non-public targets", () => {
  assert.equal(tools.validateStudyFetchUrl("https://example.com/source.cs").hostname, "example.com");
  for (const url of ["http://example.com", "https://localhost/x", "https://127.0.0.1/x", "https://user@example.com/x", "not-a-url"]) {
    assert.throws(() => tools.validateStudyFetchUrl(url), /Study fetch/);
  }
  assert.equal(tools.isPublicIp("8.8.8.8"), true);
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fe80::1", "fd00::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
    assert.equal(tools.isPublicIp(ip), false, ip);
  }
});

test("Study fetch: public HTTPS works without provenance and reports redirect chain", async () => {
  const requests = [];
  const resolver = async () => [{ address: "8.8.8.8", family: 4 }];
  const requester = async (url) => {
    requests.push(url.toString());
    if (url.hostname === "example.com") {
      return { statusCode: 302, headers: { location: "https://cdn.example.net/source.cs" }, body: { text: "", truncated: false } };
    }
    return { statusCode: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: { text: "public source", truncated: false } };
  };
  const result = await tools.fetchStudySource("https://example.com/repository/file.cs", undefined, resolver, requester);
  assert.deepEqual(requests, ["https://example.com/repository/file.cs", "https://cdn.example.net/source.cs"]);
  assert.equal(result.finalUrl, "https://cdn.example.net/source.cs");
  assert.deepEqual(result.redirectChain, ["https://example.com/repository/file.cs"]);
  assert.equal(result.text, "public source");
});

test("Study fetch: blocks private DNS, unsafe redirects, and non-text responses", async () => {
  const publicResolver = async () => [{ address: "1.1.1.1", family: 4 }];
  const privateResolver = async () => [{ address: "127.0.0.1", family: 4 }];
  const noRedirect = async () => ({ statusCode: 200, headers: { "content-type": "application/pdf" }, body: { text: "", truncated: false } });
  await assert.rejects(() => tools.fetchStudySource("https://example.com/x", undefined, privateResolver, noRedirect), /public network/);
  await assert.rejects(
    () => tools.fetchStudySource("https://example.com/x", undefined, publicResolver, async () => ({ statusCode: 302, headers: { location: "http://example.com/x" }, body: { text: "", truncated: false } })),
    /not an allowed public HTTPS/,
  );
  await assert.rejects(() => tools.fetchStudySource("https://example.com/x", undefined, publicResolver, noRedirect), /non-text/);
});
