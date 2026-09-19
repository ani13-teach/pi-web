/**
 * Verifies the two riskiest native/runtime assumptions before anything else is
 * built on top of them:
 *   1. node-pty's shipped Windows binary loads and spawns a real PTY.
 *   2. The pi SDK can create a session and stream events.
 *
 * Run with plain Node: `node tests/smoke.mjs`
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- 1. node-pty ------------------------------------------------------------

let ptyModule = null;
try {
  ptyModule = require("node-pty");
  record("node-pty module loads", typeof ptyModule.spawn === "function");
} catch (error) {
  record("node-pty module loads", false, error instanceof Error ? error.message : String(error));
}

if (ptyModule) {
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
  const args = [];
  const command = process.platform === "win32" ? "for /l %i in (42,1,42) do @echo PI_PTY_%i\r\n" : "printf 'PI_PTY_%s\\n' 42\n";
  await new Promise((resolve) => {
    let output = "";
    let pty;
    let settled = false;
    const finish = (ok, detail) => {
      // Both the data and exit handlers can fire; only the first result counts.
      if (settled) return;
      settled = true;
      record("node-pty spawns a shell and returns output", ok, detail);
      resolve();
    };
    try {
      pty = ptyModule.spawn(shell, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: homedir(),
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (error) {
      finish(false, error instanceof Error ? error.message : String(error));
      return;
    }
    const timer = setTimeout(() => {
      try { pty.kill(); } catch { /* already gone */ }
      finish(false, `timeout, got: ${JSON.stringify(output.slice(0, 120))}`);
    }, 8000);
    pty.onData((data) => {
      output += data;
      if (output.includes("PI_PTY_42")) {
        clearTimeout(timer);
        try {
          pty.kill();
        } catch {
          /* ignore */
        }
        finish(true, `${output.length} chars from ${shell}`);
      }
    });
    pty.onExit(({ exitCode }) => {
      clearTimeout(timer);
      finish(output.includes("PI_PTY_OK"), `exit=${exitCode}`);
    });
    pty.write(command);
  });

  const conptyDll = new URL("../node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll", import.meta.url);
  record("conpty runtime present", existsSync(conptyDll), conptyDll.pathname);
}

// --- 2. pi SDK -------------------------------------------------------------

try {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const sessionManager = sdk.SessionManager.inMemory(homedir());
  const { session } = await sdk.createAgentSession({
    cwd: homedir(),
    sessionManager,
  });
  const seen = [];
  const unsubscribe = session.subscribe((event) => {
    seen.push(event.type);
  });
  record(
    "pi SDK creates a session",
    typeof session.sessionId === "string" && session.sessionId.length > 0,
    `id=${session.sessionId.slice(0, 8)} model=${session.model?.id ?? "none"} streaming=${session.isStreaming}`,
  );
  record(
    "pi SDK exposes messages + subscription",
    Array.isArray(session.state.messages) && typeof unsubscribe === "function",
    `messages=${session.state.messages.length}`,
  );
  unsubscribe();

  const agentDir = sdk.getAgentDir();
  const listed = await sdk.SessionManager.list(homedir());
  record("pi SDK reads the real session store", Array.isArray(listed), `${listed.length} sessions in ${agentDir}`);

  session.dispose();
} catch (error) {
  record("pi SDK creates a session", false, error instanceof Error ? error.stack?.split("\n")[0] : String(error));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
