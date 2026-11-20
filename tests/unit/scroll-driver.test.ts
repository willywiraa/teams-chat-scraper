import { afterEach, describe, expect, it } from 'vitest';
import { createScrollDriver } from '../../src/scraper/scroll-driver';

/** A scrollable element with simulated geometry (jsdom has no layout). */
function scroller(start = 3000, height = 5000, client = 600) {
  const element = document.createElement('div');
  document.body.append(element);
  let top = start;
  const writes: number[] = [];
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(Math.max(0, Math.round(value)), height - client);
      writes.push(top);
    },
  });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => client });
  /** The page moves the list itself, as Teams does to keep the view in place after loading older messages. */
  const shift = (px: number) => {
    top += px;
  };
  return { element, writes, shift };
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (document as { visibilityState?: string }).visibilityState;
});

describe('scroll driver', () => {
  it('jumps in one move without an animation', async () => {
    const { element, writes } = scroller();
    const move = await createScrollDriver(element).scrollUp(500);
    expect(move).toEqual({ before: 3000, after: 2500, distance: 500, moved: true });
    expect(writes).toEqual([2500]);
  });

  it('spreads an animated step over several frames', async () => {
    const { element, writes } = scroller();
    const move = await createScrollDriver(element).scrollUp(500, 80);
    expect(move).toEqual({ before: 3000, after: 2500, distance: 500, moved: true });
    expect(writes.length).toBeGreaterThan(2);
    expect(writes.every((value, i) => i === 0 || value <= (writes[i - 1] as number))).toBe(true);
    expect(writes.at(-1)).toBe(2500);
  });

  it('stops at the top and reports how far it really scrolled', async () => {
    const { element } = scroller(200);
    const driver = createScrollDriver(element);
    expect(await driver.scrollUp(500, 80)).toMatchObject({ after: 0, distance: 200, moved: true });
    expect(driver.isAtTop()).toBe(true);
    expect(await driver.scrollUp(500, 80)).toMatchObject({ after: 0, distance: 0, moved: false });
  });

  it('keeps a correction the page makes during the animation', async () => {
    const { element, shift } = scroller();
    setTimeout(() => shift(1000), 30);
    const move = await createScrollDriver(element).scrollUp(500, 120);
    expect(move).toMatchObject({ before: 3000, after: 3500, distance: 500, moved: true });
  });

  it('ends an animation at once when the run is stopped', async () => {
    const { element } = scroller();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const move = await createScrollDriver(element, { signal: controller.signal }).scrollUp(500, 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(move.distance).toBeLessThan(500);
  });

  it('jumps instead of animating while the tab is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const { element, writes } = scroller();
    expect(await createScrollDriver(element).scrollDown(300, 80)).toMatchObject({ after: 3300, distance: 300 });
    expect(writes).toEqual([3300]);
  });
});
