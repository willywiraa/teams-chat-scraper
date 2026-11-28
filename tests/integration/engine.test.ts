/**
 * End-to-end tests of the scraping engine against a simulated, virtualised Teams chat
 * (lazy history loading, recycled DOM nodes, grouped messages), persisting into a real
 * IndexedDB archive (fake-indexeddb).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ScrapeControl } from '../../src/scraper/control';
import type { EngineProgress, EngineSink } from '../../src/scraper/engine';
import type { StoredMessage } from '../../src/shared/types';
import { coverageStatus } from '../../src/storage/coverage';
import type { ArchiveRepository } from '../../src/storage/repository';
import { ChatSimulator, generateConversation, type ExpectedMessage, type GenerateOptions, type SimulatorOptions } from '../helpers/chat-simulator';
import { detect, openTestRepository, repositorySink, runEngine, waitFor } from '../helpers/fixtures';
import type { FixtureMessage } from '../helpers/teams-dom';

const ONE_ON_ONE_THREAD = '19:aaaa1111-0000-4000-8000-000000000001_bbbb2222-0000-4000-8000-000000000002@unq.gbl.spaces';
const PEOPLE = ['Alice Andersen', 'Bob Brown', 'Carol Chen', 'Dan Diaz'];

let simulator: ChatSimulator | null = null;
let archive: ArchiveRepository | null = null;

afterEach(() => {
  simulator?.dispose();
  simulator = null;
  archive?.close();
  archive = null;
  document.body.innerHTML = '';
});

interface Setup {
  sim: ChatSimulator;
  repository: ArchiveRepository;
  expected: ExpectedMessage[];
  conversationKey: string;
}

async function setup(generate: GenerateOptions, options: Partial<SimulatorOptions> = {}): Promise<Setup> {
  const { items, expected } = generateConversation(generate);
  simulator = new ChatSimulator({ items, ...options });
  archive = await openTestRepository();
  return { sim: simulator, repository: archive, expected, conversationKey: detect().conversationKey };
}

/** What the archive should say about each message, independent of storage details. */
function projectStored(stored: StoredMessage[]) {
  const byKey = new Map(stored.map((message) => [message.key, message]));
  return stored.map((message) => ({
    kind: message.kind,
    id: message.messageId,
    sender: message.kind === 'system' ? null : message.sender.isSelf ? '(self)' : message.sender.name,
    time: message.timestamp,
    text: message.text,
    attachments: message.attachments.map((attachment) => attachment.name),
    replyTo: message.replyTo ? (byKey.get(message.replyTo.resolvedKey ?? '')?.text ?? '(unresolved)') : null,
  }));
}

function projectExpected(expected: ExpectedMessage[]) {
  return expected.map((truth) => ({
    kind: truth.kind,
    id: truth.id,
    sender: truth.kind === 'system' ? null : truth.self ? '(self)' : truth.sender,
    time: truth.missing === 'id-and-time' ? null : truth.time,
    text: truth.text,
    attachments: truth.attachments,
    replyTo: truth.replyTo === null ? null : (expected[truth.replyTo] as ExpectedMessage).text,
  }));
}

async function expectArchiveToMatch(repository: ArchiveRepository, conversationKey: string, expected: ExpectedMessage[]): Promise<StoredMessage[]> {
  const stored = await repository.getMessages(conversationKey);
  expect(new Set(stored.map((message) => message.key)).size).toBe(stored.length);
  expect(projectStored(stored)).toEqual(projectExpected(expected));
  return stored;
}

function itemIndexOf(sim: ChatSimulator, id: string): number {
  const index = sim.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`item ${id} not found`);
  return index;
}

