/**
 * Background service worker: the single writer of the archive database.
 * Content scripts cannot use the extension's IndexedDB directly (they run in the page origin),
 * so every captured batch is sent here.
 */
import { newId } from '../shared/ids';
import { isBackgroundRequest, STALE_SESSION_MS, TEAMS_URL_PATTERN, type Response } from '../shared/protocol';
import { ArchiveRepository } from '../storage/repository';
import { handleBackgroundRequest, type RouterDeps } from './router';

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
    .then((repository) => repository.markStaleSessions(Date.now(), STALE_SESSION_MS))
    .catch((error: unknown) => console.warn('[teams-chat-extractor] could not check stale sessions', error));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  getRepository()
    .then((repository) => repository.markStaleSessions(Date.now(), 0, tabId))
    .catch((error: unknown) => console.warn('[teams-chat-extractor] could not close sessions of a removed tab', error));
});

chrome.runtime.onStartup.addListener(markStale);
chrome.runtime.onInstalled.addListener(markStale);
