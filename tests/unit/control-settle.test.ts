import { afterEach, describe, expect, it } from 'vitest';
import { ScrapeControl, sleep } from '../../src/scraper/control';
import { waitForSettle } from '../../src/scraper/settle';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ScrapeControl', () => {
  it('blocks the loop while paused and releases it on resume', async () => {
    const control = new ScrapeControl();
    const states: string[] = [];
    control.onChange((state) => states.push(state));
    expect(await control.checkpoint()).toBe('continue');

    expect(control.pause()).toBe(true);
    expect(control.pause()).toBe(false);
    let released = false;
    const waiting = control.checkpoint().then((result) => {
      released = true;
      return result;
    });
    await tick(20);
    expect(released).toBe(false);

    expect(control.resume()).toBe(true);
    expect(await waiting).toBe('continue');
    expect(control.resume()).toBe(false);
    expect(states).toEqual(['paused', 'running']);
  });

  it('stops a paused loop and aborts pending waits', async () => {
    const control = new ScrapeControl();
    control.pause();
    const waiting = control.checkpoint();
    const started = Date.now();
    const sleeping = sleep(10_000, control.signal);
    control.stop();
    control.stop();

    expect(await waiting).toBe('stop');
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(control.signal.aborted).toBe(true);
    expect(control.state).toBe('stopping');
    expect(control.pause()).toBe(false);
    expect(control.resume()).toBe(false);
  });
});

describe('waitForSettle', () => {
  let target: HTMLElement;
  afterEach(() => target?.remove());
  const mount = () => {
    target = document.createElement('div');
    document.body.append(target);
    return target;
  };

  it('resolves once the DOM has been quiet for the configured time', async () => {
    const result = await waitForSettle(mount(), { quietMs: 20, timeoutMs: 1_000 });
    expect(result).toMatchObject({ timedOut: false, aborted: false, mutations: 0 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(15);
  });

  it('keeps waiting while content is still being rendered', async () => {
    const el = mount();
    let renders = 0;
    const interval = setInterval(() => {
      if (renders++ < 6) el.append(document.createElement('p'));
    }, 8);
    const result = await waitForSettle(el, { quietMs: 30, timeoutMs: 2_000 });
    clearInterval(interval);
    expect(result.timedOut).toBe(false);
    expect(result.mutations).toBeGreaterThanOrEqual(6);
  });

  it('waits for a loading indicator to disappear, up to the timeout', async () => {
    let loading = true;
    setTimeout(() => {
      loading = false;
    }, 60);
    const done = await waitForSettle(mount(), { quietMs: 10, timeoutMs: 1_000, isLoading: () => loading });
    expect(done.timedOut).toBe(false);
    expect(done.elapsedMs).toBeGreaterThanOrEqual(55);

    const stuck = await waitForSettle(target, { quietMs: 10, timeoutMs: 60, isLoading: () => true });
    expect(stuck.timedOut).toBe(true);
  });

  it('can require at least one change (history loading at the top)', async () => {
    const el = mount();
    const nothing = await waitForSettle(el, { quietMs: 10, timeoutMs: 60, requireMutation: true });
    expect(nothing.timedOut).toBe(true);

    setTimeout(() => el.append(document.createElement('p')), 20);
    const loaded = await waitForSettle(el, { quietMs: 10, timeoutMs: 1_000, requireMutation: true });
    expect(loaded).toMatchObject({ timedOut: false, mutations: 1 });
  });

  it('ends immediately when the run is stopped', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await waitForSettle(mount(), { quietMs: 10, timeoutMs: 5_000, isLoading: () => true, signal: controller.signal });
    expect(result).toMatchObject({ aborted: true, timedOut: false });
  });
});
