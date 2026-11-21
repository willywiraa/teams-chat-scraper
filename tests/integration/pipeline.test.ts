/**
 * The whole pipeline as it runs in the browser: content-script controller → (JSON-serialised,
 * like chrome.runtime messaging) → background router → IndexedDB archive.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { handleBackgroundRequest, type RouterDeps } from '../../src/background/router';
import { ContentController, type ContentControllerDeps } from '../../src/content/controller';
import { newId } from '../../src/shared/ids';
import { STALE_SESSION_MS, type BackgroundRequest, type ContentStatus } from '../../src/shared/protocol';
import { emptyCounters } from '../../src/shared/types';
import type { ArchiveRepository } from '../../src/storage/repository';
import { ChatSimulator, generateConversation, type ExpectedMessage } from '../helpers/chat-simulator';
import { TEAMS_URL, detect, fastSettings, openTestRepository } from '../helpers/fixtures';
import { FakeImageReader, fakeImageBytes } from '../helpers/images';

const PEOPLE = ['Alice Andersen', 'Bob Brown', 'Carol Chen'];

let simulator: ChatSimulator | null = null;
let archive: ArchiveRepository | null = null;
const controllers: ContentController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
    await controller.whenIdle();
  }
  simulator?.dispose();
  simulator = null;
  archive?.close();
  archive = null;
  document.body.innerHTML = '';
});

async function setup(count: number, seed: number): Promise<{ repository: ArchiveRepository; expected: ExpectedMessage[]; conversationKey: string }> {
  const { items, expected } = generateConversation({ count, participants: PEOPLE, selfName: 'Me', seed, dividerEvery: 40 });
  simulator = new ChatSimulator({ items });
  archive = await openTestRepository();
  return { repository: archive, expected, conversationKey: detect().conversationKey };
}

const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface TransportOptions {
  tabId?: number;
  /** Return an error to make this request fail (as if the background could not be reached). */
  fail?: (request: BackgroundRequest) => Error | null;
}

function transport(repository: ArchiveRepository, options: TransportOptions = {}) {
  const deps: RouterDeps = { getRepository: async () => repository, now: () => new Date(), newId, staleSessionMs: STALE_SESSION_MS };
  const log: string[] = [];
  const send = async <T>(request: BackgroundRequest): Promise<T> => {
    const copy = jsonClone(request);
    log.push(copy.type);
    const failure = options.fail?.(copy);
    if (failure) throw failure;
    return jsonClone(await handleBackgroundRequest(copy, { tabId: options.tabId ?? 1 }, deps)) as T;
  };
  return { send, log };
}

function createController(send: ContentControllerDeps['send'], extra: Partial<ContentControllerDeps> = {}): ContentController {
  const controller = new ContentController({
    doc: document,
    getHref: () => TEAMS_URL,
    send,
    loadSettings: async () => fastSettings(),
    locale: 'en-US',
    heartbeatMs: 20,
    retryDelaysMs: [5, 10],
    ...extra,
  });
  controllers.push(controller);
  return controller;
}

