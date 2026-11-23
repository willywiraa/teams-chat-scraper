/**
 * The archive page: Conversations, Backup and import, and Settings one under the other, with
 * About at the end; and the messages of one chat. The address chooses what is shown
 * (#conversations, #backup, #settings, #conversation/<key>, …), so Back and Forward work and the
 * popup can link straight to a chat.
 */
import { importArchiveFile } from '../export/import';
import { ArchiveRepository } from '../storage/repository';
import { renderBackup, wireBackup } from './archive/backup';
import type { AppContext, MessageKind } from './archive/context';
import { closeConversation, showConversation, wireConversationView } from './archive/conversation-view';
import { buildConversationList, renderConversations, resumeMerges, wireConversationDialogs } from './archive/conversations';
import { buildSettings, showSettings } from './archive/settings-view';
import { byId, countOf, el, errorText, formatNumber } from './common';
import { normalizeTheme, readTheme, saveTheme, THEME_CHOICES, THEME_STORAGE_KEY } from './theme';
import { parseRoute, routeHash, type PageSection, type Route } from './view-models';

const APP_NAME = 'Teams Chat Scraper';
const VIEWS = ['home', 'conversation'] as const;

/** Each part of the page: the element to scroll to, and the heading that takes the focus. */
const SECTIONS: Record<PageSection, { element: string; heading: string }> = {
  conversations: { element: 'section-conversations', heading: 'conversations-title' },
  backup: { element: 'section-backup', heading: 'backup-title' },
  settings: { element: 'section-settings', heading: 'settings-title' },
  advanced: { element: 'settings-advanced', heading: 'advanced-title' },
};

let repositoryPromise: Promise<ArchiveRepository> | null = null;
function repository(): Promise<ArchiveRepository> {
  repositoryPromise ??= ArchiveRepository.open();
  return repositoryPromise;
}

// ------------------------------------------------------------ status line

/** True while the last message should survive the next navigation. */
let carryMessage = false;

function notify(text: string, kind: MessageKind = 'notice', options: { carry?: boolean } = {}): void {
  const element = byId('archive-message');
  element.textContent = text;
  element.className = `${kind} small`;
  element.hidden = text === '';
  carryMessage = Boolean(options.carry) && text !== '';
}

// ----------------------------------------------------------------- routing

let current: Route = parseRoute(location.hash);
/** Increases with every view shown, so a slow view drawn for an earlier address does not take the focus. */
let shownCount = 0;
/** Shows "Reading the archive…" when a view takes a moment to draw; the page opens with it shown. */
let loadingTimer: ReturnType<typeof setTimeout> | undefined;

const app: AppContext = {
  repository,
  notify,
  go(route) {
    const hash = routeHash(route);
    if (location.hash === hash) void show(route, { navigated: true });
    else location.hash = hash;
  },
  refresh: () => show(current, { navigated: false }),
};

async function show(route: Route, { navigated }: { navigated: boolean }): Promise<void> {
  const previous = current;
  current = route;
  const mine = ++shownCount;
  if (navigated) {
    if (!carryMessage) notify('');
    carryMessage = false;
  }
  if (previous.view === 'conversation' && route.view !== 'conversation') closeConversation();
  for (const view of VIEWS) byId(`view-${view}`).hidden = view !== route.view;
  byId(`view-${route.view}`).setAttribute('aria-busy', 'true');
  if (navigated) {
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => (byId('archive-loading').hidden = false), 200);
  }
  let title = APP_NAME;
  try {
    if (route.view === 'home') await Promise.all([renderConversations(app), renderBackup(app), showSettings(route.section === 'advanced')]);
    else title = `${(await showConversation(app, route.key)) || 'Conversation'} · ${APP_NAME}`;
  } catch (error) {
    notify(errorText(error), 'error');
  }
  if (mine !== shownCount) return;
  clearTimeout(loadingTimer);
  byId('archive-loading').hidden = true;
  for (const view of VIEWS) byId(`view-${view}`).removeAttribute('aria-busy');
  document.title = title;
  if (navigated) place(route);
}

/**
 * Brings what the address names into view, and moves the focus to its heading, so keyboard and
 * screen reader users start there. A conversation opens at its newest message, the last one.
 */
function place(route: Route): void {
  if (route.view === 'conversation') {
    window.scrollTo(0, 0);
    byId('conv-view-title').focus({ preventScroll: true });
    byId('conv-view-messages').lastElementChild?.scrollIntoView({ block: 'end' });
    return;
  }
  const part = SECTIONS[route.section ?? 'conversations'];
  if (route.section && route.section !== 'conversations') byId(part.element).scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 0);
  byId(part.heading).focus({ preventScroll: true });
}

/** The theme select in the header; it follows a choice made in another page of the extension. */
function wireTheme(): void {
  const select = byId<HTMLSelectElement>('header-theme');
  select.replaceChildren(...THEME_CHOICES.map(({ value, label }) => el('option', { value }, label)));
  select.value = readTheme();
  select.addEventListener('change', () => saveTheme(normalizeTheme(select.value)));
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) select.value = normalizeTheme(event.newValue);
  });
}

// ------------------------------------------------------------------ import

async function importFile(file: File): Promise<void> {
  try {
    notify(`Checking ${file.name}…`, 'notice', { carry: true });
    const summary = await importArchiveFile(await repository(), file, {
      onProgress: (progress) =>
        notify(
          progress.phase === 'checking'
            ? `Checking ${file.name}: ${formatNumber(progress.messages)} messages so far. Nothing is written until the whole file has been checked.`
            : `Importing: ${formatNumber(progress.messages)} messages written (${progress.conversations} conversations finished)…`,
          'notice',
          { carry: true },
        ),
    });
    const images = summary.imagesInserted + summary.imagesUnchanged;
    const placed = [
      summary.joinedExisting > 0 ? `${summary.joinedExisting} added to an entry of the same chat under another name` : '',
      summary.keptSeparate > 0 ? `${summary.keptSeparate} kept separate because an archived chat with the same title holds other messages` : '',
    ].filter(Boolean);
    notify(
      `Imported ${countOf(summary.conversations, 'conversation')}${placed.length > 0 ? ` (${placed.join('; ')})` : ''}: ` +
        `${formatNumber(summary.inserted)} new, ${formatNumber(summary.updated)} merged, ${formatNumber(summary.unchanged)} already present.` +
        (images > 0 ? ` Images: ${formatNumber(summary.imagesInserted)} new, ${formatNumber(summary.imagesUnchanged)} already present.` : ''),
      'success',
      { carry: true },
    );
    await app.refresh();
  } catch (error) {
    notify(`Import failed: ${errorText(error)}`, 'error', { carry: true });
  }
}

// ------------------------------------------------------------------- start

function wire(): void {
  const input = byId<HTMLInputElement>('import-file');
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-import]')) button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) void importFile(file);
  });
  wireTheme();
  wireBackup(app);
  byId('about-version').textContent = `Teams Chat Scraper, version ${chrome.runtime.getManifest().version}`;
  window.addEventListener('hashchange', () => void show(parseRoute(location.hash), { navigated: true }));
}

async function main(): Promise<void> {
  buildConversationList(app);
  wireConversationDialogs(app);
  wireConversationView(app);
  buildSettings();
  wire();
  await resumeMerges(app);
  await show(parseRoute(location.hash), { navigated: true });
  document.addEventListener('visibilitychange', () => {
    // The message view keeps its place: it is drawn again only when opened again. The page is
    // drawn again, for a backup or a capture made in another tab.
    if (document.visibilityState === 'visible' && current.view !== 'conversation') void app.refresh();
  });
}

void main();