describe('full history extraction', () => {
  it('archives an individual (1:1) conversation completely', async () => {
    const { repository, expected, conversationKey } = await setup(
      { count: 120, participants: ['Alice Andersen'], selfName: 'Me', seed: 1, dividerEvery: 25 },
      { threadId: ONE_ON_ONE_THREAD, title: 'Alice Andersen' },
    );
    const result = await runEngine({ repository, mode: 'full' });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top', error: null });
    expect(result.counters.inserted).toBe(expected.length);
    await expectArchiveToMatch(repository, conversationKey, expected);
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation).toMatchObject({ type: 'one-on-one', threadId: ONE_ON_ONE_THREAD, title: 'Alice Andersen', messageCount: 120 });
    expect(conversation?.participants).toEqual(['Alice Andersen']);
    expect(conversation?.coverage).toHaveLength(1);
    expect(coverageStatus(conversation!.coverage, conversation!.newestSortKey)).toBe('complete');
  });

  it('attributes every message of a group conversation to the right sender', async () => {
    const { repository, expected, conversationKey } = await setup({
      count: 300,
      participants: PEOPLE,
      selfName: 'Me',
      seed: 2,
      groupProbability: 0.75,
      dividerEvery: 50,
      systemEvery: 70,
      withAttachmentsEvery: 20,
    });
    const result = await runEngine({ repository, mode: 'full' });

    expect(result.status).toBe('completed');
    await expectArchiveToMatch(repository, conversationKey, expected);
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation?.type).toBe('group');
    expect(conversation?.participants).toEqual(PEOPLE);
  });

  it('carries the sender through a run of messages longer than the rendered window', async () => {
    const start = Date.UTC(2024, 2, 1, 9, 0);
    const items: FixtureMessage[] = [];
    const truth: string[] = [];
    const add = (author: string, count: number) => {
      for (let i = 0; i < count; i++) {
        const time = start + items.length * 60_000;
        items.push({ id: String(time), author: i === 0 ? author : undefined, time: new Date(time).toISOString(), paragraphs: [`${author} #${i}`] });
        truth.push(author);
      }
    };
    add('Alice Andersen', 3);
    add('Bob Brown', 45);
    add('Carol Chen', 3);
    simulator = new ChatSimulator({ items });
    archive = await openTestRepository();

    const result = await runEngine({ repository: archive, mode: 'full' });

    expect(result.status).toBe('completed');
    const stored = await archive.getMessages(detect().conversationKey);
    expect(stored.map((message) => message.sender.name)).toEqual(truth);
    expect(stored.filter((message) => message.sender.source === 'group-inferred')).toHaveLength(48);
  });

  it('captures a large conversation exactly once and in order', async () => {
    const { repository, expected, conversationKey } = await setup({
      count: 2000,
      participants: [...PEOPLE, 'Erin Evans', 'Frank Fischer'],
      selfName: 'Me',
      seed: 3,
      dividerEvery: 40,
      systemEvery: 150,
      withAttachmentsEvery: 25,
      withRepliesEvery: 15,
    });
    const result = await runEngine({ repository, mode: 'full' });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(result.counters.inserted).toBe(expected.length);
    expect(result.counters.uniqueSeen).toBe(expected.length);
    expect(result.counters.gapsUnrecovered).toBe(0);
    await expectArchiveToMatch(repository, conversationKey, expected);
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation?.messageCount).toBe(expected.length);
    expect(conversation?.coverage).toEqual([
      { oldest: Date.parse(expected[0]!.time), newest: Date.parse(expected[expected.length - 1]!.time), reachedBeginning: true },
    ]);
  }, 180_000);

  it('preserves multi-paragraph text, attachments and reply relationships', async () => {
    const { repository, expected, conversationKey } = await setup({
      count: 90,
      participants: PEOPLE,
      seed: 4,
      withAttachmentsEvery: 4,
      withRepliesEvery: 3,
    });
    await runEngine({ repository, mode: 'full' });

    const stored = await expectArchiveToMatch(repository, conversationKey, expected);
    expect(stored.some((message) => message.text.includes('\n\n'))).toBe(true);
    const withFile = stored.find((message) => message.attachments.length > 0);
    expect(withFile?.attachments[0]).toMatchObject({ kind: 'file', url: expect.stringMatching(/^https:\/\/example\.invalid\/files\//) });
    const replies = stored.filter((message) => message.replyTo);
    expect(replies.length).toBeGreaterThan(20);
    expect(replies.every((message) => message.replyTo?.resolution === 'message-id')).toBe(true);
  });

  it('archives the complete history with smooth (animated) scroll steps', async () => {
    const { sim, repository, expected, conversationKey } = await setup({ count: 150, participants: PEOPLE, selfName: 'Me', seed: 9, withRepliesEvery: 11 });
    let scrollWrites = 0;
    const setScrollTop = sim.setScrollTop.bind(sim);
    sim.setScrollTop = (value: number) => {
      scrollWrites++;
      setScrollTop(value);
    };
    const result = await runEngine({ repository, mode: 'full', settings: { scrollAnimationMs: 40 } });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top', error: null });
    expect(result.counters.gapsUnrecovered).toBe(0);
    // Each step is spread over several frames instead of one jump.
    expect(scrollWrites).toBeGreaterThan(result.counters.passes * 2);
    await expectArchiveToMatch(repository, conversationKey, expected);
    expect((await repository.getConversation(conversationKey))?.coverage).toHaveLength(1);
  });

  it('closes gaps when a scroll step skips over unrendered messages', async () => {
    const { repository, expected, conversationKey } = await setup({ count: 300, participants: PEOPLE, seed: 5 }, { overscan: 0 });
    const result = await runEngine({ repository, mode: 'full', settings: { scrollStepRatio: 3 } });

    expect(result.status).toBe('completed');
    expect(result.counters.gapsDetected).toBeGreaterThan(0);
    expect(result.counters.gapsUnrecovered).toBe(0);
    await expectArchiveToMatch(repository, conversationKey, expected);
    expect((await repository.getConversation(conversationKey))?.coverage).toHaveLength(1);
  });
});

describe('missing metadata', () => {
  it('archives messages without ids, timestamps or authors once, even across runs', async () => {
    const { repository, expected, conversationKey } = await setup({
      count: 240,
      participants: PEOPLE,
      selfName: 'Me',
      seed: 6,
      dividerEvery: 30,
      withoutIdEvery: 7,
      withoutTimeEvery: 5,
      withoutIdAndTimeEvery: 11,
    });
    expect(expected.filter((message) => message.missing === 'id-and-time').length).toBeGreaterThan(20);

    const first = await runEngine({ repository, mode: 'full' });
    expect(first.status).toBe('completed');
    const stored = await expectArchiveToMatch(repository, conversationKey, expected);

    const weak = stored.filter((message) => message.messageId === null && message.timestamp === null);
    expect(weak.length).toBe(expected.filter((message) => message.missing === 'id-and-time').length);
    expect(weak.every((message) => message.sortKeySource === 'interpolated' && message.key.includes('#fp:'))).toBe(true);
    const timeFromId = stored.filter((message) => message.timestampSource === 'message-id');
    expect(timeFromId.length).toBe(expected.filter((message) => message.missing === 'time').length);

    const again = await runEngine({ repository, mode: 'full', rescan: true });
    expect(again.status).toBe('completed');
    expect(again.counters.inserted).toBe(0);
    await expectArchiveToMatch(repository, conversationKey, expected);
  });
});

describe('repeated and incremental runs', () => {
  it('never stores a message twice when the same history is extracted again', async () => {
    const { repository, expected, conversationKey } = await setup({ count: 200, participants: PEOPLE, selfName: 'Me', seed: 7 });
    await runEngine({ repository, mode: 'full' });

    // The full history passes the archive quickly and checks the beginning again.
    const fullAgain = await runEngine({ repository, mode: 'full' });
    expect(fullAgain).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(fullAgain.counters.inserted).toBe(0);
    expect(fullAgain.counters.seekPasses).toBeGreaterThan(0);

    const update = await runEngine({ repository, mode: 'incremental' });
    expect(update).toMatchObject({ status: 'completed', stopReason: 'overlap-reached' });
    expect(update.counters.inserted).toBe(0);

    const rescan = await runEngine({ repository, mode: 'full', rescan: true });
    expect(rescan).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(rescan.counters.inserted).toBe(0);
    expect(rescan.counters.uniqueSeen).toBe(expected.length);

    await expectArchiveToMatch(repository, conversationKey, expected);
    expect(await repository.countMessages(conversationKey)).toBe(expected.length);
  });

  it('adds only the new messages in an incremental update', async () => {
    const { sim, repository, expected, conversationKey } = await setup({ count: 200, participants: PEOPLE, seed: 8 });
    await runEngine({ repository, mode: 'full' });

    const last = Date.parse(expected[expected.length - 1]!.time);
    const added: FixtureMessage[] = Array.from({ length: 12 }, (_, i) => {
      const time = last + (i + 1) * 45_000;
      return { id: String(time), author: i % 2 === 0 ? 'Erin Evans' : 'Bob Brown', time: new Date(time).toISOString(), paragraphs: [`New message ${i}`] };
    });
    sim.appendItems(added);

    const update = await runEngine({ repository, mode: 'incremental' });
    expect(update).toMatchObject({ status: 'completed', stopReason: 'overlap-reached' });
    expect(update.counters.inserted).toBe(12);
    expect(update.counters.passes).toBeLessThanOrEqual(4);

    const stored = await repository.getMessages(conversationKey);
    expect(stored).toHaveLength(212);
    expect(stored.slice(-12).map((message) => message.text)).toEqual(added.map((item) => item.paragraphs![0]));
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation?.coverage).toHaveLength(1);
    expect(coverageStatus(conversation!.coverage, conversation!.newestSortKey)).toBe('complete');
  });

  it('keeps the previous text when a message was edited after it was archived', async () => {
    const { sim, repository, expected, conversationKey } = await setup({ count: 100, participants: PEOPLE, seed: 9 });
    await runEngine({ repository, mode: 'full' });

    const target = expected[50]!;
    const index = itemIndexOf(sim, target.id!);
    sim.replaceItem(index, { ...sim.items[index]!, paragraphs: ['Corrected text'], edited: true });

    const rescan = await runEngine({ repository, mode: 'full', rescan: true });
    expect(rescan.counters.updated).toBeGreaterThanOrEqual(1);
    const record = await repository.getMessage(`${conversationKey}#${target.id}`);
    expect(record).toMatchObject({ text: 'Corrected text', isEdited: true });
    expect(record?.previousVersions.map((version) => version.text)).toEqual([target.text]);
    expect(await repository.countMessages(conversationKey)).toBe(expected.length);
  });
});

