/**
 * Background service worker: the single writer of the archive database.
 * Content scripts cannot use the extension's IndexedDB directly (they run in the page origin),
 * so every captured batch is sent here.
 */
import { saveTargetHash } from '../export/options';
import { newId } from '../shared/ids';
import { isBackgroundRequest, STALE_SESSION_MS, TEAMS_URL_PATTERN, type Response } from '../shared/protocol';
import { ArchiveRepository } from '../storage/repository';
import { handleBackgroundRequest, syncKeepAwake, type RouterDeps } from './router';

/** While the computer is kept awake, this alarm checks every minute that a capture still runs. */
const KEEP_AWAKE_ALARM = 'keep-awake-check';

let repositoryPromise: Promise<ArchiveRepository> | null = null;

function getRepository(): Promise<ArchiveRepository> {
  if (!repositoryPromise) {
    repositoryPromise = ArchiveRepository.open().catch((error: unknown) => {
      repositoryPromise = null;
      throw error;
    });
  }
  return repositoryPromise;
}

const deps: RouterDeps = {
  getRepository,
  now: () => new Date(),
  newId,
  staleSessionMs: STALE_SESSION_MS,
  openSaveTab: async (sessionId, openerTabId) => {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`save.html${saveTargetHash({ kind: 'session', sessionId })}`),
      ...(openerTabId === null ? {} : { openerTabId }),
    });
  },
  // 'display' keeps the screen on too: with the screen off, Edge treats the Teams tab as hidden,
  // and the run pauses until it is shown again.
  keepAwake: (awake) => {
    if (awake) {
      chrome.power.requestKeepAwake('display');
      // Recreated with every heartbeat, so it only fires once heartbeats stop (a reloaded tab).
      void chrome.alarms.create(KEEP_AWAKE_ALARM, { periodInMinutes: 1 });
    } else {
      chrome.power.releaseKeepAwake();
      void chrome.alarms.clear(KEEP_AWAKE_ALARM);
    }
  },
};

function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab) return TEAMS_URL_PATTERN.test(sender.url ?? sender.tab.url ?? '');
  return (sender.url ?? '').startsWith(`chrome-extension://${chrome.runtime.id}/`) || (sender.url ?? '').startsWith(`extension://${chrome.runtime.id}/`);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (response: Response<unknown>) => void) => {
  if (!isBackgroundRequest(message)) return false;
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: 'Request rejected: untrusted sender' });
    return false;
  }
  handleBackgroundRequest(message, { tabId: sender.tab?.id ?? null }, deps).then(
    (data) => sendResponse({ ok: true, data }),
    (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // keep the channel open for the async response
});

function markStale(): void {
  getRepository()
    .then(async (repository) => {
      await repository.markStaleSessions(Date.now(), STALE_SESSION_MS);
      await syncKeepAwake(repository, deps, Date.now());
    })
    .catch((error: unknown) => console.warn('[teams-chat-extractor] could not check stale sessions', error));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  getRepository()
    .then(async (repository) => {
      await repository.markStaleSessions(Date.now(), 0, tabId);
      await syncKeepAwake(repository, deps, Date.now());
    })
    .catch((error: unknown) => console.warn('[teams-chat-extractor] could not close sessions of a removed tab', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEP_AWAKE_ALARM) markStale();
});

chrome.runtime.onStartup.addListener(markStale);
chrome.runtime.onInstalled.addListener(markStale);
