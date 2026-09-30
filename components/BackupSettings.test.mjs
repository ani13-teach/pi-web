import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./BackupSettings.tsx", import.meta.url), "utf8");
const panel = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const navigation = await readFile(new URL("../lib/settings-navigation.ts", import.meta.url), "utf8");
const locales = await Promise.all(["en", "zh-CN", "zh-TW"].map(async (locale) =>
  readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8")));
const keys = [...source.matchAll(/t\("(backup\.[A-Za-z]+)"/g)].map((match) => match[1]);

test("offers Backup on desktop and mobile and unmounts secret state when leaving", () => {
  assert.match(navigation, /"backup",/);
  assert.match(panel, /id: "backup", label: t\("backup\.title"\), requiresProject: false/);
  assert.match(panel, /if \(section === "backup"\) return <svg \{\.\.\.common\}>/);
  assert.match(panel, /sections\.map\(\(item\) => \(\s*<option/);
  assert.match(panel, /sections\.map\(\(item\) => \{\s*const selected/);
  assert.match(panel, /sectionHost\("backup", section === "backup" \? <BackupSettings \/> : null\)/);
});

test("uses only the desktop bridge and does not persist or log passwords", () => {
  assert.match(source, /bridge\?\.backupScan && bridge\.backupExport && bridge\.backupInspect && bridge\.backupRestore/);
  assert.match(source, /backup\.desktopOnly/);
  assert.match(source, /bridge\.backupScan\(\{ includePrivate, includeSessions: includePrivate && includeSessions/);
  assert.match(source, /bridge\.backupExport\(\{ password: exportPassword, token: scan\.token \}\)/);
  assert.match(source, /bridge\.backupInspect\(importPassword\)/);
  assert.match(source, /bridge\.backupRestore\(\{ token: inspection\.token, password: importPassword, overwrite: false \}\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|fetch\(/);
});

test("requires confirmed password and excludes optional private categories without consent", () => {
  assert.match(source, /useState\(false\)/);
  assert.match(source, /if \(!value\) \{ setIncludeSessions\(false\); setIncludeCustomizations\(false\); setIncludeProject\(false\); \}/);
  for (const option of ["Sessions", "Customizations", "Project"]) {
    assert.match(source, new RegExp(`include${option}: includePrivate && include${option}`));
  }
  assert.match(source, /exportPassword !== confirmPassword/);
  assert.match(source, /setExportPassword\(""\); setConfirmPassword\(""\); setBusy\(null\)/);
  assert.match(source, /setImportPassword\(""\)/);
});

test("requires preflight scan and invalidates it when categories change", () => {
  assert.match(source, /busy \|\| !scan \|\| exportPassword\.length < 8/);
  assert.match(source, /disabled=\{busy !== null \|\| !scan \|\| exportPassword\.length < 8/);
  assert.match(source, /setScan\(null\); setIncludePrivate\(value\)/);
  assert.match(source, /setScan\(null\); setChecked\(value\)/);
  assert.match(source, /scan\.preview\.warnings\.map/);
});

test("previews counts, types, sensitivity and warnings before restoring with skip as default", () => {
  assert.match(source, /response\.token && response\.preview/);
  assert.match(source, /inspection\.preview\.entries\.length/);
  assert.match(source, /counts\[entry\.kind\]/);
  assert.match(source, /inspection\.preview\.includePrivate/);
  assert.match(source, /inspection\.preview\.warnings\.map/);
  assert.match(source, /result\.warnings\.map/);
  assert.match(source, /result\.restored &&/);
  assert.doesNotMatch(source, /setOverwrite|onChange=\{setOverwrite\}/);
  assert.match(source, /onChange=\{\(event\) => \{ setImportPassword\(event\.target\.value\); clearPreview\(\); \}\}/);
});

test("includes every backup UI string in all three built-in locales", () => {
  assert.ok(keys.length > 20);
  for (const locale of locales) for (const key of keys) {
    assert.ok(locale.includes(`"${key}":`), `Missing ${key}`);
  }
});
