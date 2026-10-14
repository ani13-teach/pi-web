import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {createJiti} from "jiti";
const jiti = createJiti(import.meta.url, {tsconfigPaths:true});
const {authModelMessages} = await jiti.import("../lib/i18n/messages/auth-models.ts");
const source = await readFile(new URL("./ModelsConfig.tsx",import.meta.url),"utf8");
const manager = await readFile(new URL("./AuthModelsManager.tsx",import.meta.url),"utf8");

test("auth list and credential detail have distinct sibling identifiers",()=>{
  assert.match(source, /AuthModelsManager key=\{\x60auth-models-\$\{providerId\}\x60\}/);
  assert.doesNotMatch(source, /AuthModelsManager key=\{providerId\}/);
});

test("save commits complete config with only edited selection lists and retains drafts on failure",()=>{
  assert.match(source,/JSON.stringify\(\{ config: nextConfig, authModelSelections: authSelections \}\)/);
  assert.match(source,/d\.partialSave \? "authModels.partialSave" : "authModels.saveFailed"/);
  assert.match(source,/window.dispatchEvent\(new Event\("pi-model-settings-changed"\)\)/);
  assert.match(source,/disabled=\{loading \|\| saving \|\| savedOk \|\| invalidAuthContext\}/);
  assert.match(manager,/aria-invalid=\{!valid\}/);
});

test("all auth management labels exist in every bundled language",()=>{
  const keys = [...manager.matchAll(/t\("authModels\.([^"]+)"/g)].map(match=>match[1]);
  for(const locale of ["zh-CN","zh-TW","en"]) {
    const messages=authModelMessages(locale);
    for(const key of keys) assert.ok(messages["authModels."+key], locale+" "+key);
    assert.ok(messages["authModels.contextHelp"]);
    assert.ok(messages["authModels.scopeHelp"]);
    assert.ok(messages["authModels.partialSave"]);
  }
});
