/** A capture that saves a file: the background keeps the choice and opens the save page once, when the run ends. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleBackgroundRequest, savesFileAfter, type RouterDeps } from '../../src/background/router';
import { FULL_CONTENT, type SaveChoices } from '../../src/export/options';
import type { BackgroundRequest, SessionBeginResponse, SessionEndResponse } from '../../src/shared/protocol';
import { emptyCounters, type SessionStatus, type StopReason } from '../../src/shared/types';
import type { ArchiveRepository } from '../../src/storage/repository';
import { openTestRepository } from '../helpers/fixtures';
import { CK, CONVERSATION } from '../helpers/messages';

let repository: ArchiveRepository;
let deps: RouterDeps;
let opened: Array<{ sessionId: string; openerTabId: number | null }>;
let ids = 0;

const PDF: SaveChoices = { format: 'pdf', content: { ...FULL_CONTENT, systemMessages: false } };

beforeEach(async () => {
  repository = await openTestRepository();
  opened = [];
  deps = {
    getRepository: async () => repository,
    now: () => new Date('2024-01-15T12:00:00.000Z'),
    newId: () => `session-${++ids}`,
    staleSessionMs: 90_000,
    openSaveTab: async (sessionId, openerTabId) => void opened.push({ sessionId, openerTabId }),
  };
});

afterEach(() => repository.close());

/** Requests travel as JSON, like chrome.runtime messages. */
async function send<T>(request: BackgroundRequest): Promise<T> {
  return JSON.parse(JSON.stringify(await handleBackgroundRequest(JSON.parse(JSON.stringify(request)), { tabId: 3 }, deps))) as T;
}

async function begin(save: unknown): Promise<string> {
  const request = { type: 'session/begin', conversation: CONVERSATION, mode: 'full', rescan: false, resumeOf: null, rangeStart: null, save } as BackgroundRequest;
  return (await send<SessionBeginResponse>(request)).sessionId;
}

function end(sessionId: string, status: SessionStatus, stopReason: StopReason): Promise<SessionEndResponse> {
  return send<SessionEndResponse>({ type: 'session/end', sessionId, conversationKey: CK, status, stopReason, error: null, counters: emptyCounters(), segments: [], warnings: [] });
}

describe('a capture that saves a file', () => {
  it('keeps the file chosen on its session, repaired, and none when none was chosen', async () => {
    const saving = await begin(PDF);
    expect((await repository.getSession(saving))?.save).toEqual(PDF);
    const old = await begin({ format: 'csv', content: { images: false } });
    expect((await repository.getSession(old))?.save).toEqual({ format: 'pdf', content: { ...FULL_CONTENT, images: false } });
    expect((await repository.getSession(await begin(null)))?.save).toBeNull();
  });

  it('opens the save page next to its tab when it ends, once', async () => {
    const sessionId = await begin(PDF);
    expect(await end(sessionId, 'completed', 'range-reached')).toMatchObject({ savingFile: true });
    expect(opened).toEqual([{ sessionId, openerTabId: 3 }]);
    // The tab reports the end again (a retry): no second page.
    expect(await end(sessionId, 'completed', 'range-reached')).toMatchObject({ savingFile: false });
    expect(opened).toHaveLength(1);
  });

  it('saves nothing after Stop, a failure, or without a file chosen', async () => {
    expect(await end(await begin(PDF), 'stopped', 'user-stop')).toMatchObject({ savingFile: false });
    expect(await end(await begin(PDF), 'failed', 'error')).toMatchObject({ savingFile: false });
    expect(await end(await begin(null), 'completed', 'history-complete')).toMatchObject({ savingFile: false });
    expect(opened).toEqual([]);
  });

  it('still ends the run when the page cannot be opened', async () => {
    deps.openSaveTab = async () => {
      throw new Error('No browser window');
    };
    const sessionId = await begin(PDF);
    expect(await end(sessionId, 'completed', 'history-complete')).toMatchObject({ savingFile: false });
    expect((await repository.getSession(sessionId))?.status).toBe('completed');
  });

  it('saves after a run that completed or stopped on its own', () => {
    expect(savesFileAfter('completed', 'history-complete')).toBe(true);
    expect(savesFileAfter('stopped', 'max-duration')).toBe(true);
    expect(savesFileAfter('stopped', 'conversation-changed')).toBe(true);
    expect(savesFileAfter('stopped', 'user-stop')).toBe(false);
    expect(savesFileAfter('failed', 'error')).toBe(false);
    expect(savesFileAfter('interrupted', 'interrupted')).toBe(false);
  });
});
