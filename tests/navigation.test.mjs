/**
 * Navigation policy checks.
 *
 * Run with:  node --experimental-strip-types --test tests/navigation.test.mjs
 *
 * The rules are pure functions, so they are exercised directly. A couple of
 * source-level assertions guard the wiring in main.ts, which cannot be imported
 * here because it pulls in Electron.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const nav = await import("../desktop/navigation.ts");
const {
  APP_ORIGIN,
  PREVIEW_ORIGIN,
  PREVIEW_PARTITION,
  EXPORT_PREVIEW_CSP,
  decideNavigation,
  decidePreviewNavigation,
  decideWindowOpen,
  isExportPreviewRequestAllowed,
  isHttpUrl,
  isSameOrigin,
  previewUrlFor,
} = nav;

const exportUrl = "pi-app://app/api/sessions/session-1/export?inline=1";

test("origins are the expected constants", () => {
  assert.equal(APP_ORIGIN, "pi-app://app");
  assert.equal(PREVIEW_ORIGIN, "pi-preview://export");
  assert.equal(PREVIEW_PARTITION, "pi-export-preview");
  assert.doesNotMatch(PREVIEW_PARTITION, /^persist:/);
});

test("same-origin is an exact scheme+host match, never a prefix match", () => {
  assert.equal(isSameOrigin("pi-app://app/index.html", APP_ORIGIN), true);
  assert.equal(isSameOrigin("pi-app://app", APP_ORIGIN), true);
  assert.equal(isSameOrigin("pi-app://app/api/sessions?x=1", APP_ORIGIN), true);
  // Prefix lookalikes the old `startsWith` check let through.
  assert.equal(isSameOrigin("pi-app://app.evil.com/x", APP_ORIGIN), false);
  assert.equal(isSameOrigin("pi-app://appevil/x", APP_ORIGIN), false);
  assert.equal(isSameOrigin("pi-app://app@evil.com/x", APP_ORIGIN), false);
  assert.equal(isSameOrigin("pi-app://app:1234/x", APP_ORIGIN), false);
  // Different scheme, same host.
  assert.equal(isSameOrigin("https://app/x", APP_ORIGIN), false);
  assert.equal(isSameOrigin("file:///app/x", APP_ORIGIN), false);
  assert.equal(isSameOrigin("javascript:alert(1)", APP_ORIGIN), false);
  assert.equal(isSameOrigin("not a url", APP_ORIGIN), false);
});

test("only http and https count as external links", () => {
  assert.equal(isHttpUrl("https://example.com/a"), true);
  assert.equal(isHttpUrl("http://example.com/a"), true);
  assert.equal(isHttpUrl("file:///etc/passwd"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("mailto:a@b.c"), false);
  assert.equal(isHttpUrl("data:text/html,<script>1</script>"), false);
  assert.equal(isHttpUrl("pi-app://app/index.html"), false);
});

test("window.open: export goes to preview, http(s) to the browser, rest denied", () => {
  assert.deepEqual(decideWindowOpen(exportUrl), { action: "preview", url: exportUrl });
  assert.deepEqual(decideWindowOpen("https://accounts.example.com/oauth"), {
    action: "external",
    url: "https://accounts.example.com/oauth",
  });
  assert.deepEqual(decideWindowOpen("http://localhost:9999/callback"), {
    action: "external",
    url: "http://localhost:9999/callback",
  });
  for (const blocked of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "ssh://host",
    "pi-app://app/index.html", // same-origin popup would inherit the bridge
    "pi-app://app/api/sessions/session-1/export", // not inline
    "pi-app://app.evil.com/api/sessions/session-1/export?inline=1",
  ]) {
    assert.equal(decideWindowOpen(blocked).action, "deny", blocked);
  }
});

test("main-window navigation: same-origin stays, export diverts, http(s) leaves, rest denied", () => {
  assert.deepEqual(decideNavigation(`${APP_ORIGIN}/index.html?session=abc`), { action: "allow" });
  assert.deepEqual(decideNavigation(exportUrl), { action: "preview", url: exportUrl });
  assert.deepEqual(decideNavigation("https://example.com/docs"), {
    action: "external",
    url: "https://example.com/docs",
  });
  for (const blocked of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "mailto:a@b.c",
    "pi-app://app.evil.com/index.html",
    "pi-app://app:1234/index.html",
  ]) {
    assert.equal(decideNavigation(blocked).action, "deny", blocked);
  }
});

test("the preview protocol only serves inline export GETs", () => {
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/session-1/export?inline=1"), true);
  assert.equal(isExportPreviewRequestAllowed("get", "/api/sessions/session-1/export?inline=1"), true);
  assert.equal(
    isExportPreviewRequestAllowed("GET", "/api/sessions/session-1/export?inline=1&leafId=a&targetId=b"),
    true,
  );
  // Wrong method.
  assert.equal(isExportPreviewRequestAllowed("POST", "/api/sessions/session-1/export?inline=1"), false);
  assert.equal(isExportPreviewRequestAllowed("DELETE", "/api/sessions/session-1/export?inline=1"), false);
  // Not inline.
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/session-1/export"), false);
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/session-1/export?inline=0"), false);
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/session-1/export?inline=1&inline=1"), false);
  // Unknown query key.
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/session-1/export?inline=1&x=2"), false);
  // Other API routes stay out of reach.
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions?inline=1"), false);
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/session-1/context?inline=1"), false);
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/session-1/export/extra?inline=1"), false);
  // Traversal / encoded separators in the id.
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/../export?inline=1"), false);
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/..%2F..%2Fetc/export?inline=1"), false);
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions/a%2Fb/export?inline=1"), false);
  assert.equal(isExportPreviewRequestAllowed("GET", "/api/sessions//export?inline=1"), false);
});

test("preview navigation is restricted to its own origin and export path", () => {
  assert.deepEqual(decidePreviewNavigation(`${PREVIEW_ORIGIN}/api/sessions/session-1/export?inline=1`), {
    action: "allow",
  });
  // Links clicked inside the untrusted page leave for the system browser.
  assert.deepEqual(decidePreviewNavigation("https://example.com/docs"), {
    action: "external",
    url: "https://example.com/docs",
  });
  for (const blocked of [
    `${APP_ORIGIN}/api/sessions/session-1/export?inline=1`,
    `${PREVIEW_ORIGIN}/index.html`,
    `${PREVIEW_ORIGIN}/api/sessions/session-1/context?inline=1`,
    "file:///etc/passwd",
    "javascript:alert(1)",
  ]) {
    assert.equal(decidePreviewNavigation(blocked).action, "deny", blocked);
  }
});

test("previewUrlFor moves an export onto the preview origin", () => {
  assert.equal(previewUrlFor(exportUrl), `${PREVIEW_ORIGIN}/api/sessions/session-1/export?inline=1`);
  assert.equal(
    previewUrlFor(`${APP_ORIGIN}/api/sessions/session-1/export?inline=1&leafId=l1`),
    `${PREVIEW_ORIGIN}/api/sessions/session-1/export?inline=1&leafId=l1`,
  );
  assert.equal(previewUrlFor("https://example.com/"), null);
  assert.equal(previewUrlFor(`${APP_ORIGIN}/api/sessions/session-1/export`), null);
  assert.equal(previewUrlFor("pi-app://app.evil.com/api/sessions/session-1/export?inline=1"), null);
});

test("preview CSP forbids the network and framing", () => {
  assert.match(EXPORT_PREVIEW_CSP, /default-src 'none'/);
  assert.match(EXPORT_PREVIEW_CSP, /connect-src 'none'/);
  assert.match(EXPORT_PREVIEW_CSP, /frame-src 'none'/);
  assert.match(EXPORT_PREVIEW_CSP, /object-src 'none'/);
  assert.match(EXPORT_PREVIEW_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(EXPORT_PREVIEW_CSP, /\*/);
});

test("main.ts uses the policy instead of the old prefix check", async () => {
  const source = await readFile(new URL("../desktop/main.ts", import.meta.url), "utf8");
  assert.match(source, /decideWindowOpen\(/);
  assert.match(source, /decideNavigation\(/);
  assert.match(source, /decidePreviewNavigation\(/);
  assert.match(source, /isExportPreviewRequestAllowed\(/);
  assert.doesNotMatch(source, /url\.startsWith\(APP_ORIGIN\)/);
  assert.doesNotMatch(source, /setWindowOpenHandler\(\(\{ url \}\) => \{\s*void shell\.openExternal\(url\)/);
});
