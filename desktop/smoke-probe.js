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

  /**
   * The auto-mode model fields are pickers fed by `models.json` plus the registry,
   * and every model of every configured provider has to be on that list — those
   * gateways are not in pi's built-in catalog, which is the point of reading the
   * file. Choosing an entry has to reach the draft. The caller closes the dialog
   * without saving, so nothing is written to the real configuration.
   */
  const checkModelPickers = async (page) => {
    if (page.querySelector("datalist")) throw new Error("the model fields still offer a <datalist> hint list");
    const fields = [...page.querySelectorAll(".model-selector.is-field")];
    if (fields.length < 1) throw new Error("the form has no model picker");
    // While the two model sources are still being read the picker is disabled, so
    // wait for it instead of clicking into a button that ignores the click.
    const picker = await waitFor(() => {
      const button = page.querySelector(".model-selector.is-field button");
      return button && !button.disabled ? button : null;
    });
    if (!picker) throw new Error("the model picker stayed disabled");

    picker.click();
    const listbox = await waitFor(() => document.querySelector('[role="listbox"]'));
    if (!listbox) throw new Error("clicking the model field opened no list");
    const options = [...listbox.querySelectorAll('[role="option"]')];
    const labels = options.map((option) => option.querySelector("span[title]")?.title ?? option.innerText.trim());
    if (labels.length < 2) throw new Error(`the picker offers ${labels.length} entries`);

    // Every model of every provider in models.json has to be on that list, which
    // is the point of reading that file: those gateways are not in pi's own
    // catalog, and the whitelist that filters /api/models can hide them.
    const configured = await fetch("/api/models-config");
    const providers = configured.ok ? (await configured.json()).providers ?? {} : {};
    const missing = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      for (const model of Array.isArray(provider?.models) ? provider.models : []) {
        if (typeof model?.id !== "string" || !model.id.trim()) continue;
        const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id.trim();
        const expectedLabel = `${name} (${providerId})`;
        const match = options.find((option) => option.querySelector("span[title]")?.title === expectedLabel);
        // The tooltip alone must not pass: verify the channel is visible too.
        if (!match || match.querySelector("span[title]")?.lastElementChild?.textContent.trim() !== `(${providerId})`) {
          missing.push(`${providerId}/${model.id}`);
        }
      }
    }
    if (missing.length > 0) throw new Error(`models.json entries missing from the picker: ${missing.join(", ")}`);

    // Choosing an entry has to reach the draft. The entry that reads as the
    // current value is skipped — clicking it is a no-op by design — so take the
    // first one that says something else.
    const saveLabels = ["保存", "Save", "儲存"];
    const before = picker.innerText.trim();
    const choices = options.filter((option) => option.innerText.trim() !== before);
    if (choices.length === 0) throw new Error(`the picker only offers the current value (${before || "empty"})`);
    choices[0].click();
    const after = await waitFor(() => {
      const shown = picker.innerText.trim();
      if (shown !== before) return shown;
      // A renamed model can leave the label alone, so the unsaved-changes marker
      // is the second signal. Re-queried, because React may have replaced the node.
      const save = [...page.querySelectorAll("button")].find((button) => saveLabels.includes(button.textContent.trim()) && !button.disabled);
      return save ? shown : null;
    }, 5000);
    if (after === null) {
      throw new Error(`choosing "${choices[0].innerText.trim()}" left the draft untouched (the field stayed ${JSON.stringify(before)})`);
    }
    return { labels, before, after, fields: fields.length };
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
      body: JSON.stringify({ cwd: window.__piSmokeWorkspace || ".", cols: 80, rows: 24 }),
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

  // The fixture is loaded through the real reader and IPC; no model/tool is run.
  const subagentFixture = window.__piSmokeSubagentFixture;
  const transcript = () => document.querySelector(".chat-content .overflow-y-auto");
  const selectedId = () => new URLSearchParams(location.search).get("session");
  const contextMessages = async (id) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/context`);
    if (!response.ok) throw new Error(`context status ${response.status} for ${id}`);
    const context = await response.json();
    const messages = context.messages ?? context.context?.messages;
    if (!Array.isArray(messages)) throw new Error("fixture context has no messages");
    return messages;
  };
  const openProcess = async () => {
    const pane = transcript();
    if (!pane) throw new Error("no chat transcript");
    // Process children are unmounted when collapsed. Open them before checking
    // absence, otherwise a leaked card could pass simply by being collapsed.
    for (const button of pane.querySelectorAll('button[aria-expanded="false"]')) button.click();
    await sleep(200);
    return pane;
  };
  const expandTool = async (marker) => {
    const button = await waitFor(() => [...(transcript()?.querySelectorAll("button") ?? [])]
      .find((element) => element.textContent.includes(marker)), 5000);
    if (!button) throw new Error(`tool header missing: ${marker}`);
    button.click();
  };
  const assertQuietMain = async () => {
    if (!subagentFixture) throw new Error("no subagent fixture supplied by main");
    const answer = `Desktop fixture answer ${window.__piSmokeSessionId}`;
    if (!await waitFor(() => selectedId() === window.__piSmokeSessionId
      && transcript()?.innerText.includes(answer), 30000)) throw new Error("main fixture transcript did not load");
    await openProcess();
    if (!transcript()?.innerText.includes(subagentFixture.ordinaryResult)) await expandTool(subagentFixture.ordinaryTool);
    if (!await waitFor(() => transcript()?.innerText.includes(subagentFixture.ordinaryResult), 5000)) {
      throw new Error("the ordinary read card/result was lost in main chat");
    }
    const pane = transcript();
    const forbidden = [subagentFixture.legacyControl, subagentFixture.nativeControl, subagentFixture.notification];
    for (const marker of forbidden) {
      if (pane.textContent.includes(marker)) throw new Error(`internal activity leaked into main chat: ${marker}`);
    }
    if ([...pane.querySelectorAll("button")].some((button) => button.textContent.trim().startsWith("Agent"))) {
      throw new Error("an Agent control header remains in main chat");
    }
    return "native and historical cards + completion notice hidden; ordinary read result preserved";
  };
  const assertOrdinarySidebar = () => {
    if (!subagentFixture) throw new Error("no subagent fixture supplied by main");
    const sidebar = document.querySelector("#session-sidebar");
    const mainTitle = `Desktop smoke session ${window.__piSmokeSessionId}`.slice(0, 50);
    if (!sidebar || !sidebar.textContent.includes(mainTitle)) {
      throw new Error("main fixture is not in the ordinary sidebar");
    }
    if (sidebar.textContent.includes(subagentFixture.childTitle.slice(0, 50))
      || sidebar.textContent.includes(subagentFixture.description.slice(0, 50))) throw new Error("child fixture leaked into the ordinary sidebar");
    return "main row present, child title/task absent in the same workspace";
  };

  await record("subagent smoke fixtures retain provenance and completion data through IPC", async () => {
    if (!subagentFixture) throw new Error("no subagent fixture supplied by main");
    const child = sessions.find((session) => session.id === subagentFixture.childId);
    if (child?.relation?.kind !== "subagent" || child.relation.parentSessionId !== window.__piSmokeSessionId
      || child.relation.status !== "completed" || child.firstMessage !== subagentFixture.childTitle) {
      throw new Error("child session was not read as a completed subagent of the main fixture");
    }
    const messages = await contextMessages(window.__piSmokeSessionId);
    const blocks = messages.filter((message) => message.role === "assistant").flatMap((message) => message.content ?? []);
    const legacy = blocks.find((block) => block.type === "toolCall" && block.input?.prompt === subagentFixture.legacyControl);
    const native = blocks.find((block) => block.type === "toolCall" && block.input?.prompt === subagentFixture.nativeControl);
    if (!legacy || legacy.displayOrigin || legacy.toolName !== "Agent"
      || !messages.some((message) => message.role === "toolResult" && message.toolCallId === legacy.toolCallId
        && message.details?.kind === "pi-subagents")) throw new Error("historical Agent/result provenance missing");
    if (native?.displayOrigin !== "pi-subagents" || native.toolName !== "Agent") throw new Error("native Agent provenance missing");
    if (!messages.some((message) => message.role === "custom" && message.customType === "subagent-notification"
      && message.display === true && message.content === subagentFixture.notification)) throw new Error("main completion notification missing from context");
    const childMessages = await contextMessages(subagentFixture.childId);
    if (!childMessages.some((message) => message.role === "assistant" && message.content?.some((block) =>
      block.type === "toolCall" && block.toolName === "Agent" && block.displayOrigin === "pi-subagents"
        && block.input?.prompt === subagentFixture.childControl))) throw new Error("child native control provenance missing");
    for (const marker of [subagentFixture.childProcess, subagentFixture.childControlResult, subagentFixture.childTool,
      subagentFixture.childToolResult, subagentFixture.childNotification, subagentFixture.childAnswer]) {
      if (!JSON.stringify(childMessages).includes(marker)) throw new Error(`child fixture marker missing from context: ${marker}`);
    }
    return "completed child relation, historical/native controls and notifications preserved in stored context";
  });
  await record("main chat hides subagent cards and completion notices", assertQuietMain);
  await record("ordinary sidebar excludes the fixture subagent", assertOrdinarySidebar);

  await record("top Agents opens the complete child process and returns to a quiet main chat", async () => {
    if (!subagentFixture) throw new Error("no subagent fixture supplied by main");
    const agentsButton = () => document.querySelector('button[aria-label="Agents"][aria-pressed]');
    const panel = () => document.querySelector('[role="listbox"][aria-label="Agents"]');
    const row = (marker) => [...(panel()?.querySelectorAll('[role="option"]') ?? [])]
      .find((option) => [...option.querySelectorAll("[title]")].some((node) => node.title === marker));
    const openAgents = async () => {
      const button = await waitFor(agentsButton);
      if (!button) throw new Error("top Agents button missing");
      if (button.getAttribute("aria-pressed") !== "true") button.click();
      if (!await waitFor(() => agentsButton()?.getAttribute("aria-pressed") === "true" && panel())) {
        throw new Error("Agents did not enter its pressed/open state");
      }
    };
    try {
      const button = await waitFor(agentsButton);
      if (!button || button.getAttribute("aria-pressed") !== "false" || panel()) throw new Error("Agents must start closed");
      await openAgents();
      const childRow = row(subagentFixture.description);
      const mainRow = row(`Desktop smoke session ${window.__piSmokeSessionId}`);
      if (!childRow || !mainRow || childRow.getAttribute("aria-selected") !== "false"
        || mainRow.getAttribute("aria-selected") !== "true") throw new Error("Agents family rows/initial selection are wrong");
      if (!["已完成", "Completed"].some((label) => childRow.innerText.includes(label))) throw new Error("child completion status not shown in Agents");
      agentsButton().click();
      if (!await waitFor(() => agentsButton()?.getAttribute("aria-pressed") === "false" && !panel())) throw new Error("Agents toggle did not close its panel");
      await openAgents();
      row(subagentFixture.description).click();
      if (!await waitFor(() => selectedId() === subagentFixture.childId
        && transcript()?.innerText.includes(subagentFixture.childAnswer), 30000)) throw new Error("Agents click did not open the child transcript");
      await openAgents();
      if (row(subagentFixture.description)?.getAttribute("aria-selected") !== "true"
        || row(`Desktop smoke session ${window.__piSmokeSessionId}`)?.getAttribute("aria-selected") !== "false") {
        throw new Error("Agents selection did not follow navigation to the child");
      }
      assertOrdinarySidebar();
      await openProcess();
      await expandTool(subagentFixture.childControl);
      await expandTool(subagentFixture.childTool);
      const expected = [subagentFixture.childTitle, subagentFixture.childProcess, subagentFixture.childControl,
        subagentFixture.childControlResult, subagentFixture.childTool, subagentFixture.childToolResult,
        subagentFixture.childNotification, subagentFixture.childAnswer];
      if (!await waitFor(() => expected.every((marker) => transcript()?.innerText.includes(marker)), 5000)) {
        throw new Error(`child process incomplete: ${expected.filter((marker) => !transcript()?.innerText.includes(marker)).join(", ")}`);
      }
      await openAgents();
      row(`Desktop smoke session ${window.__piSmokeSessionId}`).click();
      await assertQuietMain();
      await openAgents();
      if (row(`Desktop smoke session ${window.__piSmokeSessionId}`)?.getAttribute("aria-selected") !== "true"
        || row(subagentFixture.description)?.getAttribute("aria-selected") !== "false") throw new Error("Agents selection did not return to main");
      assertOrdinarySidebar();
      return "toggle/open and completed status verified; child text, native Agent, read results and notice visible; main stays quiet after return";
    } finally {
      // Keep later layout/settings probes on the main fixture even if a child assertion fails.
      if (selectedId() !== window.__piSmokeSessionId) {
        await openAgents();
        const mainRow = row(`Desktop smoke session ${window.__piSmokeSessionId}`);
        if (!mainRow) throw new Error("cannot restore main fixture from Agents");
        mainRow.click();
        if (!await waitFor(() => selectedId() === window.__piSmokeSessionId
          && transcript()?.innerText.includes(`Desktop fixture answer ${window.__piSmokeSessionId}`), 30000)) throw new Error("main restore did not load");
      }
      if (agentsButton()?.getAttribute("aria-pressed") === "true") agentsButton().click();
      if (!await waitFor(() => !panel() && agentsButton()?.getAttribute("aria-pressed") === "false")) throw new Error("Agents panel stayed open after cleanup");
    }
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

  // Inspect editable fields and layout in the real dialog, without saving.
  // Close it afterwards so the following chat-layout probe stays independent.
  await record("the auto-mode form is compact and fills its settings pane", async () => {
    const response = await fetch("/api/automode");
    if (!response.ok) throw new Error(`automode status ${response.status}`);
    const automode = await response.json();

    const settingsLabels = ["设置", "Settings", "設定"];
    const openButton = [...document.querySelectorAll("button[aria-label]")]
      .find((button) => settingsLabels.includes(button.getAttribute("aria-label")));
    if (!openButton) throw new Error("no settings button in the sidebar");
    openButton.click();

    const dialog = await waitFor(() => document.querySelector(".settings-dialog-surface"));
    if (!dialog) throw new Error("the settings dialog did not open");

    const tabLabels = ["自动模式", "Auto mode", "自動模式"];
    const tabs = [...dialog.querySelectorAll("button")];
    const tab = tabs.find((button) => tabLabels.includes(button.textContent.trim()));
    if (!tab) throw new Error(`no auto-mode tab; saw: ${tabs.map((b) => b.textContent.trim()).filter(Boolean).slice(0, 8).join(", ")}`);
    tab.click();

    const page = await waitFor(() => {
      const form = dialog.querySelector(".automode-settings");
      return form?.querySelector('input[type="number"]') ? form : null;
    });
    if (!page) throw new Error("the auto-mode form did not load");

    // A number field shows the value the global file sets, or the value in force
    // when that file sets nothing (draftFrom fills the inherited value in).
    const numbers = [...page.querySelectorAll('input[type="number"]')];
    if (numbers.length !== 4 || numbers.some((input) => !/^\d+$/.test(input.value) || Number(input.value) <= 0)) {
      throw new Error(`expected four positive number fields, saw: ${numbers.map((input) => input.value).join(", ") || "none"}`);
    }
    const globalTimeout = automode.global.values.classifierTimeoutMs;
    if (typeof globalTimeout === "number" && numbers[0].value !== String(globalTimeout)) {
      throw new Error(`the timeout field shows ${numbers[0].value}, the global file says ${globalTimeout}`);
    }
    if (page.querySelector("table, dl") || page.innerText.includes(automode.paths.global)) {
      throw new Error("runtime diagnostics or file paths are still in the form");
    }
    const scope = page.querySelector(".automode-scope select");
    if (scope?.value !== "global" || scope.options.length !== 2) {
      throw new Error("the scope picker is missing");
    }

    const host = page.parentElement;
    const measure = () => {
      const pane = host.getBoundingClientRect();
      const form = page.getBoundingClientRect();
      const style = getComputedStyle(page);
      if (Math.abs(pane.left - form.left) > 1 || Math.abs(pane.right - form.right) > 1) {
        throw new Error(`the scroll area does not fill the pane: ${Math.round(form.width)}/${Math.round(pane.width)} px`);
      }
      if (style.overflowY !== "auto") throw new Error("the form needs its own scroll area");
      if (style.paddingLeft !== style.paddingRight) throw new Error("the form insets are not equal");
      if (page.scrollWidth > page.clientWidth + 1) throw new Error("the form overflows horizontally");
      // clientWidth excludes the scrollbar, so this is the area a row may fill.
      const right = form.left + page.clientWidth - parseFloat(style.paddingRight);
      const content = page.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const rows = [...page.querySelectorAll(".settings-chat-options")];
      if (rows.length === 0) throw new Error("the form has no switch rows");
      // A row that stops short of the right edge is the empty column the user reported.
      for (const row of rows) {
        const width = row.getBoundingClientRect().width;
        if (Math.abs(width - content) > 1) {
          throw new Error(`a switch row is ${Math.round(width)} px wide, the content area is ${Math.round(content)} px`);
        }
      }
      for (const control of page.querySelectorAll("input, select, textarea, button")) {
        const rect = control.getBoundingClientRect();
        if (rect.width <= 0 || rect.left < form.left || rect.right > right + 1) {
          throw new Error("a form control extends outside the content area");
        }
      }
      return Math.round(form.width);
    };
    const widths = [measure()];
    const originalStyle = host.getAttribute("style");
    try {
      host.style.flex = "none";
      host.style.width = "min(480px, 100%)";
      widths.push(measure());
    } finally {
      if (originalStyle === null) host.removeAttribute("style");
      else host.setAttribute("style", originalStyle);
    }
    if (!(widths[1] < widths[0])) {
      throw new Error(`the narrow measurement did not change the width: ${widths.join(" / ")} px`);
    }

    // The model fields are pickers fed by `models.json` plus the registry, not
    // free-text boxes with a hint list. The dialog is closed without saving, so
    // nothing is written to the real configuration.
    const pickerOutcome = await Promise.race([
      checkModelPickers(page),
      sleep(30_000).then(() => "the model picker checks did not settle within 30s"),
    ]);
    if (typeof pickerOutcome === "string") throw new Error(pickerOutcome);
    const { labels, before, after, fields } = pickerOutcome;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const closed = await waitFor(() => !document.querySelector(".settings-dialog-surface"));
    if (!closed) throw new Error("the settings dialog stayed open");
    return `form widths ${widths.join(" / ")} px; switch rows reach the right edge; global timeout ${globalTimeout ?? "unset"}; ${fields} model pickers, ${labels.length} entries covering models.json; choosing one turned "${before || "empty"}" into "${after || "empty"}"`;
  });

  await record("built-in agents are editable through the shared configuration form", async () => {
    const openButton = [...document.querySelectorAll("button[aria-label]")]
      .find((button) => ["设置", "Settings", "設定"].includes(button.getAttribute("aria-label")));
    if (!openButton) throw new Error("no settings button");
    openButton.click();
    try {
      const dialog = await waitFor(() => document.querySelector(".settings-dialog-surface"));
      if (!dialog) throw new Error("settings dialog did not open");
      const tab = [...dialog.querySelectorAll("button")]
        .find((button) => ["子代理", "Sub-agents"].includes(button.textContent.trim()));
      if (!tab) throw new Error("no sub-agents tab");
      tab.click();
      const group = await waitFor(() => [...dialog.querySelectorAll(".config-sidebar-group")]
        .find((element) => ["内置", "內建", "built-in"].includes(element.querySelector(".config-sidebar-group-label")?.textContent.trim())));
      if (!group) throw new Error("no built-in profiles");
      const buttons = [...group.querySelectorAll(".config-sidebar-item")];
      const expectedNames = ["plan", "review", "work", "scout", "test"];
      if (buttons.length !== expectedNames.length) throw new Error(`expected ${expectedNames.length} built-in presets, saw ${buttons.length}`);
      const seen = new Set();
      for (const button of buttons) {
        button.click();
        const detail = await waitFor(() => button.getAttribute("aria-current") === "page" && dialog.querySelector(".config-detail textarea"));
        if (!detail || detail.disabled) throw new Error("the built-in prompt is read-only");
        const pane = detail.closest(".config-detail");
        for (const control of pane.querySelectorAll("input, select, textarea")) {
          if (control.disabled) throw new Error(`a built-in field is disabled: ${control.getAttribute("aria-label") ?? control.type}`);
        }
        const scopeField = [...pane.querySelectorAll(".config-field")]
          .find((field) => ["保存到", "儲存至", "Save to"].includes(field.querySelector(".config-field-label")?.textContent.trim()));
        if (scopeField) throw new Error("existing built-ins must edit their own scope directly");
        const idInput = pane.querySelector('input[aria-label="子代理 ID"], input[aria-label="Sub-agent ID"]');
        const id = idInput?.value;
        if (!idInput || idInput.disabled || !expectedNames.includes(id) || seen.has(id)) throw new Error(`unexpected, repeated or read-only identity: ${id}`);
        seen.add(id);
        const remove = [...pane.querySelectorAll("button")]
          .find((item) => ["删除", "刪除", "Delete"].includes(item.textContent.trim()));
        if (!remove || remove.disabled) throw new Error("a built-in preset has no enabled delete action");
        const save = [...dialog.querySelectorAll(".config-footer button")]
          .find((item) => ["保存", "儲存", "Save"].includes(item.textContent.trim()));
        if (!save || save.disabled) throw new Error("a built-in profile has no enabled save action");
        // Change only the draft ID, then reselect to discard it. Never click Save,
        // Delete or the enabled switch: this probe must not write configuration.
        const changedId = `${id}-smoke-draft`;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(idInput, changedId);
        idInput.dispatchEvent(new Event("input", { bubbles: true }));
        if (!await waitFor(() => pane.querySelector('input[aria-label="子代理 ID"], input[aria-label="Sub-agent ID"]')?.value === changedId)) throw new Error("the ID input did not accept draft edits");
        // Force another render to confirm the edited ID reached React state.
        const displayInput = pane.querySelector('input[aria-label="显示名称"], input[aria-label="顯示名稱"], input[aria-label="Display name"]');
        if (!displayInput) throw new Error("the display-name input is missing");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(displayInput, `${displayInput.value} smoke draft`);
        displayInput.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(200);
        if (idInput.value !== changedId) throw new Error("the edited ID was not retained in the draft");
        button.click();
        if (!await waitFor(() => idInput.value === id)) throw new Error("reselecting did not discard the draft ID");
      }
      if (expectedNames.some((name) => !seen.has(name))) throw new Error("a built-in preset was not checked");
      const create = [...dialog.querySelectorAll(".config-list-action-button")]
        .find((item) => ["新建子代理", "新增子代理", "New sub-agent"].includes(item.textContent.trim()));
      if (!create) throw new Error("no new sub-agent action");
      create.click();
      const scopeField = await waitFor(() => [...dialog.querySelectorAll(".config-detail .config-field")]
        .find((field) => ["保存到", "儲存至", "Save to"].includes(field.querySelector(".config-field-label")?.textContent.trim())));
      const scopes = scopeField ? [...scopeField.querySelectorAll("button")] : [];
      const scopeLabels = [["内置", "內建", "built-in"], ["全局", "全域", "global"], ["项目", "專案", "project"]];
      if (scopes.length !== 3 || scopes.some((scope, index) => scope.disabled || !scopeLabels[index].includes(scope.textContent.trim()))) throw new Error("creation must offer built-in, global and project scopes");
      if (scopes[0].getAttribute("aria-pressed") !== "true" || !dialog.querySelector(".config-detail-path")?.textContent.includes("desktop-agents/")) throw new Error("new agents must default to built-in storage");
      const paths = ["desktop-agents/", ".pi/agent/agents/", "./.pi/agents/"];
      for (let index = 0; index < scopes.length; index++) {
        scopes[index].click();
        if (!await waitFor(() => scopes[index].getAttribute("aria-pressed") === "true" && dialog.querySelector(".config-detail-path")?.textContent.includes(paths[index]))) throw new Error("the creation target path does not match its selected scope");
      }
      return "five presets expose editable IDs, direct built-in editing and delete actions; creation defaults to built-in and offers three scopes; no configuration writes";
    } finally {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (!await waitFor(() => !document.querySelector(".settings-dialog-surface"))) throw new Error("settings dialog stayed open");
    }
  });

  await record("Code Mode has a loaded global switch in general settings", async () => {
    const openButton = [...document.querySelectorAll("button[aria-label]")]
      .find((button) => ["设置", "Settings", "設定"].includes(button.getAttribute("aria-label")));
    if (!openButton) throw new Error("no settings button");
    openButton.click();
    try {
      const dialog = await waitFor(() => document.querySelector(".settings-dialog-surface"));
      if (!dialog) throw new Error("settings dialog did not open");
      const tab = [...dialog.querySelectorAll("button")]
        .find((button) => ["常规", "General", "一般"].includes(button.textContent.trim()));
      if (!tab) throw new Error("no general settings tab");
      tab.click();
      const control = await waitFor(() => {
        const heading = [...dialog.querySelectorAll("h3")].find((element) => element.textContent.trim() === "Code Mode");
        const toggle = heading?.closest("section")?.querySelector('[role="switch"]');
        return toggle && !toggle.disabled ? toggle : null;
      });
      if (!control) throw new Error("Code Mode switch is missing or did not load");
      const response = await fetch("/api/tools/codemode");
      const data = await response.json();
      if (!response.ok || typeof data.enabled !== "boolean") throw new Error("Code Mode settings API did not return a preference");
      if (control.getAttribute("aria-checked") !== String(data.enabled)) throw new Error("Code Mode switch does not reflect the stored preference");
      return "global preference loaded over IPC; switch matches the API; no configuration writes";
    } finally {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (!await waitFor(() => !document.querySelector(".settings-dialog-surface"))) throw new Error("settings dialog stayed open");
    }
  });

  await record("the backup page requires a password and defaults to no private data", async () => {
    const openButton = [...document.querySelectorAll("button[aria-label]")]
      .find((button) => ["设置", "Settings", "設定"].includes(button.getAttribute("aria-label")));
    if (!openButton) throw new Error("no settings button");
    openButton.click();
    const dialog = await waitFor(() => document.querySelector(".settings-dialog-surface"));
    if (!dialog) throw new Error("settings dialog did not open");
    const tab = [...dialog.querySelectorAll("button")]
      .find((button) => ["备份", "Backup", "備份"].includes(button.textContent.trim()));
    if (!tab) throw new Error("no backup tab");
    tab.click();
    const page = await waitFor(() => {
      const heading = [...dialog.querySelectorAll("h2")]
        .find((element) => ["备份", "Backup", "備份"].includes(element.textContent.trim()));
      return heading?.parentElement ?? null;
    });
    if (!page) throw new Error("backup page did not load");
    const privacy = page.querySelector('[role="switch"]');
    if (privacy?.getAttribute("aria-checked") !== "false") throw new Error("private backup must default to no");
    if (page.querySelectorAll('input[type="password"]').length !== 3)
      throw new Error("export confirmation and import password inputs are missing");
    const actions = [...page.querySelectorAll("button")].filter((button) =>
      ["选择保存位置并导出", "Choose save location and export", "選擇儲存位置並匯出", "选择备份文件并预览", "Choose backup file and preview", "選擇備份檔案並預覽"].includes(button.textContent.trim()));
    if (actions.length !== 2 || actions.some((button) => !button.disabled))
      throw new Error("backup actions must require passwords");
    privacy.click();
    if (!await waitFor(() => page.querySelectorAll('[role="switch"]').length === 4))
      throw new Error("private backup options are missing");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (!await waitFor(() => !document.querySelector(".settings-dialog-surface")))
      throw new Error("settings dialog stayed open");
    return "private backup defaults off; both actions require passwords; optional private categories appear only after consent";
  });

  return results;
})();
