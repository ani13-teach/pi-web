export interface QuitEvent { preventDefault(): void }

export interface QuitLifecycle {
  begin(): void;
  teardown(): readonly (() => void)[];
  shutdown(): Promise<void>;
  exit(): void;
  report(error: unknown): void;
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/** Install a deadline before running any user/native teardown callbacks. */
export function createQuitHandler(options: QuitLifecycle): (event: QuitEvent) => void {
  let started = false;
  let finished = false;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  return (event) => {
    event.preventDefault();
    if (started) return;
    started = true;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimer(deadline);
      options.exit();
    };
    const deadline = setTimer(() => {
      options.report(new Error("Pi Desktop quit deadline exceeded"));
      finish();
    }, options.timeoutMs ?? 20_000);
    try {
      options.begin();
      for (const step of options.teardown()) {
        try { step(); } catch (error) { options.report(error); }
      }
    } catch (error) {
      options.report(error);
    }
    // A rejected shutdown must not produce an unhandled rejection, and a
    // synchronous native/UI exception must never bypass this cleanup path.
    void Promise.resolve().then(() => options.shutdown()).catch(options.report).then(finish);
  };
}
