/** While a capture runs, the background keeps the computer awake; paused, ended or gone quiet, it lets it sleep. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleBackgroundRequest, syncKeepAwake, type RouterDeps } from '../../src/background/router';
import type { BackgroundRequest, SessionBeginResponse } from '../../src/shared/protocol';
import { emptyCounters } from '../../src/shared/types';
import type { ArchiveRepository } from '../../src/storage/repository';
import { openTestRepository } from '../helpers/fixtures';
import { CK, CONVERSATION } from '../helpers/messages';

let repository: ArchiveRepository;
let deps: RouterDeps;
let clock: number;
let awake: boolean[];
let ids = 0;

beforeEach(async () => {
  repository = await openTestRepository();
  clock = Date.parse('2024-01-15T12:00:00.000Z');
  awake = [];
  deps = {
    getRepository: async () => repository,
    now: () => new Date(clock),
    newId: () => `session-${++ids}`,
    staleSessionMs: 90_000,
    keepAwake: (value) => void awake.push(value),
  };
});

afterEach(() => repository.close());

function send<T>(request: BackgroundRequest): Promise<T> {
  return handleBackgroundRequest(JSON.parse(JSON.stringify(request)), { tabId: 3 }, deps) as Promise<T>;
}

async function begin(): Promise<string> {
  const request = { type: 'session/begin', conversation: CONVERSATION, mode: 'full', rescan: false, resumeOf: null, rangeStart: null, save: null } as BackgroundRequest;
  return (await send<SessionBeginResponse>(request)).sessionId;
}

const heartbeat = (sessionId: string, status: 'running' | 'paused') => send({ type: 'session/heartbeat', sessionId, status, counters: emptyCounters() });

describe('keeping the computer awake', () => {
  it('from the start of a run to its end, but not while it is paused', async () => {
    const sessionId = await begin();
    expect(awake).toEqual([true]);
    await heartbeat(sessionId, 'paused');
    await heartbeat(sessionId, 'running');
    await send({ type: 'session/end', sessionId, conversationKey: CK, status: 'completed', stopReason: 'reached-top', error: null, counters: emptyCounters(), segments: [], warnings: [] });
    expect(awake).toEqual([true, false, true, false]);
  });

  it('lets the computer sleep once a run has gone quiet (its tab reloaded)', async () => {
    await begin();
    clock += 2 * 60_000;
    await syncKeepAwake(repository, deps, clock);
    expect(awake).toEqual([true, false]);
  });

  it('never fails a request when power management fails', async () => {
    deps.keepAwake = () => {
      throw new Error('No power API');
    };
    const sessionId = await begin();
    expect(await repository.getSession(sessionId)).toMatchObject({ status: 'running' });
  });
});
