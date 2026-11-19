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

function createController(send: ContentControllerDeps['send']): ContentController {
  const controller = new ContentController({
    doc: document,
    getHref: () => TEAMS_URL,
    send,
    loadSettings: async () => fastSettings(),
    locale: 'en-US',
    heartbeatMs: 20,
    retryDelaysMs: [5, 10],
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
