/**
 * Waits until Teams has finished rendering after a scroll step: the observed subtree must be
 * free of DOM mutations for `quietMs` and no loading indicator may be visible.
 */
export interface SettleOptions {
  quietMs: number;
  timeoutMs: number;
  /** Keep waiting (up to the timeout) until at least one mutation was observed. */
  requireMutation?: boolean;
  /** Returns true while a loading spinner is displayed. */
  isLoading?: () => boolean;
  signal?: AbortSignal;
  now?: () => number;
}

export interface SettleResult {
  mutations: number;
  timedOut: boolean;
  aborted: boolean;
  elapsedMs: number;
}

export function waitForSettle(target: Node, options: SettleOptions): Promise<SettleResult> {
  const now = options.now ?? (() => Date.now());
  const start = now();
  let lastMutation = start;
  let mutations = 0;
  const observer = new MutationObserver((records) => {
    mutations += records.length;
    lastMutation = now();
  });
  observer.observe(target, { childList: true, subtree: true, characterData: true });
  const pollMs = Math.max(5, Math.min(50, Math.floor(options.quietMs / 3)));

  return new Promise<SettleResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (timedOut: boolean, aborted: boolean) => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ mutations, timedOut, aborted, elapsedMs: now() - start });
    };
    const onAbort = () => finish(false, true);
    if (options.signal?.aborted) {
      finish(false, true);
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const tick = () => {
      const current = now();
      if (current - start >= options.timeoutMs) {
        finish(true, false);
        return;
      }
      const loading = options.isLoading?.() ?? false;
      const quiet = current - lastMutation >= options.quietMs;
      if (!loading && quiet && (!options.requireMutation || mutations > 0)) {
        finish(false, false);
        return;
      }
      timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
  });
}
