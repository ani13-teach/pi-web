/**
 * The auto-mode settings page keeps two files apart, so these cases cover the
 * rules that decide what a save actually writes:
 *
 * - a value the file does not set is shown from the inherited level, but is
 *   never written back until the user changes it;
 * - emptying a field means "drop this key here", not "set it to zero";
 * - the fallback list keeps its order, and an emptied list clears it.
 *
 * Run with: node --experimental-strip-types --test tests/automode-draft.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { buildPatch, changedKeys, draftFrom, lineList, numberErrors, parseSessionStatus, sessionLine } = await import("../components/automode-draft.ts");

/** What the extension computes for the current files. */
function effective(overrides = {}) {
  return {
    enabled: true,
    classifierModel: "Free/openrouter/free",
    classifierFallbackModels: ["KBQ/glm-5.3-flash"],
    classifierReasoningLevel: "low",
    classifierTimeoutMs: 14000,
    fastClassifierMaxTokens: 512,
    maxUserTranscriptTokens: 4000,
    maxToolTranscriptTokens: 4000,
    classifyReadOnlyTools: false,
    allowInsideWorkingDirectory: true,
    deniedPaths: [],
    log: { enabled: false, classifierIo: false },
    ruleCounts: {},
    ...overrides,
  };
}

const translate = (key, params = {}) =>
  key === "automode.notAWholeNumber" ? `${params.field} is wrong` : key;

test("a value the file does not set is shown from the inherited level", () => {
  const draft = draftFrom({}, effective());

  assert.equal(draft.classifierModel, "Free/openrouter/free");
  assert.equal(draft.classifierTimeoutMs, "14000");
  assert.equal(draft.enabled, true);
});

test("a value the file does set wins over the inherited one", () => {
  const draft = draftFrom({ classifierTimeoutMs: 20000, enabled: false }, effective());

  assert.equal(draft.classifierTimeoutMs, "20000");
  assert.equal(draft.enabled, false);
});

test("inherited values are not written back on their own", () => {
  const draft = draftFrom({}, effective());

  assert.deepEqual(changedKeys(draft, draft), []);
  assert.deepEqual(buildPatch(draft, draft), {});
});

test("only the touched field is written", () => {
  const base = draftFrom({}, effective());
  const next = { ...base, classifierTimeoutMs: "25000" };

  assert.deepEqual(changedKeys(next, base), ["classifierTimeoutMs"]);
  assert.deepEqual(buildPatch(next, base), { classifierTimeoutMs: 25000 });
});

test("emptying a field drops the key instead of writing a zero", () => {
  const base = draftFrom({ classifierTimeoutMs: 25000 }, effective());
  const next = { ...base, classifierTimeoutMs: "" };

  assert.deepEqual(buildPatch(next, base), { classifierTimeoutMs: null });
});

test("emptying the model falls back to the session default", () => {
  const base = draftFrom({}, effective());
  const next = { ...base, classifierModel: "  " };

  assert.deepEqual(buildPatch(next, base), { classifierModel: null });
});

test("the fallback list keeps its order and drops blank rows", () => {
  const base = draftFrom({}, effective());
  const next = { ...base, classifierFallbackModels: ["KBQ/b", "", "KBQ/a"] };

  assert.deepEqual(buildPatch(next, base), { classifierFallbackModels: ["KBQ/b", "KBQ/a"] });
});

test("an emptied fallback list clears the fallbacks", () => {
  const base = draftFrom({}, effective());
  const next = { ...base, classifierFallbackModels: [] };

  assert.deepEqual(buildPatch(next, base), { classifierFallbackModels: [] });
});

test("both log switches travel together as one object", () => {
  const base = draftFrom({}, effective());
  const next = { ...base, logEnabled: true };

  assert.deepEqual(buildPatch(next, base), { log: { enabled: true, classifierIo: false } });
});

test("denied paths are written one per line", () => {
  const base = draftFrom({}, effective());
  const next = { ...base, deniedPaths: "**/id_rsa\n\n  .env  \n" };

  assert.deepEqual(buildPatch(next, base), { deniedPaths: ["**/id_rsa", ".env"] });
  assert.deepEqual(lineList("a\n\n b \n"), ["a", "b"]);
});

test("a switch is always written as a boolean, never as text", () => {
  const base = draftFrom({}, effective());
  const next = { ...base, allowInsideWorkingDirectory: false };

  assert.deepEqual(buildPatch(next, base), { allowInsideWorkingDirectory: false });
});

test("non-numeric text is caught before the request", () => {
  const draft = { ...draftFrom({}, effective()), classifierTimeoutMs: "14s", maxUserTranscriptTokens: "-5" };
  const errors = numberErrors(draft, translate);

  assert.equal(errors.length, 2);
  assert.match(errors[0], /automode\.timeout is wrong/);
  assert.match(errors[1], /automode\.transcriptUser is wrong/);
});

test("an empty field is inherited, not an error", () => {
  const draft = { ...draftFrom({}, effective()), classifierTimeoutMs: "", fastClassifierMaxTokens: "  " };

  assert.deepEqual(numberErrors(draft, translate), []);
});

test("the live session's own switch is read from its status line", () => {
  const on = parseSessionStatus("AM\u25cf a:3 d:0 ca:1 cd:2");
  assert.deepEqual(on, { enabled: true, allowed: 3, blocked: 0, classifierAllowed: 1, classifierDenied: 2 });

  const off = parseSessionStatus("\u001b[2mAM\u25cb a:0 d:0\u001b[0m");
  assert.equal(off.enabled, false);
  assert.equal(off.classifierAllowed, null, "absent counts stay unknown instead of reading as zero");
});

test("a line without the marker says unknown, not off", () => {
  assert.equal(parseSessionStatus(undefined), null);
  assert.equal(parseSessionStatus("AM a:1 d:0"), null);
  assert.match(sessionLine(null, true, translate), /automode\.sessionUnknown/);
});

test("the session line separates the file's value from the session's own switch", () => {
  const running = parseSessionStatus("AM\u25cf a:12 d:1 ca:1 cd:2");
  const stopped = parseSessionStatus("AM\u25cb a:0 d:0");
  assert.match(sessionLine(running, true, translate), /sessionOn/);
  assert.match(sessionLine(stopped, false, translate), /sessionOff/);
  assert.match(sessionLine(stopped, true, translate), /sessionForcedOff/);
  assert.match(sessionLine(running, false, translate), /sessionForcedOn/);
  // The counts and the classifier breakdown only show once they are known.
  assert.match(sessionLine(running, true, translate), /automode\.sessionCounts.*automode\.sessionClassifierCounts/);
  assert.ok(!sessionLine(parseSessionStatus("AM\u25cf a:0 d:0"), true, translate).includes("sessionClassifierCounts"));
});
