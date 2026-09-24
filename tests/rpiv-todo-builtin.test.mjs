import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { default: rpivTodo } = await jiti.import("../builtin/rpiv-todo/index.ts");
const { BUILTIN_RPIV_TODO_PATH, preferBuiltinRpivTodo } = await jiti.import("../lib/rpiv-todo-builtin.ts");
const { t } = await jiti.import("../builtin/rpiv-todo/state/i18n-bridge.ts");

function session(id, branch = []) {
  const handlers = new Map();
  const widgets = [];
  const ui = {
    setWidget(key, widget) { widgets.push({ key, widget }); },
    getToolsExpanded: () => false,
    theme: { fg: (_color, text) => text },
  };
  const ctx = { sessionManager: { getSessionId: () => id, getBranch: () => branch }, hasUI: true, ui };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (tool) => { pi.tool = tool; },
    registerCommand() {},
    registerShortcut() {},
  };
  rpivTodo(pi);
  return {
    ctx, pi, widgets,
    emit: (event, payload = {}) => handlers.get(event)?.(payload, ctx),
    async create(subject) {
      await pi.tool.execute("call", { action: "create", subject }, undefined, undefined, ctx);
      await handlers.get("tool_execution_end")({ toolName: "todo", isError: false }, ctx);
    },
    render() {
      const widget = widgets.findLast(({ widget }) => typeof widget === "function")?.widget;
      assert.ok(widget, `rpiv-todos widget missing for ${id}`);
      return widget({ requestRender() {} }, ui.theme).render(92).join("\n");
    },
  };
}

test("inline copy replaces enabled external rpiv-todo only, including Windows paths", () => {
  const external = "C:\\Users\\tester\\.pi\\agent\\npm\\node_modules\\@juicesharp\\rpiv-todo\\index.ts";
  const builtin = { path: BUILTIN_RPIV_TODO_PATH };
  const original = { path: external };
  const base = { extensions: [original, builtin], errors: [{ path: external, error: "duplicate todo" }], runtime: {} };
  assert.deepEqual(preferBuiltinRpivTodo(base).extensions, [builtin]);
  assert.deepEqual(preferBuiltinRpivTodo(base).errors, []);
  assert.deepEqual(preferBuiltinRpivTodo({ ...base, extensions: [builtin], errors: [] }).extensions, []);
  const failed = { ...base, extensions: [builtin], errors: [{ path: external, error: "broken plugin" }] };
  assert.deepEqual(preferBuiltinRpivTodo(failed).extensions, []);
  assert.deepEqual(preferBuiltinRpivTodo(failed).errors, failed.errors);
});

test("uses live rpiv-i18n translations when the installed plugin registered them", () => {
  const key = Symbol.for("rpiv-i18n");
  const previous = globalThis[key];
  try {
    globalThis[key] = { locale: "zh", namespaces: { "@juicesharp/rpiv-todo": { "overlay.heading": "任务清单" } } };
    assert.equal(t("overlay.heading", "Todos"), "任务清单");
    globalThis[key] = { locale: "en", namespaces: { "@juicesharp/rpiv-todo": { "overlay.heading": "Todos" } } };
    assert.equal(t("overlay.heading", "fallback"), "Todos");
    delete globalThis[key];
    assert.equal(t("overlay.heading", "Todos"), "Todos");
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});

test("sequential UI sessions restore and render their own todos, without stealing each other's overlay", async () => {
  const a = session("A", [{ type: "message", message: { role: "toolResult", toolName: "todo", details: {
    tasks: [{ id: 1, subject: "A existing", status: "pending" }], nextId: 2,
  } } }]);
  const b = session("B");
  await a.emit("session_start");
  assert.match(a.render(), /A existing/);
  await b.emit("session_start");
  await b.create("B new");
  assert.match(b.render(), /B new/);
  assert.doesNotMatch(b.render(), /A existing/);
  assert.match(a.render(), /A existing/);
  assert.doesNotMatch(a.render(), /B new/);
  await a.create("A new");
  const list = async (item) => (await item.pi.tool.execute("list", { action: "list" }, undefined, undefined, item.ctx)).details.tasks.map((task) => task.subject);
  assert.deepEqual(await list(a), ["A existing", "A new"]);
  assert.deepEqual(await list(b), ["B new"]);
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  assert.match(JSON.stringify(b.pi.tool.renderCall({ action: "update", id: 1 }, theme)), /B new/);
  assert.match(JSON.stringify(a.pi.tool.renderCall({ action: "update", id: 1 }, theme)), /A existing/);
  await a.emit("session_shutdown");
  assert.equal(a.widgets.at(-1)?.widget, undefined);
  assert.match(b.render(), /B new/);
  assert.deepEqual(await list(b), ["B new"]);
  await b.emit("session_shutdown");
  assert.equal(b.widgets.at(-1)?.widget, undefined);
});
