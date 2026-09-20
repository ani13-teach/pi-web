/**
 * Wiring of the auto-mode settings page.
 *
 * The upstream settings tests cannot run here (they read web entry points this
 * build does not vendor), so the pieces this feature joins together are checked
 * from the desktop side: the tab is registered, the page talks to the right
 * endpoints, and every label it asks for exists in all three locales.
 *
 * Run with: node --experimental-strip-types --test tests/automode-panel.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFile(join(root, path), "utf8");

const [panel, navigation, config, route, testRoute, draft] = await Promise.all([
  read("components/SettingsPanel.tsx"),
  read("lib/settings-navigation.ts"),
  read("components/AutomodeConfig.tsx"),
  read("app/api/automode/route.ts"),
  read("app/api/automode/test/route.ts"),
  read("components/automode-draft.ts"),
]);

const locales = {
  en: await read("lib/i18n/messages/en.ts"),
  "zh-CN": await read("lib/i18n/messages/zh-CN.ts"),
  "zh-TW": await read("lib/i18n/messages/zh-TW.ts"),
};

test("the settings dialog registers an auto-mode tab", () => {
  assert.match(navigation, /"automode",\s*\] as const;/);
  assert.match(panel, /id: "automode", label: t\("common\.autoMode"\), requiresProject: false/);
  assert.match(panel, /if \(section === "automode"\) return <svg/);
  assert.match(panel, /<AutomodeConfig cwd=\{cwd\} sessionId=\{sessionId\} onReloaded=\{onSessionReloaded\} \/>/);
});

test("the page reads the effective values, saves to one scope, and can reload the session", () => {
  assert.match(config, /fetch\(`\/api\/automode\?cwd=\$\{encodeURIComponent\(cwd \?\? ""\)\}`\)/);
  assert.match(config, /fetch\("\/api\/automode", \{\s*method: "PUT"/);
  assert.match(config, /body: JSON\.stringify\(\{ scope, cwd, patch: buildPatch\(draft, baseline\) \}\)/);
  assert.match(config, /fetch\("\/api\/automode\/test", \{\s*method: "POST"/);
  assert.match(config, /sendAgentCommand\(sessionId, \{ type: "reload" \}\)/);
  // A switch is what the request asked for; the list rows carry the ordering controls.
  assert.match(config, /<ConfigSwitch/);
  assert.match(config, /moveFallback\(index, -1\)/);
  assert.match(config, /moveFallback\(index, 1\)/);
});

test("the model fields are a picker fed by models.json and the registry, not a free-text box", () => {
  assert.match(config, /import \{ ModelSelector \} from "\.\/ModelSelector"/);
  assert.match(config, /const \[modelsConfig, registry\] = await Promise\.all\(\[/);
  assert.match(config, /getJson\("\/api\/models-config"\)/);
  assert.match(config, /getJson\(`\/api\/models\?cwd=\$\{encodeURIComponent\(cwd \?\? ""\)\}`\)/);
  assert.match(config, /setModelOptions\(collectModelOptions\(modelsConfig, registry\)\)/);
  // Both fields go through the shared component instead of a <datalist> hint list.
  assert.doesNotMatch(config, /datalist/);
  const fields = [...config.matchAll(/<ModelSpecField\s([\s\S]*?)\/>/g)].map((match) => match[1]);
  assert.equal(fields.length, 2, "expected the primary model and the fallback rows to use ModelSpecField");
  for (const field of fields) {
    assert.match(field, /options=\{modelOptions\}/);
    assert.match(field, /loading=\{modelsLoading\}/);
    assert.match(field, /onChange=\{/);
  }
  assert.match(config, /onClear=\{\(\) => onChange\(""\)\}/);
  assert.match(config, /variant="field"/);
  assert.match(config, /placement="auto"/);
});

test("saving sends only the fields the user touched", () => {
  assert.match(draft, /export function buildPatch\(current: Draft, base: Draft\)/);
  assert.match(draft, /const dirty = new Set\(changedKeys\(current, base\)\)/);
  // Every field is behind its own dirty check, so an inherited value is never written back.
  const guards = [...draft.matchAll(/dirty\.has\("(\w+)"\)/g)].map((match) => match[1]);
  for (const key of ["enabled", "classifierModel", "classifierFallbackModels", "deniedPaths", "logEnabled"]) {
    assert.ok(guards.includes(key) || draft.includes(`${key}: `), `no dirty check for ${key}`);
  }
});

test("both auto-mode routes guard the request before touching a file", () => {
  for (const source of [route, testRoute]) {
    assert.match(source, /isApiRequestAllowed\(req\)/);
    assert.match(source, /hasJsonContentType\(req\)/);
  }
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function PUT/);
  assert.match(testRoute, /export async function POST/);
  // Unknown keys are refused instead of stored, and a project write needs trust.
  assert.match(route, /if \(!MANAGED_KEYS\.has\(key\)\) errors\.push\(`unknown setting: \$\{key\}`\)/);
  assert.match(route, /scope === "project" && !getProjectTrustStatus\(cwd, getAgentDir\(\)\)\.trusted/);
});

test("every label the page asks for exists in all three locales", async () => {
  const keys = new Map();
  for (const [file, source] of [["AutomodeConfig.tsx", config], ["automode-draft.ts", draft]]) {
    for (const match of source.matchAll(/\bt\(\s*"([a-z][\w.]*)"/gi)) keys.set(match[1], file);
    for (const match of source.matchAll(/\bt\(\s*`([^`]+)`/g)) {
      // `automode.source.${source}` resolves to these four at runtime.
      for (const kind of ["project", "global", "default", "merged"]) {
        keys.set(match[1].replace("${source}", kind), file);
      }
    }
  }
  // Labels that come from the shared dictionary rather than this page.
  for (const key of ["i18n.save", "i18n.loading", "i18n.reloadSession", "i18n.reloading", "agents.reloadRequired"]) {
    keys.set(key, "shared");
  }

  assert.ok(keys.size > 40, `expected the page to use many labels, found ${keys.size}`);
  for (const [locale, source] of Object.entries(locales)) {
    const missing = [...keys.keys()].filter((key) => !source.includes(`"${key}":`));
    assert.deepEqual(missing, [], `${locale} is missing: ${missing.join(", ")}`);
  }
});
