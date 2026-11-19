/**
 * Pause / resume / stop signalling between the UI and the running scrape loop.
 * The loop calls checkpoint() between steps; stop() also aborts in-flight waits.
 */
export type ControlState = 'running' | 'paused' | 'stopping';

export class ScrapeControl {
  private currentState: ControlState = 'running';
  private resumeWaiters: Array<() => void> = [];
  private readonly abortController = new AbortController();
  private readonly listeners = new Set<(state: ControlState) => void>();

  get state(): ControlState {
    return this.currentState;
  }

  /** Aborted when stop() is called; pass to waits so they end promptly. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  pause(): boolean {
    if (this.currentState !== 'running') return false;
    this.currentState = 'paused';
    this.notify();
    return true;
  }

  resume(): boolean {
    if (this.currentState !== 'paused') return false;
    this.currentState = 'running';
    this.releaseWaiters();
    this.notify();
    return true;
  }

  stop(): void {
    if (this.currentState === 'stopping') return;
    this.currentState = 'stopping';
    this.abortController.abort();
    this.releaseWaiters();
    this.notify();
  }

  /** Blocks while paused. Resolves 'stop' once stop() has been called. */
  async checkpoint(): Promise<'continue' | 'stop'> {
    while (this.currentState === 'paused') {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    }
    return this.currentState === 'stopping' ? 'stop' : 'continue';
  }

  onChange(listener: (state: ControlState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private releaseWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener(this.currentState));
  }
}

/** setTimeout as a promise that resolves early (without error) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
