/**
 * Capture ranges, updates with an overlap window, and resuming through archived history, run
 * against the simulated Teams chat and a real (fake-indexeddb) archive.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ScrapeControl } from '../../src/scraper/control';
import { DAY_MS } from '../../src/shared/capture';
import { coverageStatus } from '../../src/storage/coverage';
import type { ArchiveRepository } from '../../src/storage/repository';
import { ChatSimulator, generateConversation } from '../helpers/chat-simulator';
import { detect, openTestRepository, runEngine } from '../helpers/fixtures';
import type { FixtureMessage } from '../helpers/teams-dom';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 1, 8, 0);
const PEOPLE = ['Alice Andersen', 'Bob Brown', 'Carol Chen'];

let simulator: ChatSimulator | null = null;
let archive: ArchiveRepository | null = null;

afterEach(() => {
  simulator?.dispose();
  simulator = null;
  archive?.close();
  archive = null;
  document.body.innerHTML = '';
});

const timeOf = (n: number) => START + n * HOUR;

/** One message an hour: message n is sent at timeOf(n) and reads "Message n". */
function hourly(count: number, from = 0): FixtureMessage[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return { id: String(timeOf(n)), author: PEOPLE[n % PEOPLE.length], time: new Date(timeOf(n)).toISOString(), paragraphs: [`Message ${n}`] };
  });
}

async function setup(items: FixtureMessage[]): Promise<{ sim: ChatSimulator; repository: ArchiveRepository; conversationKey: string }> {
  simulator = new ChatSimulator({ items });
  archive = await openTestRepository();
  return { sim: simulator, repository: archive, conversationKey: detect().conversationKey };
}

async function storedTimes(repository: ArchiveRepository, conversationKey: string): Promise<number[]> {
  const stored = await repository.getMessages(conversationKey);
  expect(new Set(stored.map((message) => message.key)).size).toBe(stored.length);
  return stored.map((message) => message.sortKey);
}

function expectAll(times: number[], from: number, to: number): void {
  const present = new Set(times);
  const missing = [];
  for (let n = from; n <= to; n++) if (!present.has(timeOf(n))) missing.push(n);
  expect(missing).toEqual([]);
}

describe('capture ranges', () => {
  it('stops at the start of the chosen period and keeps every message from then on', async () => {
    const { repository, conversationKey } = await setup(hourly(240));
    const since = timeOf(180);

    const result = await runEngine({ repository, mode: 'full', since });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'range-reached', error: null });
    const times = await storedTimes(repository, conversationKey);
    expectAll(times, 180, 239);
    // It stops within a scroll step of the start.
    expect(Math.min(...times)).toBeLessThanOrEqual(since);
    expect(Math.min(...times)).toBeGreaterThan(since - 24 * HOUR);
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation!.coverage).toEqual([{ oldest: Math.min(...times), newest: timeOf(239), reachedBeginning: false }]);
  });

  it('extends an earlier period, passing the archived part quickly', async () => {
    const { repository, conversationKey } = await setup(hourly(240));
    await runEngine({ repository, mode: 'full', since: timeOf(180) });

    const second = await runEngine({ repository, mode: 'full', since: timeOf(60) });

    expect(second).toMatchObject({ status: 'completed', stopReason: 'range-reached' });
    expect(second.counters.seekPasses).toBeGreaterThan(0);
    expect(second.counters.gapsUnrecovered).toBe(0);
    const times = await storedTimes(repository, conversationKey);
    expectAll(times, 60, 239);
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation!.coverage).toHaveLength(1);
  });

  it('finishes at once when the archive already holds the period', async () => {
    const { repository, conversationKey } = await setup(hourly(240));
    await runEngine({ repository, mode: 'full', since: timeOf(120) });

    const inside = await runEngine({ repository, mode: 'full', since: timeOf(200) });
    expect(inside).toMatchObject({ status: 'completed', stopReason: 'history-complete' });
    expect(inside.counters.inserted).toBe(0);
    expect(inside.counters.passes).toBeLessThanOrEqual(2);

    await runEngine({ repository, mode: 'full' });
    const afterFull = await runEngine({ repository, mode: 'full', since: timeOf(10) });
    expect(afterFull).toMatchObject({ status: 'completed', stopReason: 'history-complete' });
    expect(afterFull.counters.passes).toBeLessThanOrEqual(2);
    expect(await repository.countMessages(conversationKey)).toBe(240);
  });

  it('reads the period again when asked to re-read archived parts', async () => {
    const { repository, conversationKey } = await setup(hourly(240));
    await runEngine({ repository, mode: 'full', since: timeOf(120) });

    const reread = await runEngine({ repository, mode: 'full', since: timeOf(200), rescan: true });
    expect(reread).toMatchObject({ status: 'completed', stopReason: 'range-reached' });
    expect(reread.counters.uniqueSeen).toBeGreaterThanOrEqual(40);
    expect(reread.counters.inserted).toBe(0);
    expect(await repository.countMessages(conversationKey)).toBe((await storedTimes(repository, conversationKey)).length);
  });
});

