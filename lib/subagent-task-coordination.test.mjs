import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const dir = await mkdtemp(join(tmpdir(), "pi-coordination-unit-"));
const file = join(dir, "coord.mjs");
await build({ entryPoints: ["builtin/pi-subagents/src/task-coordination.ts"], outfile: file, bundle: true, platform: "node", format: "esm" });
const { TaskCoordinator } = await import(pathToFileURL(file));
test.after(() => rm(dir, { recursive: true, force: true }));
function record(id = "one") {
  const finish = Promise.withResolvers();
  return { id, type: "test", status: "running", description: "find cause", resultConsumed: false,
    promise: finish.promise, abortController: new AbortController(), finish };
}
function completed(r, text = "conclusion") { r.result = text; r.status = "completed"; r.finish.resolve(text); }

for (const reason of ["default", "explicit wait"]) test(`${reason} waits before the next request`, async () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, { independentWork: reason === "explicit wait" ? ["independent check"] : [] });
  if (reason === "explicit wait") c.requireWait();
  let advanced = false; const wait = c.waitForRequest().then(() => { advanced = true; });
  await Promise.resolve(); assert.equal(advanced, false);
  completed(r); await wait; assert.equal(advanced, true);
  assert.equal(c.deliveries().length, 1); c.consume(c.deliveries()[0]); assert.equal(c.deliveries().length, 0);
});
test("sibling independent declarations authorize one request, not two", async () => {
  const c = new TaskCoordinator(); const a = record("a"), b = record("b");
  c.register(a, { independentWork: ["prepare check"] }); c.register(b, { independentWork: ["prepare check"] });
  await c.waitForRequest();
  let advanced = false; const wait = c.waitForRequest().then(() => { advanced = true; });
  await Promise.resolve(); assert.equal(advanced, false);
  completed(a); await Promise.resolve(); assert.equal(advanced, false);
  completed(b); await wait;
});
test("abort cancels the wait, not the child; unconsumed result remains available", async () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, {}); const abort = new AbortController();
  const wait = c.waitForRequest(abort.signal); abort.abort(new Error("stop"));
  await assert.rejects(wait, /stop/); assert.equal(r.abortController.signal.aborted, false);
  completed(r); assert.equal(c.deliveries().length, 1);
});
test("already aborted signal never spends an independent credit", async () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, { independentWork: ["one check"] });
  const abort = new AbortController(); abort.abort(new Error("stop"));
  await assert.rejects(c.waitForRequest(abort.signal), /stop/); await c.waitForRequest();
  completed(r); await c.waitForRequest();
});
test("superseding input releases waiting without adopting old evidence", async () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, { inputVersion: "old" });
  const wait = c.waitForRequest(); c.end("superseded"); await wait; completed(r);
  c.begin(); assert.equal(c.deliveries().length, 0); assert.equal(c.snapshot(), "");
  assert.equal(r.assignment.delivery, "superseded");
});
test("shutdown releases waiter and future requests fail closed", async () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, {});
  const wait = c.waitForRequest(); c.dispose(); await assert.rejects(wait, /closed/);
  await assert.rejects(c.waitForRequest(), /closed/); assert.throws(() => c.register(record(), {}), /closed/);
});
test("queued stop releases via startGate without an onComplete callback", async () => {
  const c = new TaskCoordinator(); const r = record(); const start = Promise.withResolvers();
  r.status = "queued"; r.promise = undefined; r.startGate = start.promise; c.register(r, {});
  const wait = c.waitForRequest(); r.status = "stopped"; start.resolve(); await wait;
  assert.equal(c.deliveries()[0].record.status, "stopped");
});
test("running stop is terminal even if provider promise has not settled", async () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, {}); const wait = c.waitForRequest();
  r.abortController.abort(); r.status = "stopped"; await wait;
});
test("optional late results never reopen a settled request", async () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, { required: false });
  await c.waitForRequest(); assert.equal(c.needsContinuation(), false); c.end(); completed(r);
  assert.equal(c.deliveries().length, 0); assert.equal(r.assignment.delivery, "silent");
});
test("explicit result consumption and aliases do not leave a required dependency", () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, {}); completed(r);
  r.resultConsumed = true; assert.equal(c.needsContinuation(), false); assert.equal(c.deliveries().length, 0); c.finish();
});
test("finish refuses unconsumed required results; same-id resume has new version", () => {
  const c = new TaskCoordinator(); const r = record(); c.register(r, {});
  assert.throws(() => c.finish(), /outstanding/); completed(r); assert.throws(() => c.finish(), /outstanding/);
  const old = c.deliveries()[0]; c.consume(old); c.finish();
  r.status = "running"; r.resultConsumed = false; c.register(r, {}); assert.equal(r.assignment.runVersion, 2);
  c.consume(old); assert.equal(r.resultConsumed, false); assert.equal(r.assignment.delivery, "pending"); c.end();
});
test("provisional completion is not adopted until worktree cleanup settles", async () => {
  const c = new TaskCoordinator(); const r = record(); r.runSettled = false; c.register(r, {});
  r.status = "completed"; r.result = "pre-cleanup";
  let advanced = false; const wait = c.waitForRequest().then(() => { advanced = true; });
  await Promise.resolve(); assert.equal(advanced, false); assert.equal(c.deliveries().length, 0);
  r.result += " branch saved"; r.runSettled = true; r.finish.resolve(r.result); c.changed(); await wait;
  assert.match(c.deliveries()[0].content, /branch saved/);
});
test("invalid metadata and independent-work budgets fail before registration", () => {
  for (const input of [{ scope: null }, { scope: ["x".repeat(241)] }, { independentWork: ["" ] }, { required: "false" }, { taskKey: "x".repeat(161) }]) {
    const c = new TaskCoordinator(); assert.throws(() => c.register(record(), input)); assert.equal(c.snapshot(), "");
  }
});
test("current task table is ephemeral and root instances are isolated", async () => {
  const a = new TaskCoordinator(), b = new TaskCoordinator(); const r = record(); a.register(r, { scope: ["A.ts"] });
  assert.match(a.snapshot(), /A.ts/); assert.equal(b.snapshot(), ""); await b.waitForRequest(); completed(r); await a.waitForRequest();
  a.consume(a.deliveries()[0]); assert.equal(a.snapshot(), "");
});
