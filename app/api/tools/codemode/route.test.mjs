import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const original = process.env.PI_CODING_AGENT_DIR;
const dir = await mkdtemp(join(tmpdir(), "pi-desktop-codemode-route-"));
process.env.PI_CODING_AGENT_DIR = dir;
const jiti = createJiti(import.meta.url, {
  alias: { "next/server": join(process.cwd(), "desktop/shims/next-server.ts"), "@": process.cwd() },
});
const { GET, PUT } = await jiti.import("./route.ts");
after(async () => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
  await rm(dir, { recursive: true, force: true });
});
const request = (body, headers = { "Content-Type": "application/json" }, url = "http://localhost/api/tools/codemode") => new Request(url, { method: "PUT", headers: { Host: "localhost", ...headers }, body: JSON.stringify(body) });

test("codemode endpoint reads and saves only the global tool preference", async () => {
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ unrelated: "keep" }));
  assert.deepEqual(await (await GET()).json(), { enabled: false });
  let response = await PUT(request({ enabled: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { unrelated: "keep", defaultTools: ["+codemode"] });
  assert.deepEqual(await (await GET()).json(), { enabled: true });
  response = await PUT(request({ enabled: false }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
  assert.deepEqual(await (await GET()).json(), { enabled: false });
});

test("codemode endpoint rejects untrusted requests, non-JSON and invalid values without writes", async () => {
  const path = join(dir, "settings.json");
  const before = await readFile(path, "utf8");
  assert.equal((await PUT(request({ enabled: true }, { "Content-Type": "application/json", Origin: "https://evil.invalid" }))).status, 403);
  assert.equal((await PUT(request({ enabled: true }, { "Content-Type": "text/plain" }))).status, 415);
  for (const body of [null, {}, { enabled: "true" }, { enabled: 1 }]) {
    assert.equal((await PUT(request(body))).status, 400);
  }
  assert.equal(await readFile(path, "utf8"), before);
});
