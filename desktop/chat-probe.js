/**
 * Chat round-trip probe.
 *
 * Executed inside the real renderer with `webContents.executeJavaScript`, after
 * the window has been opened on a pre-created test session. It drives the path a
 * user actually takes: type into the composer -> click Send -> watch the answer
 * stream in -> click Stop -> wait for the composer to come back -> send a second
 * message -> read the second answer out of the transcript.
 *
 * window.__piChatSessionId identifies a pre-created test session. The UI may
 * replace its id when the first prompt is sent, so state reads follow the URL.
 * The caller owns creation, export verification and cleanup. Every wait has a
 * deadline, and a real model is required for the continuation answer.
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

  // --- wiring -----------------------------------------------------------------
  const sessionId = typeof window.__piChatSessionId === "string" && window.__piChatSessionId.trim()
    ? window.__piChatSessionId.trim()
    : null;

  if (!sessionId) {
    return [{
      name: "the probe is wired to a test session",
      ok: false,
      detail: "window.__piChatSessionId is missing — set it before evaluating this file, like smoke-probe.js does with window.__piSmokeKeepTerminal",
    }];
  }

  // --- the strings the UI is expected to render (lib/i18n/messages) -----------
  const SEND_LABELS = ["Send", "发送", "傳送"];                    // chat.send
  const STOP_TITLES = ["Stop agent", "停止 Agent"];                 // chat.stopAgent
  const STOP_LABELS = ["Stop", "停止"];                            // chat.stop
  const COPY_TITLES = ["Copy message", "复制消息", "複製訊息"];      // i18n.copyMessage
  const COMPOSER_SELECTOR = ".chat-content textarea.chat-input-textarea";

  const ANSWER = "UI_CONTINUE_OK";
  const LONG_PROMPT = [
    "请只输出正文，不要调用任何工具，也不要输出思考过程。",
    "写一篇中文说明文，严格分成 12 段，每段以「段落一」到「段落十二」开头，每段不少于 80 字，段与段之间空一行。",
    "必须一口气把 12 段全部写完，中途不要总结、不要省略、不要提前收尾。",
  ].join("\n");
  const CONTINUE_PROMPT = "只回复一行文本：UI_CONTINUE_OK（不要任何解释，不要调用工具）。";

  // --- deadlines --------------------------------------------------------------
  const TOTAL_BUDGET_MS = 420000;
  const NAV_TIMEOUT_MS = 15000;
  const TYPING_TIMEOUT_MS = 5000;
  const SEND_EFFECT_TIMEOUT_MS = 20000;
  const STREAMING_TIMEOUT_MS = 15000;
  const STOP_EFFECT_TIMEOUT_MS = 30000;
  const RECOVERY_TIMEOUT_MS = 30000;
  const SECOND_ANSWER_TIMEOUT_MS = 180000;

  const startedAt = Date.now();
  const remainingBudget = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - startedAt));

  /** Polls `check` until it returns something truthy or the (clamped) deadline passes. */
  const waitUntil = async (check, timeoutMs, pollMs = 200) => {
    const until = Date.now() + Math.min(timeoutMs, remainingBudget());
    for (;;) {
      let value = null;
      try {
        value = await check();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() >= until) return null;
      await sleep(pollMs);
    }
  };

  // --- DOM readers ------------------------------------------------------------
  const composerEl = () => document.querySelector(COMPOSER_SELECTOR);
  const rowButton = () => composerEl()?.parentElement?.querySelector(":scope > button") ?? null;
  const rowButtonLabel = () => {
    const button = rowButton();
    return button ? button.textContent.trim() : null;
  };
  const sendButton = () => {
    const button = rowButton();
    return button && SEND_LABELS.includes(button.textContent.trim()) ? button : null;
  };
  const stopButton = () => {
    const candidates = [...document.querySelectorAll(".chat-content button")];
    return candidates.find((button) => STOP_TITLES.includes(button.getAttribute("title") ?? ""))
      ?? candidates.find((button) => STOP_LABELS.includes(button.textContent.trim()))
      ?? null;
  };
  const assistantText = () => [...document.querySelectorAll('[data-message-role="assistant"] [data-message-text]')]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const copyButtonIn = (container) => [...container.querySelectorAll("button")]
    .find((button) => COPY_TITLES.includes(button.getAttribute("title") ?? ""));

  const typeIntoComposer = (text) => {
    const textarea = composerEl();
    if (!textarea) throw new Error(`no composer on the page (${COMPOSER_SELECTOR})`);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // --- agent state (read-only, this session only) -----------------------------
  const readAgentState = async () => {
    try {
      const selected = new URLSearchParams(location.search).get("session") || sessionId;
      window.__piChatActiveSessionId = selected;
      const response = await fetch(`/api/agent/${encodeURIComponent(selected)}`);
      if (!response.ok) return { ok: false, detail: `GET /api/agent/<id> answered ${response.status}` };
      const data = await response.json();
      return { ok: true, running: data.running === true, state: data.state ?? null };
    } catch (error) {
      return { ok: false, detail: error && error.message ? error.message : String(error) };
    }
  };
  // `running` is the RPC process being alive, which outlives a finished run, so
  // idle means "nothing streaming and no prompt in flight".
  const isIdle = (state) => state.ok && (
    state.running === false || (!state.state?.isStreaming && !state.state?.isPromptRunning)
  );
  const describeState = (state) => state.ok
    ? `running=${state.running}, isStreaming=${state.state?.isStreaming}, isPromptRunning=${state.state?.isPromptRunning}`
    : state.detail;

  await record("the window is opened on the injected test session", async () => {
    const onSession = await waitUntil(
      () => new URLSearchParams(location.search).get("session") === sessionId,
      NAV_TIMEOUT_MS,
    );
    if (!onSession) {
      throw new Error(`the url never selected ${sessionId.slice(0, 12)}… (still ${location.search || "<empty>"})`);
    }
    const textarea = await waitUntil(() => {
      const element = composerEl();
      return element && element.getClientRects().length > 0 ? element : null;
    }, NAV_TIMEOUT_MS);
    if (!textarea) throw new Error(`the composer (${COMPOSER_SELECTOR}) never became visible`);
    const state = await readAgentState();
    if (!state.ok) throw new Error(`the agent state endpoint is unreachable (${state.detail})`);
    return `composer visible, state readable (${describeState(state)})`;
  });

  await record("typing in the composer reaches React and enables Send", async () => {
    typeIntoComposer(LONG_PROMPT);
    const button = await waitUntil(() => sendButton(), TYPING_TIMEOUT_MS);
    if (!button) {
      const candidate = rowButton();
      if (candidate && SEND_LABELS.includes(candidate.textContent.trim())) {
        throw new Error("Send is rendered but stayed disabled after typing — the input event never reached React");
      }
      throw new Error(`no Send button in the composer row (row button label ${JSON.stringify(rowButtonLabel())}) — the composer markup changed`);
    }
    return `${LONG_PROMPT.length} characters typed, Send "${button.textContent.trim()}" enabled`;
  });

  await record("clicking Send starts a real run", async () => {
    const button = sendButton();
    if (!button) throw new Error("no Send button to click");
    button.click();

    const cleared = await waitUntil(() => (composerEl()?.value ?? null) === "", 10000);
    if (!cleared) throw new Error("the composer still holds the typed text 10s after clicking Send — the click never reached handleSend");

    const stop = await waitUntil(() => stopButton(), SEND_EFFECT_TIMEOUT_MS);
    if (!stop) throw new Error("the Stop button never appeared after sending, so the window never entered its streaming state");
    return `composer cleared, Stop "${stop.textContent.trim()}" visible`;
  });

  await record("the first UI prompt has an active run before Stop", async () => {
    const active = await waitUntil(async () => {
      const state = await readAgentState();
      return state.ok && (state.state?.isStreaming === true || state.state?.isPromptRunning === true)
        ? state : null;
    }, STREAMING_TIMEOUT_MS);
    if (!active) {
      const state = await readAgentState();
      throw new Error(`no active run was observed before Stop (${describeState(state)})`);
    }
    return describeState(active);
  });

  await record("clicking Stop ends the run", async () => {
    const stop = stopButton();
    if (!stop) throw new Error("the Stop button is already gone — the model finished before the probe could stop it, so use a longer first prompt");
    stop.click();

    const idle = await waitUntil(async () => {
      const state = await readAgentState();
      return isIdle(state) ? state : null;
    }, STOP_EFFECT_TIMEOUT_MS);
    if (!idle) {
      const state = await readAgentState();
      throw new Error(`the run kept going after clicking Stop (${describeState(state)})`);
    }
    return `settled after Stop (${describeState(idle)})`;
  });

  await record("the composer comes back for input after the stop", async () => {
    const recovered = await waitUntil(() => {
      const textarea = composerEl();
      if (!textarea || textarea.disabled || textarea.readOnly) return null;
      if (stopButton()) return null;
      return sendButton() ? textarea : null;
    }, RECOVERY_TIMEOUT_MS);
    if (!recovered) {
      throw new Error(`the composer did not return to an inputtable state within ${RECOVERY_TIMEOUT_MS / 1000}s (Stop button ${stopButton() ? "still there" : "gone"}, Send button ${sendButton() ? "back" : "missing"})`);
    }
    return "Stop button gone, Send button back, composer editable";
  });

  await record("a second message typed after the stop is sent", async () => {
    typeIntoComposer(CONTINUE_PROMPT);
    const button = await waitUntil(() => sendButton(), TYPING_TIMEOUT_MS);
    if (!button) {
      throw new Error(`Send did not enable for the second message (row button label ${JSON.stringify(rowButtonLabel())})`);
    }
    button.click();

    const cleared = await waitUntil(() => (composerEl()?.value ?? null) === "", 10000);
    if (!cleared) throw new Error("the composer kept the second message 10s after clicking Send");
    return `${CONTINUE_PROMPT.length} characters typed and sent`;
  });

  await record(`the assistant answers the second message with ${ANSWER}`, async () => {
    const finished = await waitUntil(async () => {
      const container = [...document.querySelectorAll('[data-message-role="assistant"]')].find((candidate) => {
        const text = [...candidate.querySelectorAll("[data-message-text]")]
          .map((node) => node.textContent ?? "")
          .join("\n");
        return text.includes(ANSWER) && Boolean(copyButtonIn(candidate));
      });
      if (!container) return null;
      const state = await readAgentState();
      return isIdle(state) ? { container, state } : null;
    }, SECOND_ANSWER_TIMEOUT_MS, 300);

    if (!finished) {
      const state = await readAgentState();
      const onScreen = assistantText().includes(ANSWER);
      throw new Error([
        onScreen
          ? `${ANSWER} is on screen but never settled into a finished assistant message`
          : `no assistant text block contained ${ANSWER} within ${SECOND_ANSWER_TIMEOUT_MS / 1000}s`,
        `agent state: ${describeState(state)}`,
      ].join("; "));
    }
    return `${ANSWER} rendered inside a finished assistant message (${describeState(finished.state)})`;
  });

  return results;
})();
