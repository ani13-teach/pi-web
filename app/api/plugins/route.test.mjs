import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Keep SDK ancestor discovery away from the real user's .pi directory.
const tempBase = process.platform === "win32"
  ? join(process.env.PUBLIC ?? join(dirname(homedir()), "Public"), "Documents")
  : tmpdir();
const root = await mkdtemp(join(tempBase, "pi-web-plugin-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(cwd);
await writeFile(join(agentDir, "extensions", "rtk.ts"), "export default () => {};\n");

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": process.cwd(),
    "next/server": join(process.cwd(), "desktop/shims/next-server.ts"),
  },
});
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { trustProject } = await jiti.import("../../../lib/project-trust.ts");
const { DefaultPackageManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { GET, POST } = await jiti.import("./route.ts");
allowFileRoot(cwd);

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("lists auto-discovered top-level extensions", async () => {
  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.packages, []);
  assert.deepEqual(body.standaloneExtensions, [{
    kind: "extension",
    name: "rtk",
    path: join(agentDir, "extensions", "rtk.ts"),
    relativePath: join("extensions", "rtk.ts"),
    scope: "global",
    enabled: true,
  }]);
  assert.equal(body.totals.extensions, 1);
});

test("removes existing local declaration without deleting its files", async () => {
  const source = join("local", "existing-plugin");
  const packageDir = join(agentDir, source);
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "existing-plugin" }));
  await seedPackages([source]);
  assert.equal((await removePackage(source)).status, 200);
  assert.deepEqual((await readSettings()).packages, []);
  assert.equal(JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).name, "existing-plugin");
});

test("removes an absolute local source", async () => {
  const source = join(root, "missing-absolute-plugin");
  await seedPackages([source]);
  assert.equal((await removePackage(source)).status, 200);
  assert.deepEqual((await readSettings()).packages, []);
});

test("unknown, wrong-scope and repeated removals report not found", async (t) => {
  const source = "local/deleted-plugin";
  await seedPackages([source]);
  const calls = [];
  t.mock.method(DefaultPackageManager.prototype, "remove", async (...args) => { calls.push(args); });
  assert.equal((await removePackage("local/unknown-plugin")).status, 404);
  assert.equal((await removePackage(source, "project")).status, 404);
  assert.deepEqual(calls, []);
  assert.deepEqual((await readSettings()).packages, [source]);
  assert.equal((await removePackage(source)).status, 200);
  assert.equal((await removePackage(source)).status, 404);
  assert.equal(calls.length, 1);
});

for (const source of ["npm:test-plugin@1.0.0", "git:github.com/example/test-plugin"]) {
  test(`uninstall failures preserve declaration (${source})`, async (t) => {
    await seedPackages([disabled(source)]);
    t.mock.method(DefaultPackageManager.prototype, "remove", async (input, options) => {
      assert.equal(input, source);
      assert.deepEqual(options, { local: false });
      throw new Error("Synthetic uninstall failure");
    });
    const response = await removePackage(source);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /Synthetic uninstall failure/);
    assert.deepEqual((await readSettings()).packages, [disabled(source)]);
  });

  test(`successful uninstall precedes declaration removal (${source})`, async (t) => {
    await seedPackages([disabled(source)]);
    let called = false;
    t.mock.method(DefaultPackageManager.prototype, "remove", async (input, options) => {
      assert.equal(input, source);
      assert.deepEqual(options, { local: false });
      assert.deepEqual((await readSettings()).packages, [disabled(source)]);
      called = true;
    });
    const response = await removePackage(source);
    assert.equal(response.status, 200);
    assert.equal(called, true);
    assert.deepEqual((await readSettings()).packages, []);
  });
}