describe('interruptions and controls', () => {
  it('resumes an interrupted session without duplicates', async () => {
    const { repository, expected, conversationKey } = await setup({ count: 400, participants: PEOPLE, selfName: 'Me', seed: 10, withoutIdAndTimeEvery: 13 });
    const base = repositorySink(repository, detect(), 'session-1');
    let writes = 0;
    const failing: EngineSink = {
      write: async (batch) => {
        writes++;
        if (writes > 15) throw new Error('Extension context invalidated.');
        return base.write(batch);
      },
    };

    const interrupted = await runEngine({ repository, mode: 'full', sink: failing, sessionId: 'session-1' });
    expect(interrupted).toMatchObject({ status: 'failed', stopReason: 'error', error: 'Extension context invalidated.' });
    const partial = await repository.countMessages(conversationKey);
    expect(partial).toBeGreaterThan(50);
    expect(partial).toBeLessThan(expected.length);
    const before = await repository.getConversation(conversationKey);
    expect(coverageStatus(before!.coverage, before!.newestSortKey)).toBe('partial');
    // Coverage only claims what was actually stored.
    const oldestStored = (await repository.getMessages(conversationKey, 1))[0]!;
    expect(before!.coverage[0]!.oldest).toBeGreaterThanOrEqual(Math.floor(oldestStored.sortKey));

    const resumed = await runEngine({ repository, mode: 'full', sessionId: 'session-2' });
    expect(resumed).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(resumed.counters.seekPasses).toBeGreaterThan(0);
    expect(resumed.counters.inserted).toBe(expected.length - partial);
    await expectArchiveToMatch(repository, conversationKey, expected);
    const after = await repository.getConversation(conversationKey);
    expect(coverageStatus(after!.coverage, after!.newestSortKey)).toBe('complete');
  });

  it('stops on request and continues later from the archive', async () => {
    const { repository, expected, conversationKey } = await setup({ count: 250, participants: PEOPLE, seed: 11 });
    const control = new ScrapeControl();
    const stopped = await runEngine({
      repository,
      mode: 'full',
      control,
      onProgress: (progress) => {
        if (progress.counters.passes >= 6) control.stop();
      },
    });
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'user-stop' });
    const partial = await repository.countMessages(conversationKey);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(expected.length);

    const resumed = await runEngine({ repository, mode: 'full' });
    expect(resumed.status).toBe('completed');
    expect(resumed.counters.inserted).toBe(expected.length - partial);
    await expectArchiveToMatch(repository, conversationKey, expected);
  });

  it('pauses without scrolling and resumes where it left off', async () => {
    const { repository, expected, conversationKey } = await setup({ count: 150, participants: PEOPLE, seed: 12 });
    const control = new ScrapeControl();
    let latest: EngineProgress | null = null;
    let pausedOnce = false;
    const run = runEngine({
      repository,
      mode: 'full',
      control,
      onProgress: (progress) => {
        latest = progress;
        if (!pausedOnce && progress.counters.passes >= 3) {
          pausedOnce = true;
          control.pause();
        }
      },
    });

    await waitFor(() => latest?.phase === 'paused', 10_000, 'paused phase');
    const passesWhenPaused = latest!.counters.passes;
    const scrollWhenPaused = simulator!.scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(latest!.counters.passes).toBe(passesWhenPaused);
    expect(simulator!.scrollTop).toBe(scrollWhenPaused);

    expect(control.resume()).toBe(true);
    const result = await run;
    expect(result.status).toBe('completed');
    await expectArchiveToMatch(repository, conversationKey, expected);
  });

  it('does not count the time the computer slept toward the time limit', async () => {
    const { repository, expected, conversationKey } = await setup({ count: 150, participants: PEOPLE, seed: 15 });
    // The clock jumps ten hours once, as when a laptop hibernates and wakes again.
    let offset = 0;
    const result = await runEngine({
      repository,
      mode: 'full',
      settings: { maxDurationMinutes: 10 },
      now: () => Date.now() + offset,
      onProgress: (progress) => {
        if (progress.counters.passes === 3) offset = 10 * 60 * 60_000;
      },
    });
    expect(result.status).toBe('completed');
    await expectArchiveToMatch(repository, conversationKey, expected);
  });

  it('does not count the time a run was paused toward the time limit', async () => {
    const { repository, expected, conversationKey } = await setup({ count: 150, participants: PEOPLE, seed: 16 });
    const control = new ScrapeControl();
    let offset = 0;
    let latest: EngineProgress | null = null;
    let pausedOnce = false;
    const run = runEngine({
      repository,
      mode: 'full',
      control,
      settings: { maxDurationMinutes: 3 },
      now: () => Date.now() + offset,
      onProgress: (progress) => {
        latest = progress;
        if (!pausedOnce && progress.counters.passes >= 3) {
          pausedOnce = true;
          control.pause();
        }
      },
    });
    await waitFor(() => latest?.phase === 'paused', 10_000, 'paused phase');
    // Four minutes paused: more than the limit, less than a gap that counts as sleep.
    offset = 4 * 60_000;
    expect(control.resume()).toBe(true);
    expect((await run).status).toBe('completed');
    await expectArchiveToMatch(repository, conversationKey, expected);
  });

  it('still stops at the time limit when the run works that long', async () => {
    const { repository } = await setup({ count: 400, participants: PEOPLE, seed: 17 });
    // Every step takes two minutes of working time.
    let offset = 0;
    const result = await runEngine({
      repository,
      mode: 'full',
      settings: { maxDurationMinutes: 5 },
      now: () => Date.now() + offset,
      onProgress: () => {
        offset += 2 * 60_000;
      },
    });
    expect(result).toMatchObject({ status: 'stopped', stopReason: 'max-duration' });
  });

  it('stops when a different conversation is opened', async () => {
    const { repository } = await setup({ count: 200, participants: PEOPLE, seed: 13 });
    let switched = false;
    const result = await runEngine({
      repository,
      mode: 'full',
      onProgress: (progress) => {
        if (!switched && progress.counters.passes >= 3) {
          switched = true;
          const [selected, other] = Array.from(document.querySelectorAll('[data-tid="chat-list-item"]'));
          selected?.setAttribute('aria-selected', 'false');
          other?.setAttribute('aria-selected', 'true');
        }
      },
    });
    expect(result).toMatchObject({ status: 'stopped', stopReason: 'conversation-changed' });
  });

  it('gives up instead of looping when the list stops scrolling', async () => {
    const { sim, repository } = await setup({ count: 200, participants: PEOPLE, seed: 14 });
    const result = await runEngine({
      repository,
      mode: 'full',
      settings: { maxStallPasses: 4 },
      onProgress: (progress) => {
        if (progress.counters.passes >= 2) sim.frozen = true;
      },
    });
    expect(result).toMatchObject({ status: 'stopped', stopReason: 'no-progress' });
    expect(result.counters.passes).toBeLessThan(12);
  });

  it('respects the step limit', async () => {
    const { repository } = await setup({ count: 300, participants: PEOPLE, seed: 15 });
    const result = await runEngine({ repository, mode: 'full', settings: { maxSteps: 5 } });
    expect(result).toMatchObject({ status: 'stopped', stopReason: 'max-steps' });
    expect(result.counters.passes).toBe(5);
  });

  it('reads only the rendered messages in visible mode, without scrolling', async () => {
    const { sim, repository, conversationKey } = await setup({ count: 100, participants: PEOPLE, seed: 16 });
    const scrollTop = sim.scrollTop;
    const rendered = sim.renderedIndexes().filter((index) => sim.items[index]?.divider === undefined).length;

    const result = await runEngine({ repository, mode: 'visible' });
    expect(result).toMatchObject({ status: 'completed', stopReason: 'visible-complete' });
    expect(result.counters.passes).toBe(1);
    expect(sim.scrollTop).toBe(scrollTop);
    expect(await repository.countMessages(conversationKey)).toBe(rendered);
  });
});

