/**
 * Window smoke probe.
 *
 * Executed inside the real renderer with `webContents.executeJavaScript`, so it
 * exercises the exact chain a user hits: the ported pi-web UI -> fetch/EventSource
 * shims -> preload -> main -> backend. It runs in the page's main world, where
 * only the preload bridge is available.
 *
 * Written as a plain file (rather than an inline string in main.ts) so it can be
 * read and formatted normally.
 */

(async () => {
  const results = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const record = async (name, run) => {
    try {
      const value = await run();
      results.push({
        name,
        ok: value !== false && value !== null && value !== undefined,
        detail: value === true ? "" : String(value),
      });
    } catch (error) {
      results.push({ name, ok: false, detail: error && error.message ? error.message : String(error) });
    }
  };

  const waitFor = async (check, timeoutMs = 15000) => {
    const started = Date.now();
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() - started > timeoutMs) return null;
      await sleep(200);
    }
  };

  await record("renderer loads from the pi-app scheme", () => location.protocol === "pi-app:" && location.host === "app");
  await record("React mounted a UI", () => document.querySelector("#root")?.childElementCount > 0);
  await record("preload bridge is exposed", () => typeof window.piDesktop?.invoke === "function");
  await record("renderer cannot reach Node", () => typeof require === "undefined" && typeof process === "undefined");
  await record("the window is locked down by a CSP", () => {
    // script-src has no 'unsafe-eval', so this must throw if the header arrived.
    try {
      new Function("return 1")();
      throw new Error("eval was allowed; the CSP header is missing");
    } catch (error) {
      if (String(error).includes("CSP header is missing")) throw error;
      return `eval blocked (${error.name})`;
    }
  });
  await record("localStorage is available on this origin", () => {
    localStorage.setItem("smoke", "1");
    const stored = localStorage.getItem("smoke");
    localStorage.removeItem("smoke");
    return stored === "1";
  });

  // --- the ported API, reached through the fetch shim ------------------------
  let sessions = [];
  await record("fetch('/api/sessions') answers through the bridge", async () => {
    const response = await fetch("/api/sessions");
    if (!response.ok) throw new Error(`status ${response.status}`);
    const data = await response.json();
    sessions = data.sessions ?? [];
    return `${sessions.length} sessions, content-type=${response.headers.get("content-type")}`;
  });

  await record("fetch('/api/models') answers through the bridge", async () => {
    const response = await fetch("/api/models");
    if (!response.ok) throw new Error(`models status ${response.status}`);
    const data = await response.json();
    const models = data.modelList ?? data.models;
    if (!Array.isArray(models)) throw new Error("models response has no list");
    return `${models.length} models available`;
  });

  await record("the bundled npx reports its version", async () => {
    const probe = await window.piDesktop.invoke("npx.probe", {});
    if (!probe.ok) throw new Error(probe.error ?? "npx probe failed");
    return `npx ${probe.version}`;
  });

  // --- streaming, in the page -------------------------------------------------
  await record("EventSource streams agent events through the bridge", async () => {
    const session = sessions.find((entry) => entry.id === window.__piSmokeSessionId);
    if (!session) throw new Error("no session to subscribe to");
    const source = new EventSource(`/api/agent/${encodeURIComponent(session.id)}/events`);
    try {
      const event = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no event within 20s")), 20000);
        source.onmessage = (message) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(message.data));
          } catch (error) {
            reject(error);
          }
        };
        source.onerror = () => {
          clearTimeout(timer);
          reject(new Error("stream errored"));
        };
      });
      if (event.type !== "connected") throw new Error(`unexpected first event: ${event.type}`);
      return `first event type=${event.type}`;
    } finally {
      source.close();
    }
  });

  await record("a terminal round-trips through fetch + EventSource", async () => {
    const created = await fetch("/api/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: ".", cols: 80, rows: 24 }),
    });
    const { id, error } = await created.json();
    if (!id) throw new Error(error ?? `terminal create failed (${created.status})`);

    const source = new EventSource(`/api/terminal/${encodeURIComponent(id)}/events`);
    let output = "";
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === "output") output += event.data;
      } catch {
        // ignore malformed frames
      }
    };

    const newline = String.fromCharCode(13, 10);
    // cmd expands %i after the shell echoes the command, so this marker appears
    // only in the command's output — never in the echo of what we typed.
    const outputMarker = "PI_UI_42";
    await fetch(`/api/terminal/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "input", data: `for /l %i in (42,1,42) do @echo PI_UI_%i${newline}` }),
    });

    const seen = await waitFor(() => output.includes(outputMarker), 20000);
    source.close();
    const keep = window.__piSmokeKeepTerminal !== false;
    if (!keep) await fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!seen) throw new Error(`no shell output, saw ${output.length} bytes`);
    return keep
      ? `${output.length} bytes of terminal output, terminal left open for the exit check`
      : `${output.length} bytes of terminal output, terminal deleted`;
  });

  // --- the real interface ------------------------------------------------------
  // Which sessions the sidebar lists depends on the user's own store and on
  // project grouping, so these checks work with whichever listed session is on
  // screen rather than assuming a particular one, and then verify the data
  // behind the row.
  const titleOf = (entry) => (entry.firstMessage ?? "").trim();
  const listedSession = () => sessions.find(
    (entry) => entry.id === window.__piSmokeSessionId && document.body.innerText.includes(titleOf(entry)),
  );

  await record("the sidebar lists sessions that exist on disk", async () => {
    const found = await waitFor(() => listedSession() ?? null, 30000);
    if (!found) throw new Error(`none of the ${sessions.length} sessions on disk is listed`);
    return `"${titleOf(found)}" listed, ${sessions.length} sessions on disk`;
  });

  await record("clicking a session opens it", async () => {
    const session = listedSession();
    if (!session) throw new Error("no listed session to click");
    const needle = titleOf(session);

    const row = [...document.querySelectorAll("div,button,li")]
      .filter((element) => element.innerText?.includes(needle))
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!row) throw new Error(`could not find the row for "${needle}"`);

    row.click();
    const opened = await waitFor(() => {
      const id = new URLSearchParams(location.search).get("session");
      return id === session.id ? id : null;
    });
    if (!opened) throw new Error(`url never selected the session (still ${location.search})`);
    if (opened !== session.id) throw new Error(`clicking opened ${opened}, not the listed ${session.id}`);

    // The transcript for that session has to come from /api/sessions/[id]/context.
    const context = await (await fetch(`/api/sessions/${encodeURIComponent(opened)}/context`)).json();
    const messages = context.messages?.length ?? context.context?.messages?.length ?? 0;
    if (messages === 0) throw new Error("the opened session came back with no messages");
    return `opened ${opened.slice(0, 12)}…, ${messages} messages in context`;
  });

  await record("the transcript renders in the chat pane", async () => {
    const id = new URLSearchParams(location.search).get("session");
    if (!id) throw new Error("no selected session");
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/context`);
    if (!response.ok) throw new Error(`context status ${response.status}`);
    const context = await response.json();
    const messages = context.messages ?? context.context?.messages;
    if (!Array.isArray(messages)) throw new Error("context has no messages array");
    // Long conversations load their latest messages first. The sidebar title
    // comes from the first message and need not exist in the rendered window.
    const samples = messages.filter((message) => message.role === "assistant")
      .slice(-10).flatMap((message) => Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "text").map((block) => block.text)
        : []).filter((text) => typeof text === "string" && text.trim().length > 12)
      .map((text) => text.replace(/\s+/g, " ").trim().slice(0, 60));
    if (!samples.length) throw new Error("no recent assistant text to check");
    const shown = await waitFor(() => {
      const nodes = document.querySelectorAll('[data-message-role="assistant"] [data-message-text]');
      return [...nodes].some((node) => samples.some((sample) =>
        node.textContent.replace(/\s+/g, " ").includes(sample)));
    }, 40000);
    if (!shown) throw new Error("recent assistant text not found in the chat pane");
    return "recent assistant content matches the selected session";
  });

  // The file viewer renders previews in an iframe (PDF and documents by URL,
  // HTML by srcdoc). The page policy therefore has to allow frames from this
  // origin, or every preview shows up blank.
  //
  // A blocked frame still fires `load` (Chromium puts an error page inside), so
  // this reads the frame's document instead of trusting the event.
  await record("a same-origin API response is readable inside an iframe", async () => {
    const frame = document.createElement("iframe");
    frame.src = "/api/models";
    frame.style.cssText = "width:2px;height:2px";
    document.body.appendChild(frame);
    try {
      const loaded = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        frame.addEventListener("load", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!loaded) throw new Error("the frame never loaded at all");
      let text = "";
      try {
        text = frame.contentDocument?.body?.textContent ?? "";
      } catch (error) {
        throw new Error(`the frame document is not readable: ${String(error)}`);
      }
      if (!text.includes("model")) {
        throw new Error(`the frame shows no content (${JSON.stringify(text.slice(0, 60))}) — a blocked frame looks like this`);
      }
      return `${text.length} bytes inside the frame`;
    } finally {
      frame.remove();
    }
  });

  // The bar is injected above the ported UI and must stay out of the way
  // whenever the backend is fine; the crash scenario covers the other state.
  await record("no recovery bar while the backend is running", () =>
    document.querySelector('[data-backend-recovery="down"]') === null);

  return results;
})();