test("waits for settings flush before returning the refreshed list", async (t) => {
  const source = "local/deleted-plugin";
  await seedPackages([source]);
  const original = SettingsManager.prototype.flush;
  let flushed = false;
  t.mock.method(SettingsManager.prototype, "flush", async function () {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await original.call(this);
    assert.deepEqual((await readSettings()).packages, []);
    flushed = true;
  });
  const response = await removePackage(source);
  assert.equal(response.status, 200);
  assert.equal(flushed, true);
  assert.deepEqual((await response.json()).packages, []);
});

test("settings persistence errors are not reported as success", async (t) => {
  await seedPackages(["local/deleted-plugin"]);
  let reads = 0;
  t.mock.method(SettingsManager.prototype, "drainErrors", () => ++reads === 1 ? [] : [{
    scope: "global", error: new Error("Synthetic persistence failure"),
  }]);
  const response = await removePackage("local/deleted-plugin");
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Synthetic persistence failure/);
});

for (const scope of ["global", "project"]) {
  test(`unrelated corrupt settings do not fail ${scope} removal`, async () => {
    const source = "local/deleted-plugin";
    await seedPackages(scope === "global" ? [source] : [], scope === "project" ? [source] : []);
    const otherScope = scope === "global" ? "project" : "global";
    await writeFile(settingsPath(otherScope), "not valid JSON");
    assert.equal((await removePackage(source, scope)).status, 200);
    assert.deepEqual((await readSettings(scope)).packages, []);
    assert.equal(await readFile(settingsPath(otherScope), "utf8"), "not valid JSON");
  });

  test(`corrupt ${scope} settings prevent uninstall`, async (t) => {
    await seedPackages([], []);
    await writeFile(settingsPath(scope), "not valid JSON");
    let called = false;
    t.mock.method(DefaultPackageManager.prototype, "remove", async () => { called = true; });
    assert.equal((await removePackage("npm:test-plugin", scope)).status, 500);
    assert.equal(called, false);
    assert.equal(await readFile(settingsPath(scope), "utf8"), "not valid JSON");
  });
}

test("untrusted project declarations cannot be removed", async () => {
  await seedPackages([], ["local/deleted-plugin"]);
  await rm(join(agentDir, "trust.json"), { force: true });
  const response = await removePackage("local/deleted-plugin", "project");
  assert.equal(response.status, 403);
  assert.deepEqual((await readSettings("project")).packages, ["local/deleted-plugin"]);
});

const disabled = (source) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });
const settingsPath = (scope) => join(scope === "project" ? join(cwd, ".pi") : agentDir, "settings.json");

async function seedPackages(globalPackages, projectPackages = []) {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(settingsPath("global"), JSON.stringify({ packages: globalPackages, theme: "dark" }));
  await writeFile(settingsPath("project"), JSON.stringify({ packages: projectPackages }));
  trustProject(cwd, agentDir);
}

async function readSettings(scope = "global") {
  return JSON.parse(await readFile(settingsPath(scope), "utf8"));
}

function removePackage(source, scope = "global") {
  return POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ action: "remove", source, scope, cwd }),
  }));
}

for (const scope of ["global", "project"]) {
  for (const filtered of [false, true]) {
    test(`removes missing relative local package (${scope}, ${filtered ? "disabled object" : "string"})`, async () => {
      const source = join("local", "extensions", "deleted-plugin");
      const entry = filtered ? disabled(source) : source;
      const retained = disabled("local/retained-plugin");
      await seedPackages(
        scope === "global" ? [entry, retained] : [entry],
        scope === "project" ? [entry, retained] : [entry],
      );
      const response = await removePackage(source, scope);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.packages.some((pkg) => pkg.source === source && pkg.scope === scope), false);
      assert.deepEqual((await readSettings(scope)).packages, [retained]);
      assert.deepEqual((await readSettings(scope === "global" ? "project" : "global")).packages, [entry]);
      assert.equal((await readSettings()).theme, "dark");
      const refreshed = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
      assert.equal((await refreshed.json()).packages.some((pkg) => pkg.source === source && pkg.scope === scope), false);
    });
  }
}
