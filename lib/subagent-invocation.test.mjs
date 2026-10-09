import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { resolveAgentInvocationConfig: resolve } = await createJiti(import.meta.url).import("../builtin/pi-subagents/src/invocation-config.ts");

test("explicit execution mode outranks agent frontmatter in both directions", () => {
  for (const configured of [true, false, undefined]) {
    for (const requested of [true, false]) {
      for (const fallback of [true, false]) {
        assert.equal(resolve({ runInBackground: configured }, { run_in_background: requested }, { defaultRunInBackground: fallback }).runInBackground, requested);
      }
    }
  }
});

test("unspecified mode uses agent, then caller defaults; nested callers still default foreground", () => {
  assert.equal(resolve({ runInBackground: false }, {}, { defaultRunInBackground: true }).runInBackground, false);
  assert.equal(resolve({ runInBackground: true }, {}, { defaultRunInBackground: false }).runInBackground, true);
  assert.equal(resolve(undefined, {}, { defaultRunInBackground: true }).runInBackground, true);
  assert.equal(resolve(undefined, {}, { defaultRunInBackground: false }).runInBackground, false);
});

test("factory presets inherit top-level background without detaching nested children", async () => {
  const { DESKTOP_AGENT_PRESETS } = await createJiti(import.meta.url).import("../builtin/pi-subagents/src/desktop-agent-presets.ts");
  for (const config of DESKTOP_AGENT_PRESETS) {
    assert.equal(resolve(config, {}, { defaultRunInBackground: true }).runInBackground, true);
    assert.equal(resolve(config, {}, { defaultRunInBackground: false }).runInBackground, false);
    assert.equal(resolve(config, { run_in_background: true }, { defaultRunInBackground: false }).runInBackground, true);
  }
});

test("changing execution mode does not weaken other frontmatter restrictions", () => {
  const result = resolve({ model: "p/pinned", thinking: "high", maxTurns: 3, isolation: "off", isolated: true }, {
    model: "p/other", thinking: "low", max_turns: 9, isolation: "worktree", isolated: false, run_in_background: true,
  });
  assert.equal(result.runInBackground, true);
  assert.equal(result.modelInput, "p/pinned");
  assert.equal(result.thinking, "high");
  assert.equal(result.maxTurns, 3);
  assert.equal(result.isolation, undefined);
  assert.equal(result.isolated, true);
});
