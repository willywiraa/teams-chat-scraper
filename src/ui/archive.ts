/**
 * The app page: Overview, Conversations (with the messages of one), Export and Settings. The
 * address chooses the section (#overview, #conversation/<key>, #settings/troubleshooting, …), so
 * Back and Forward work and the popup can link straight to a part of it.
 */
import { importArchiveFile } from '../export/import';
import type { ExportPreset } from '../export/options';
import { ArchiveRepository } from '../storage/repository';
import { byId, errorText, formatNumber } from './common';
import { ExportPanel } from './export-panel';
import type { AppContext, MessageKind } from './archive/context';
import { closeConversation, showConversation, wireConversationView } from './archive/conversation-view';
import { buildConversationList, renderConversations, resumeMerges, wireConversationDialogs } from './archive/conversations';
import { renderOverview, renderSessions, storageUsed } from './archive/overview';
import { buildSettings, settingsHeading, showSettings } from './archive/settings-view';
import { navOf, parseRoute, routeHash, type Route } from './view-models';

const APP_NAME = 'Teams Chat Archive';
const VIEWS = ['overview', 'conversations', 'conversation', 'export', 'settings'] as const;
const TITLES: Record<Route['view'], string> = {
  overview: 'Overview',
  conversations: 'Conversations',
  conversation: 'Conversation',
  export: 'Export',
  settings: 'Settings',
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
/** Increases with every section shown, so a slow section drawn for an earlier address does not take the focus. */
let shownCount = 0;
let exportPanel: ExportPanel | null = null;
/** What Export should select and set when it is shown next. */
let pendingExport: { keys?: readonly string[]; preset?: ExportPreset } | null = null;

const app: AppContext = {
  repository,
  notify,
  go(route) {
    const hash = routeHash(route);
    if (location.hash === hash) void show(route, { navigated: true });
    else location.hash = hash;
  },
  refresh: () => show(current, { navigated: false }),
  exportConversations(keys, preset) {
    pendingExport = { keys, preset };
    app.go({ view: 'export' });
  },
};

async function show(route: Route, { navigated }: { navigated: boolean }): Promise<void> {
  const previous = current;
  current = route;
  const mine = ++shownCount;
  if (navigated) {
    if (!carryMessage) notify('');
    carryMessage = false;
    window.scrollTo(0, 0);
  }
  if (previous.view === 'conversation' && route.view !== 'conversation') closeConversation();
  for (const view of VIEWS) byId(`view-${view}`).hidden = view !== route.view;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-nav]')) {
    if (link.dataset.nav === navOf(route)) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  let title = TITLES[route.view];
  try {
    switch (route.view) {
      case 'overview':
        await renderOverview(app);
        break;
      case 'conversations':
        await renderConversations(app);
        break;
      case 'conversation':
        title = (await showConversation(app, route.key)) || title;
        break;
      case 'export': {
        const wanted = pendingExport;
        pendingExport = null;
        exportPanel ??= new ExportPanel({ repository });
        await exportPanel.show(await (await repository()).listConversations(), wanted?.keys);
        if (wanted?.preset) exportPanel.usePreset(wanted.preset);
        break;
      }
      case 'settings':
        await showSettings(app, route.section, route.tabId);
        break;
    }
  } catch (error) {
    notify(errorText(error), 'error');
  }
  if (mine !== shownCount) return;
  document.title = `${title} · ${APP_NAME}`;
  // Move the focus to the section's heading, so keyboard and screen reader users start there.
  if (navigated) {
    const heading = (route.view === 'settings' ? settingsHeading(route.section) : null) ?? byId(`view-${route.view}`).querySelector<HTMLElement>('.view-title');
    heading?.focus({ preventScroll: true });
  }
  void renderStorageInfo();
}

async function renderStorageInfo(): Promise<void> {
  const storage = await storageUsed();
  byId('storage-info').textContent = storage ? `${storage.used} used in this browser profile` : '';
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
      `Imported ${summary.conversations} conversation(s)${placed.length > 0 ? ` (${placed.join('; ')})` : ''}: ` +
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
  byId('btn-backup-now').addEventListener('click', () => app.exportConversations(undefined, 'backup'));
  window.addEventListener('hashchange', () => void show(parseRoute(location.hash), { navigated: true }));
}

async function main(): Promise<void> {
  buildConversationList(app);
  wireConversationDialogs(app);
  wireConversationView(app);
  buildSettings(app);
  wire();
  await resumeMerges(app);
  await show(parseRoute(location.hash), { navigated: true });
  // Keep the run log fresh while a run is in progress; draw the section again when the tab is shown.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (current.view === 'overview') void renderSessions(app).catch(() => undefined);
    void renderStorageInfo();
  }, 10_000);
  document.addEventListener('visibilitychange', () => {
    // The message view keeps its place: it is drawn again only when opened again.
    if (document.visibilityState === 'visible' && current.view !== 'conversation') void app.refresh();
  });
}

void main();