describe('a slow Teams at the top of the list', () => {
  it('keeps waiting while Teams shows that it is loading older messages', async () => {
    const { sim, repository, expected, conversationKey } = await setup({ count: 90, participants: PEOPLE, seed: 31 }, { initialLoaded: 30, pageSize: 60, loadDelayMs: 900 });
    const result = await runEngine({ repository, mode: 'full' });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(sim.fetchCount).toBe(1);
    await expectArchiveToMatch(repository, conversationKey, expected);
  }, 20_000);

  it('waits longer at the top once Teams has been slow to load in the run', async () => {
    const { sim, repository, expected, conversationKey } = await setup({ count: 120, participants: PEOPLE, seed: 32 }, { initialLoaded: 30, pageSize: 30, loadDelayMs: 300 });
    let waiting = false;
    const result = await runEngine({
      repository,
      mode: 'full',
      onProgress: (progress) => {
        // The third load takes longer than the first two, and the page shows no spinner for it.
        if (sim.fetchCount >= 2) {
          sim.silentLoading = true;
          sim.loadDelayMs = 700;
        }
        waiting ||= progress.waitingForOlder;
      },
    });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(sim.fetchCount).toBe(3);
    await expectArchiveToMatch(repository, conversationKey, expected);
    expect(waiting).toBe(false);
  }, 20_000);

  it('goes past an archive marked complete too early, and finds the real beginning', async () => {
    const { sim, repository, expected, conversationKey } = await setup({ count: 200, participants: PEOPLE, seed: 33 }, { initialLoaded: 30, pageSize: 25 });
    // Teams stops loading older messages after two loads, without a spinner: the run takes that for the beginning.
    const early = await runEngine({
      repository,
      mode: 'full',
      onProgress: () => {
        if (sim.fetchCount >= 2) sim.historyBlocked = true;
      },
    });
    expect(early).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    const partial = await repository.countMessages(conversationKey);
    expect(partial).toBe(80);
    const marked = await repository.getConversation(conversationKey);
    expect(coverageStatus(marked!.coverage, marked!.newestSortKey)).toBe('complete');

    // Teams loads again. A run stopped part of the way no longer claims the beginning.
    sim.historyBlocked = false;
    const control = new ScrapeControl();
    const stopped = await runEngine({
      repository,
      mode: 'full',
      control,
      onProgress: (progress) => {
        if (progress.counters.inserted >= 10) control.stop();
      },
    });
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'user-stop' });
    const between = await repository.getConversation(conversationKey);
    expect(coverageStatus(between!.coverage, between!.newestSortKey)).toBe('partial');

    const full = await runEngine({ repository, mode: 'full' });
    expect(full).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(full.counters.seekPasses).toBeGreaterThan(0);
    await expectArchiveToMatch(repository, conversationKey, expected);
    const after = await repository.getConversation(conversationKey);
    expect(after?.coverage).toEqual([
      { oldest: Date.parse(expected[0]!.time), newest: Date.parse(expected[expected.length - 1]!.time), reachedBeginning: true },
    ]);
  }, 30_000);
});

