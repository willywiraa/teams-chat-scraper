/**
 * Content script entry point (Teams Web tabs). It is passive until the popup sends a
 * command: it never modifies Teams' DOM, only reads it and scrolls the message list.
 */
import { isContentCommand, type ContentCommand, type ContentCommandResult, type Response } from '../shared/protocol';
import { normalizeSettings, SETTINGS_STORAGE_KEY, type ScrapeSettings } from '../shared/settings';
import { ContentController } from './controller';
import { createPageImageReader } from './image-reader';

declare global {
  interface Window {
    __teamsChatExtractor?: { alive: () => boolean };
  }
}

async function sendToBackground<T>(request: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  if (!response) throw new Error('No response from the extension background worker');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

async function loadSettings(): Promise<ScrapeSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
}

async function handle(controller: ContentController, command: ContentCommand): Promise<ContentCommandResult> {
  switch (command.type) {
    case 'content/status':
      return controller.status();
    case 'content/start':
      return controller.start({ mode: command.mode, rescan: Boolean(command.rescan), resumeOf: command.resumeOf ?? null });
    case 'content/pause':
      return { accepted: controller.pause() };
    case 'content/resume':
      return { accepted: controller.resume() };
    case 'content/stop':
      return { accepted: controller.stop() };
    case 'content/diagnostics':
      return controller.diagnostics();
    default:
      throw new Error('Unknown command');
  }
}

(() => {
  // Avoid double registration when the popup re-injects the script into an already prepared tab.
  if (window.__teamsChatExtractor?.alive()) return;

  const controller = new ContentController({
    doc: document,
    getHref: () => location.href,
    send: sendToBackground,
    loadSettings,
    locale: navigator.language,
    imageReader: createPageImageReader(),
  });

  window.__teamsChatExtractor = {
    alive: () => {
      try {
        return Boolean(chrome.runtime?.id);
      } catch {
        return false;
      }
    },
  };

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (response: Response<ContentCommandResult>) => void) => {
    if (sender.id !== chrome.runtime.id || !isContentCommand(message)) return false;
    handle(controller, message).then(
      (data) => sendResponse({ ok: true, data }),
      (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
})();