describe('updates with an overlap window', () => {
  it('re-reads the days before the last update and records edits made there', async () => {
    const { sim, repository, conversationKey } = await setup(hourly(240));
    await runEngine({ repository, mode: 'full' });
    const lastUpdate = timeOf(239);
    sim.appendItems(hourly(6, 240));
    sim.replaceItem(209, { ...sim.items[209]!, paragraphs: ['Edited within the window'], edited: true });
    sim.replaceItem(143, { ...sim.items[143]!, paragraphs: ['Edited long before'], edited: true });
    const since = lastUpdate - 2 * DAY_MS;

    const update = await runEngine({ repository, mode: 'incremental', since });

    expect(update).toMatchObject({ status: 'completed', stopReason: 'overlap-reached' });
    expect(update.counters.inserted).toBe(6);
    expect(update.counters.oldestSortKey).toBeLessThanOrEqual(since);
    expect(update.counters.oldestSortKey).toBeGreaterThan(since - 24 * HOUR);
    // Every message of the window was read again: none was stepped over.
    expect(update.counters.uniqueSeen).toBeGreaterThanOrEqual(6 + 48);
    const inside = await repository.getMessage(`${conversationKey}#${timeOf(209)}`);
    expect(inside).toMatchObject({ text: 'Edited within the window', isEdited: true });
    expect(inside!.previousVersions.map((version) => version.text)).toEqual(['Message 209']);
    const outside = await repository.getMessage(`${conversationKey}#${timeOf(143)}`);
    expect(outside).toMatchObject({ text: 'Message 143', isEdited: false });
    expect(await repository.countMessages(conversationKey)).toBe(246);
  });

  it('without a window, stops as soon as it has seen enough archived messages', async () => {
    const { sim, repository, conversationKey } = await setup(hourly(240));
    await runEngine({ repository, mode: 'full' });
    sim.appendItems(hourly(6, 240));
    sim.replaceItem(209, { ...sim.items[209]!, paragraphs: ['Edited within two days'], edited: true });

    const update = await runEngine({ repository, mode: 'incremental', since: timeOf(239) });

    expect(update).toMatchObject({ status: 'completed', stopReason: 'overlap-reached' });
    expect(update.counters.inserted).toBe(6);
    expect(update.counters.oldestSortKey).toBeGreaterThan(timeOf(239) - 24 * HOUR);
    expect(await repository.getMessage(`${conversationKey}#${timeOf(209)}`)).toMatchObject({ text: 'Message 209' });
  });

  it('after an update that was stopped early, goes back to the last update and closes the gap', async () => {
    const { sim, repository, conversationKey } = await setup(hourly(240));
    await runEngine({ repository, mode: 'full' });
    const lastUpdate = timeOf(239);
    sim.appendItems(hourly(60, 240));

    const control = new ScrapeControl();
    const stopped = await runEngine({
      repository,
      mode: 'incremental',
      since: lastUpdate,
      control,
      onProgress: (progress) => {
        if (progress.counters.passes >= 2) control.stop();
      },
    });
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'user-stop' });
    const partial = (await repository.countMessages(conversationKey)) - 240;
    expect(partial).toBeGreaterThan(8);
    expect(partial).toBeLessThan(60);
    expect((await repository.getConversation(conversationKey))!.coverage).toHaveLength(2);

    // The newest stretch alone holds enough archived messages: only reaching the last update ends the run.
    const resumed = await runEngine({ repository, mode: 'incremental', since: lastUpdate });
    expect(resumed).toMatchObject({ status: 'completed', stopReason: 'overlap-reached' });
    expect(resumed.counters.inserted).toBe(60 - partial);
    expectAll(await storedTimes(repository, conversationKey), 0, 299);
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation!.coverage).toHaveLength(1);
    expect(coverageStatus(conversation!.coverage, conversation!.newestSortKey)).toBe('complete');
  });
});

describe('resuming through archived history', () => {
  it('takes larger steps through the archived part without missing a message', async () => {
    const generate = { count: 400, participants: PEOPLE, selfName: 'Me', seed: 21, withoutIdEvery: 11, withoutIdAndTimeEvery: 29 };

    const resumeAfterStop = async (rescan: boolean) => {
      const { items, expected } = generateConversation(generate);
      simulator = new ChatSimulator({ items });
      archive = await openTestRepository();
      const conversationKey = detect().conversationKey;
      const control = new ScrapeControl();
      await runEngine({
        repository: archive,
        mode: 'full',
        control,
        onProgress: (progress) => {
          if (progress.counters.passes >= 35) control.stop();
        },
      });
      const archivedBefore = await archive.countMessages(conversationKey);
      const result = await runEngine({ repository: archive, mode: 'full', rescan });
      const stored = await archive.getMessages(conversationKey);
      const outcome = { result, archivedBefore, stored, expected };
      simulator.dispose();
      simulator = null;
      archive.close();
      archive = null;
      return outcome;
    };

    const quick = await resumeAfterStop(false);
    const reread = await resumeAfterStop(true);

    for (const { result, stored, expected } of [quick, reread]) {
      expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
      expect(result.counters.gapsUnrecovered).toBe(0);
      expect(new Set(stored.map((message) => message.key)).size).toBe(stored.length);
      expect(stored.map((message) => message.text)).toEqual(expected.map((message) => message.text));
    }
    expect(quick.archivedBefore).toBeGreaterThan(150);
    expect(quick.result.counters.inserted).toBe(quick.expected.length - quick.archivedBefore);
    expect(quick.result.counters.seekPasses).toBeGreaterThan(0);
    // Stepping over archived messages takes far fewer steps than reading them all again.
    expect(quick.result.counters.passes).toBeLessThan(reread.result.counters.passes - 10);
  });
});