describe('a view that jumps to another part of the chat', () => {
  const SPLIT = 'A gap in the message list could not be closed; archive coverage was split at this point.';

  it('goes back for the messages it passed when the view jumps to an older message during a run', async () => {
    const { sim, repository, expected, conversationKey } = await setup({ count: 300, participants: PEOPLE, selfName: 'Me', seed: 41 }, { initialLoaded: 30, pageSize: 25 });
    let jumped = false;
    let filling = false;
    const result = await runEngine({
      repository,
      mode: 'full',
      onProgress: (progress) => {
        // As when someone opens a search result: Teams shows a page around an old message.
        if (!jumped && progress.counters.uniqueSeen >= 80) {
          jumped = true;
          sim.jumpTo(20);
        }
        filling ||= progress.fillingGap;
      },
    });

    expect(jumped).toBe(true);
    expect(filling).toBe(true);
    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(result.counters.gapsUnrecovered).toBeGreaterThan(0);
    expect(result.warnings).not.toContain(SPLIT);
    expect(result.counters.inserted).toBe(expected.length);
    await expectArchiveToMatch(repository, conversationKey, expected);
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation?.coverage).toEqual([
      { oldest: Date.parse(expected[0]!.time), newest: Date.parse(expected[expected.length - 1]!.time), reachedBeginning: true },
    ]);
  }, 30_000);

  it('fills the stretch between an earlier run and a view that was left on an older message', async () => {
    const { sim, repository, expected, conversationKey } = await setup({ count: 300, participants: PEOPLE, seed: 42 }, { initialLoaded: 30, pageSize: 25 });
    const control = new ScrapeControl();
    await runEngine({
      repository,
      mode: 'full',
      control,
      onProgress: (progress) => {
        if (progress.counters.uniqueSeen >= 60) control.stop();
      },
    });
    const partial = await repository.countMessages(conversationKey);

    // Before the next run, the chat was left on a search result far back.
    sim.jumpTo(40);
    const result = await runEngine({ repository, mode: 'full' });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(result.counters.inserted).toBe(expected.length - partial);
    await expectArchiveToMatch(repository, conversationKey, expected);
    const conversation = await repository.getConversation(conversationKey);
    expect(coverageStatus(conversation!.coverage, conversation!.newestSortKey)).toBe('complete');
  }, 30_000);

  it('finishes with the hole, and says so, when Teams does not load the messages in between', async () => {
    const { sim, repository, conversationKey } = await setup({ count: 300, participants: PEOPLE, seed: 43 }, { initialLoaded: 30, pageSize: 25 });
    let jumped = false;
    const result = await runEngine({
      repository,
      mode: 'full',
      onProgress: (progress) => {
        if (!jumped && progress.counters.uniqueSeen >= 80) {
          jumped = true;
          sim.jumpTo(20);
          sim.historyBlocked = true;
        }
      },
    });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(result.warnings.some((warning) => warning.startsWith('The run could not get back'))).toBe(true);
    const conversation = await repository.getConversation(conversationKey);
    expect(conversation!.coverage).toHaveLength(2);
    expect(coverageStatus(conversation!.coverage, conversation!.newestSortKey)).toBe('partial');
  }, 30_000);
});