async function waitForStatus(controller: ContentController, predicate: (status: ContentStatus) => boolean, label: string): Promise<ContentStatus> {
  const started = Date.now();
  for (;;) {
    const status = await controller.status();
    if (predicate(status)) return status;
    if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('content controller + background router + archive', () => {
  it('extracts a conversation end to end and records the session', async () => {
    const { repository, expected, conversationKey } = await setup(150, 21);
    const { send, log } = transport(repository);
    const controller = createController(send);

    const before = await controller.status();
    expect(before).toMatchObject({ state: 'idle', conversationError: null, session: null });
    expect(before.conversation?.conversationKey).toBe(conversationKey);
    expect(before.visibleMessages).toBeGreaterThan(0);

    const { sessionId } = await controller.start({ mode: 'full', rescan: false, resumeOf: null });
    const result = await controller.whenIdle();

    expect(result).toMatchObject({ sessionId, status: 'completed', stopReason: 'reached-top', mode: 'full', conversationKey });
    expect(await repository.countMessages(conversationKey)).toBe(expected.length);
    expect(await repository.getSession(sessionId)).toMatchObject({
      status: 'completed',
      stopReason: 'reached-top',
      tabId: 1,
      mode: 'full',
      counters: { inserted: expected.length, gapsUnrecovered: 0 },
    });
    expect((await repository.getSession(sessionId))?.endedAt).not.toBeNull();
    expect((await controller.status()).state).toBe('idle');
    expect(log[0]).toBe('session/begin');
    expect(log).toContain('session/batch');
    expect(log[log.length - 1]).toBe('session/end');
  });

  it('saves displayed images through the background before the messages that show them', async () => {
    const { items, expected } = generateConversation({ count: 70, participants: PEOPLE, selfName: 'Me', seed: 31, withImagesEvery: 6 });
    simulator = new ChatSimulator({ items });
    archive = await openTestRepository();
    const repository = archive;
    const conversationKey = detect().conversationKey;
    const { send, log } = transport(repository);
    let missing = 0;
    const checked: ContentControllerDeps['send'] = async (request) => {
      if (request.type === 'session/batch') {
        for (const message of request.messages) {
          for (const attachment of message.attachments) if (attachment.imageId && !(await repository.getImage(conversationKey, attachment.imageId))) missing++;
        }
      }
      return send(request);
    };
    const reader = new FakeImageReader();
    const controller = createController(checked, { imageReader: reader });
    const { sessionId } = await controller.start({ mode: 'full', rescan: false, resumeOf: null });
    const result = await controller.whenIdle();

    const imageCount = expected.reduce((sum, message) => sum + message.attachments.filter((name) => name === 'image').length, 0);
    expect(imageCount).toBe(22);
    expect(result).toMatchObject({ status: 'completed', counters: { imagesSaved: imageCount, imagesFailed: 0 } });
    expect(missing).toBe(0);
    expect(log).toContain('session/images');
    expect(log).not.toContain('session/image-part');
    expect(await repository.countImages(conversationKey)).toBe(imageCount);
    expect((await repository.getSession(sessionId))?.counters).toMatchObject({ imagesSaved: imageCount, imagesFailed: 0 });
    const stored = await repository.getMessages(conversationKey);
    for (const attachment of stored.flatMap((message) => message.attachments)) {
      const image = await repository.getImage(conversationKey, attachment.imageId as string);
      expect(new Uint8Array(image!.data)).toEqual(fakeImageBytes(attachment.url as string));
    }
  });

  it('sends images that are too large for one message in parts', async () => {
    const { items, expected } = generateConversation({ count: 30, participants: PEOPLE, seed: 32, withImagesEvery: 4 });
    simulator = new ChatSimulator({ items });
    archive = await openTestRepository();
    const conversationKey = detect().conversationKey;
    const { send, log } = transport(archive);
    // 64-byte fake images are 88 base64 characters: two parts each.
    const controller = createController(send, { imageReader: new FakeImageReader(), imageRequestChars: 64 });
    await controller.start({ mode: 'full', rescan: false, resumeOf: null });
    const result = await controller.whenIdle();

    const imageCount = expected.reduce((sum, message) => sum + message.attachments.filter((name) => name === 'image').length, 0);
    expect(result).toMatchObject({ status: 'completed', counters: { imagesSaved: imageCount, imagesFailed: 0 } });
    expect(log.filter((type) => type === 'session/image-part')).toHaveLength(imageCount * 2);
    expect(log).not.toContain('session/images');
    expect(await archive.countImages(conversationKey)).toBe(imageCount);
  });

  it('retries a background call that fails temporarily', async () => {
    const { repository, expected, conversationKey } = await setup(80, 22);
    let failures = 0;
    const { send } = transport(repository, {
      fail: (request) => (request.type === 'session/batch' && failures++ < 2 ? new Error('Could not establish connection. Receiving end does not exist.') : null),
    });
    const controller = createController(send);
    await controller.start({ mode: 'full', rescan: false, resumeOf: null });

    expect(await controller.whenIdle()).toMatchObject({ status: 'completed' });
    expect(failures).toBeGreaterThanOrEqual(2);
    expect(await repository.countMessages(conversationKey)).toBe(expected.length);
  });

  it('leaves an interrupted session resumable and completes it later without duplicates', async () => {
    const { repository, expected, conversationKey } = await setup(300, 23);
    let batches = 0;
    let broken = false;
    // The extension is reloaded mid-run: from then on every call from this content script fails.
    const first = transport(repository, {
      fail: (request) => {
        if (request.type === 'session/batch' && ++batches > 10) broken = true;
        return broken ? new Error('Extension context invalidated.') : null;
      },
    });
    const interruptedController = createController(first.send);
    const { sessionId } = await interruptedController.start({ mode: 'full', rescan: false, resumeOf: null });
    const interrupted = await interruptedController.whenIdle();

    expect(interrupted).toMatchObject({ status: 'failed', stopReason: 'error' });
    expect(interrupted?.error).toMatch(/Reload this Teams tab/);
    const partial = await repository.countMessages(conversationKey);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(expected.length);
    // The end of the session could not be reported, so it still looks like it is running...
    expect((await repository.getSession(sessionId))?.status).toBe('running');
    expect(await repository.findResumableSession(conversationKey)).toBeNull();
    // ...until its heartbeat is overdue, which the background checks on startup and on each new session.
    expect(await repository.markStaleSessions(Date.now() + STALE_SESSION_MS + 1_000, STALE_SESSION_MS)).toBe(1);
    const resumable = await repository.findResumableSession(conversationKey);
    expect(resumable).toMatchObject({ sessionId, status: 'interrupted', stopReason: 'interrupted' });

    const second = transport(repository);
    const resumingController = createController(second.send);
    const resumed = await resumingController.start({ mode: 'full', rescan: false, resumeOf: resumable!.sessionId });
    const result = await resumingController.whenIdle();

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(result?.counters.seekPasses).toBeGreaterThan(0);
    expect(result?.counters.inserted).toBe(expected.length - partial);
    expect(await repository.countMessages(conversationKey)).toBe(expected.length);
    expect(await repository.getSession(resumed.sessionId)).toMatchObject({ resumeOf: sessionId, status: 'completed' });
    expect(await repository.findResumableSession(conversationKey)).toBeNull();
  });

  it('pauses, resumes and stops on command', async () => {
    const { repository, conversationKey } = await setup(400, 24);
    const { send } = transport(repository);
    const controller = createController(send);
    const { sessionId } = await controller.start({ mode: 'full', rescan: false, resumeOf: null });

    await waitForStatus(controller, (status) => (status.progress?.counters.passes ?? 0) >= 2, 'two passes');
    expect(controller.pause()).toBe(true);
    const paused = await waitForStatus(controller, (status) => status.progress?.phase === 'paused', 'paused phase');
    expect(paused.state).toBe('paused');
    // Heartbeats keep the session alive and record that it is paused.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await repository.getSession(sessionId))?.status).toBe('paused');

    expect(controller.resume()).toBe(true);
    await waitForStatus(controller, (status) => status.progress?.phase === 'running', 'running phase');
    expect(controller.stop()).toBe(true);
    const result = await controller.whenIdle();

    expect(result).toMatchObject({ status: 'stopped', stopReason: 'user-stop' });
    expect(await repository.getSession(sessionId)).toMatchObject({ status: 'stopped', stopReason: 'user-stop' });
    expect((await repository.findResumableSession(conversationKey))?.sessionId).toBe(sessionId);
    expect(controller.pause()).toBe(false);
  });

  it('keeps the final status of a session when a late heartbeat or batch arrives', async () => {
    const { repository, conversationKey } = await setup(20, 27);
    const conversation = detect();
    const { send } = transport(repository);
    const begin = await send<{ sessionId: string }>({ type: 'session/begin', conversation, mode: 'full', rescan: false, resumeOf: null });
    await send({
      type: 'session/end',
      sessionId: begin.sessionId,
      conversationKey,
      status: 'completed',
      stopReason: 'reached-top',
      error: null,
      counters: emptyCounters(),
      segments: [],
      warnings: [],
    });

    const heartbeat = await send<{ recorded: boolean }>({ type: 'session/heartbeat', sessionId: begin.sessionId, status: 'running', counters: emptyCounters() });
    expect(heartbeat.recorded).toBe(false);
    await send({ type: 'session/batch', sessionId: begin.sessionId, conversation, messages: [], segments: [], counters: emptyCounters(), warnings: [] });
    expect(await repository.getSession(begin.sessionId)).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
  });

  it('refuses a second extraction in the same tab', async () => {
    const { repository } = await setup(200, 25);
    const controller = createController(transport(repository).send);
    await controller.start({ mode: 'full', rescan: false, resumeOf: null });
    await expect(controller.start({ mode: 'full', rescan: false, resumeOf: null })).rejects.toThrow(/already running/);
    controller.stop();
    expect(await controller.whenIdle()).toMatchObject({ status: 'stopped' });
  });

  it('explains when no conversation is open', async () => {
    archive = await openTestRepository();
    document.body.innerHTML = '<div data-tid="app-shell"><p>Activity feed</p></div>';
    const controller = createController(transport(archive).send);
    expect(await controller.status()).toMatchObject({ state: 'idle', conversation: null, visibleMessages: null });
    await expect(controller.start({ mode: 'full', rescan: false, resumeOf: null })).rejects.toThrow(/No conversation detected/);
  });

  it('continues a renamed chat in its archive entry', async () => {
    const { items, expected } = generateConversation({ count: 60, participants: PEOPLE, selfName: 'Me', seed: 41 });
    simulator = new ChatSimulator({ items, threadId: null, title: 'Old name' });
    archive = await openTestRepository();
    const repository = archive;
    const { send } = transport(repository);
    await createController(send).start({ mode: 'full', rescan: false, resumeOf: null });
    expect(await controllers[0]!.whenIdle()).toMatchObject({ status: 'completed', conversationKey: 'title:old name' });
    expect(await repository.countMessages('title:old name')).toBe(expected.length);

    // Teams shows the chat under its new name; no chat id is shown.
    simulator.dispose();
    simulator = new ChatSimulator({ items, threadId: null, title: 'New name' });
    const renamed = createController(send);
    const idle = await renamed.status();
    expect(idle.conversation?.conversationKey).toBe('title:new name');
    expect(idle.evidence?.messages.length).toBeGreaterThan(1);
    expect(JSON.stringify(idle.evidence)).not.toMatch(/Message \d+ from/);

    const { sessionId } = await renamed.start({ mode: 'incremental', rescan: false, resumeOf: null });
    expect((await renamed.status()).session?.conversation.conversationKey).toBe('title:old name');
    expect(await renamed.whenIdle()).toMatchObject({ status: 'completed', conversationKey: 'title:old name', counters: { inserted: 0 } });
    expect(await repository.getConversation('title:new name')).toBeUndefined();
    expect(await repository.getConversation('title:old name')).toMatchObject({ title: 'New name', aliases: ['title:new name'], messageCount: expected.length });
    expect((await repository.getConversation('title:old name'))?.titleHistory?.map((seen) => seen.title)).toEqual(['Old name', 'New name']);
    expect(await repository.getSession(sessionId)).toMatchObject({ conversationKey: 'title:old name', detectedKey: 'title:new name', status: 'completed' });
  });

  it('gives a different chat with the title of an archived chat an entry of its own', async () => {
    const startMs = Date.UTC(2024, 0, 15, 9, 0, 0);
    const first = generateConversation({ count: 40, participants: ['Alice Andersen'], selfName: 'Me', seed: 51, startMs });
    simulator = new ChatSimulator({ items: first.items, threadId: null, title: 'Alice Andersen' });
    archive = await openTestRepository();
    const repository = archive;
    const { send } = transport(repository);
    await createController(send).start({ mode: 'full', rescan: false, resumeOf: null });
    await controllers[0]!.whenIdle();

    // Another person with the same name, chatting over the same hours.
    const second = generateConversation({ count: 40, participants: ['Alice Andersen (Sales)'], selfName: 'Me', seed: 52, startMs: startMs + 7 });
    simulator.dispose();
    simulator = new ChatSimulator({ items: second.items, threadId: null, title: 'Alice Andersen' });
    const other = createController(send);
    await other.start({ mode: 'full', rescan: false, resumeOf: null });
    const result = await other.whenIdle();

    expect(result?.conversationKey).toMatch(/^local:/);
    const ownKey = result?.conversationKey as string;
    expect(await repository.countMessages('title:alice andersen')).toBe(first.expected.length);
    expect(await repository.countMessages(ownKey)).toBe(second.expected.length);
    expect(await repository.getConversation(ownKey)).toMatchObject({ title: 'Alice Andersen', aliases: ['title:alice andersen'] });

    // Opened again later, each chat continues in its own entry.
    const again = createController(send);
    await again.start({ mode: 'incremental', rescan: false, resumeOf: null });
    expect(await again.whenIdle()).toMatchObject({ conversationKey: ownKey, counters: { inserted: 0 } });
    expect((await repository.listConversations()).length).toBe(2);
  });

  it('produces diagnostics that contain no message content or names', async () => {
    const { repository, expected } = await setup(40, 26);
    const controller = createController(transport(repository).send);
    const report = await controller.diagnostics();
    const json = JSON.stringify(report);

    expect(report.parse.messages).toBeGreaterThan(0);
    for (const name of [...PEOPLE, 'Project Alpha']) expect(json).not.toContain(name);
    for (const message of expected) expect(json).not.toContain(message.text.split('\n')[0]!);
  });
});
