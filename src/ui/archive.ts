/** Archive page: browse archived conversations, export / import, session log and settings. */
import { exportFileName, toJson } from '../export/exporters';
import { buildArchiveExport, type ArchiveExportV1 } from '../export/format';
import { buildTranscriptZip, transcriptHtml, type TranscriptImage } from '../export/transcript';
import { importArchive } from '../export/import';
import { buildSelectorProfile, DEFAULT_SELECTOR_PROFILE, findInvalidSelectors } from '../extractor/selectors';
import { imageFileName } from '../shared/images';
import { STALE_SESSION_MS } from '../shared/protocol';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  SETTING_LIMITS,
  SETTINGS_REVISION,
  SETTINGS_STORAGE_KEY,
  settingsForStorage,
  type ScrapeSettings,
} from '../shared/settings';
import type { ConversationRecord, SessionCounters, StoredImage } from '../shared/types';
import { coverageStatus } from '../storage/coverage';
import { ArchiveRepository } from '../storage/repository';
import {
  byId,
  downloadBlob,
  downloadText,
  el,
  errorText,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  MODE_LABELS,
  STATUS_LABELS,
  STOP_REASON_LABELS,
  TYPE_LABELS,
} from './common';

/** The export choices: the full archive as JSON, the ZIP with pictures, and the printable page. */
type DownloadFormat = 'json' | 'zip' | 'pdf';

type NumericSetting = keyof typeof SETTING_LIMITS;

const NUMBER_FIELDS: Array<{ key: NumericSetting; label: string; step?: number }> = [
  { key: 'scrollIntervalMs', label: 'Scroll interval while capturing (ms)' },
  { key: 'seekIntervalMs', label: 'Scroll interval through archived parts (ms)' },
  { key: 'scrollStepRatio', label: 'Scroll step (fraction of the visible height)', step: 0.05 },
  { key: 'scrollAnimationMs', label: 'Smooth scrolling: animation per step (ms, 0 = off)' },
  { key: 'settleQuietMs', label: 'Render quiet period (ms)' },
  { key: 'settleTimeoutMs', label: 'Maximum render wait per step (ms)' },
  { key: 'topLoadTimeoutMs', label: 'Wait for older history at the top (ms)' },
  { key: 'maxNoProgressPasses', label: 'Attempts at the top before finishing' },
  { key: 'maxStallPasses', label: 'Steps without new messages before stopping' },
  { key: 'maxSteps', label: 'Maximum scroll steps per run' },
  { key: 'maxDurationMinutes', label: 'Maximum run duration (minutes)' },
  { key: 'incrementalOverlap', label: 'Archived messages to re-see before an update stops' },
  { key: 'maxImageMB', label: 'Largest image to save (MB)' },
];

let repositoryPromise: Promise<ArchiveRepository> | null = null;
function repository(): Promise<ArchiveRepository> {
  repositoryPromise ??= ArchiveRepository.open();
  return repositoryPromise;
}

function message(id: string, text: string, kind: 'notice' | 'error' | 'success' = 'notice'): void {
  const element = byId(id);
  element.textContent = text;
  element.className = `${kind} small`;
  element.hidden = text === '';
}

function buildExport(repo: ArchiveRepository, keys: string[] | 'all', includeImages: boolean): Promise<ArchiveExportV1> {
  return buildArchiveExport(
    {
      getConversation: (key) => repo.getConversation(key),
      listConversations: () => repo.listConversations(),
      getMessages: (key) => repo.getMessages(key),
      getImages: (key) => repo.getImages(key),
    },
    keys,
    { generatorVersion: chrome.runtime.getManifest().version, includeImages },
  );
}

function exportSummary(archive: ArchiveExportV1, images: number): string {
  const count = archive.conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0);
  return `${formatNumber(count)} messages${images > 0 ? ` and ${formatNumber(images)} images` : ''} from ${archive.conversations.length} conversation(s)`;
}

async function exportConversations(keys: string[] | 'all', format: DownloadFormat): Promise<void> {
  // The print tab must be opened straight from the click, before anything is awaited.
  if (format === 'pdf') return printConversations(keys, window.open('', '_blank'));
  const repo = await repository();
  message('archive-message', 'Preparing the export…');
  if (format === 'zip') {
    const archive = await buildExport(repo, keys, false);
    const images = new Map(await Promise.all(archive.conversations.map(async (c) => [c.conversationKey, await repo.getImages(c.conversationKey)] as const)));
    const parts = buildTranscriptZip(archive, images);
    downloadBlob(exportFileName(archive, 'zip'), new Blob(parts as BlobPart[], { type: 'application/zip' }));
    const pictures = [...images.values()].reduce((sum, list) => sum + list.length, 0);
    message('archive-message', `Exported ${exportSummary(archive, pictures)} as a ZIP. Open chat.html in it to read the chat with its pictures.`, 'success');
    return;
  }
  const archive = await buildExport(repo, keys, byId<HTMLInputElement>('export-images').checked);
  let text: string;
  try {
    text = toJson(archive);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error('The export is too large for one file. Export conversations one at a time, or without images.');
    }
    throw error;
  }
  downloadText(exportFileName(archive, 'json'), text, 'application/json');
  const images = archive.conversations.reduce((sum, conversation) => sum + (conversation.images?.length ?? 0), 0);
  message('archive-message', `Exported ${exportSummary(archive, images)}.`, 'success');
}

/** Waits until the pictures of a page have loaded (or failed), at most `timeoutMs`. */
function picturesLoaded(doc: Document, timeoutMs = 15_000): Promise<void> {
  const pending = Array.from(doc.images).filter((img) => !img.complete);
  const loaded = Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    ),
  );
  return Promise.race([loaded.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

/**
 * Shows the conversations message by message, pictures in place, in a new tab and opens the
 * print dialog there (choose "Save as PDF" as the printer).
 */
async function printConversations(keys: string[] | 'all', win: Window | null): Promise<void> {
  if (!win) throw new Error('The browser blocked the new tab for printing. Allow pop-ups for this page, then try again.');
  const urls: string[] = [];
  try {
    message('archive-message', 'Preparing the printable page…');
    const repo = await repository();
    const archive = await buildExport(repo, keys, false);
    const entries = [];
    for (const conversation of archive.conversations) {
      const images = new Map<string, TranscriptImage>();
      for (const image of await repo.getImages(conversation.conversationKey)) {
        const src = URL.createObjectURL(new Blob([image.data], { type: image.mimeType }));
        urls.push(src);
        images.set(image.imageId, { src, width: image.width, height: image.height });
      }
      entries.push({ conversation, images });
    }
    win.document.open();
    win.document.write(transcriptHtml(entries, { title: archive.conversations.length === 1 ? undefined : 'Teams chats' }));
    win.document.close();
    win.addEventListener('pagehide', () => urls.forEach((url) => URL.revokeObjectURL(url)), { once: true });
    await picturesLoaded(win.document);
    message('archive-message', `Opened ${exportSummary(archive, urls.length)} for printing. Choose "Save as PDF" as the printer.`, 'success');
    win.focus();
    win.print();
  } catch (error) {
    urls.forEach((url) => URL.revokeObjectURL(url));
    win.close();
    throw error;
  }
}

// ------------------------------------------------------------------ images

let imageUrls: string[] = [];

function closeImages(): void {
  const dialog = byId<HTMLDialogElement>('image-dialog');
  if (dialog.open) dialog.close();
  for (const url of imageUrls) URL.revokeObjectURL(url);
  imageUrls = [];
  byId('image-grid').replaceChildren();
}

/** Shows the saved images of a conversation, with who sent each and when. */
async function showImages(record: ConversationRecord): Promise<void> {
  closeImages();
  const repo = await repository();
  const images = await repo.getImages(record.conversationKey);
  const context = new Map<string, { sortKey: number; caption: string }>();
  await repo.forEachMessage(record.conversationKey, (stored) => {
    for (const attachment of stored.attachments) {
      if (!attachment.imageId || context.has(attachment.imageId)) continue;
      const sender = stored.sender.name ?? (stored.sender.isSelf ? 'Me' : 'Unknown sender');
      context.set(attachment.imageId, { sortKey: stored.sortKey, caption: `${sender} · ${formatDateTime(stored.timestamp ?? stored.sortKey)}` });
    }
  });
  const position = (image: StoredImage) => context.get(image.imageId)?.sortKey ?? Number.MAX_VALUE;
  const ordered = [...images].sort((a, b) => position(a) - position(b) || a.firstSavedAt.localeCompare(b.firstSavedAt));
  byId('image-dialog-title').textContent = `${record.title ?? record.conversationKey}: ${formatNumber(images.length)} saved images`;
  byId('image-grid').replaceChildren(...ordered.map((image) => imageTile(image, context.get(image.imageId)?.caption ?? 'No longer referenced by a message')));
  byId<HTMLDialogElement>('image-dialog').showModal();
}

function imageTile(image: StoredImage, caption: string): HTMLElement {
  const url = URL.createObjectURL(new Blob([image.data], { type: image.mimeType }));
  imageUrls.push(url);
  const size = image.width && image.height ? `${image.width}×${image.height} · ` : '';
  return el(
    'figure',
    { className: 'image-tile' },
    el('a', { href: url, target: '_blank', rel: 'noopener', title: 'Open full size' }, el('img', { src: url, alt: '', loading: 'lazy' })),
    el(
      'figcaption',
      { className: 'small' },
      el('div', {}, caption),
      el('div', { className: 'muted' }, `${size}${Math.max(1, Math.round(image.byteLength / 1024))} KB · `, el('a', { href: url, download: imageFileName(image) }, 'Download')),
    ),
  );
}

function conversationRow(record: ConversationRecord, imageCount: number): HTMLTableRowElement {
  const status = coverageStatus(record.coverage, record.newestSortKey);
  const format = el(
    'select',
    { 'aria-label': 'Export format' },
    el('option', { value: 'json' }, 'JSON'),
    el('option', { value: 'zip' }, 'ZIP: chat + pictures'),
    el('option', { value: 'pdf' }, 'PDF (print)'),
  );
  const exportButton = el('button', {
    onclick: () => void exportConversations([record.conversationKey], format.value as DownloadFormat).catch((e) => message('archive-message', errorText(e), 'error')),
  }, 'Export');
  const deleteButton = el('button', {
    className: 'danger',
    onclick: async () => {
      const ok = confirm(
        `Delete "${record.title ?? record.conversationKey}" with ${record.messageCount} archived messages${imageCount > 0 ? ` and ${imageCount} images` : ''} from this browser?\n\nThis cannot be undone. Export a backup first if you may need it.`,
      );
      if (!ok) return;
      const repo = await repository();
      const removed = await repo.deleteConversation(record.conversationKey);
      message('archive-message', `Deleted ${formatNumber(removed.messages)} messages, ${formatNumber(removed.images)} images and ${removed.sessions} sessions.`, 'success');
      await render();
    },
  }, 'Delete');
  return el(
    'tr',
    {},
    el('td', {}, el('div', { className: 'conv-title' }, record.title ?? '(untitled)'), el('div', { className: 'muted small mono' }, record.conversationKey)),
    el('td', {}, TYPE_LABELS[record.type]),
    el('td', { className: 'num' }, formatNumber(record.messageCount)),
    el(
      'td',
      { className: 'num' },
      imageCount > 0
        ? el(
            'button',
            { className: 'link', title: 'View the saved images', onclick: () => void showImages(record).catch((e) => message('archive-message', errorText(e), 'error')) },
            formatNumber(imageCount),
          )
        : '0',
    ),
    el('td', {}, status === 'complete' ? 'Complete' : status === 'partial' ? 'Partial' : '–'),
    el('td', {}, record.oldestSortKey !== null ? `${formatDate(record.oldestSortKey)} – ${formatDate(record.newestSortKey)}` : '–'),
    el('td', {}, formatDateTime(record.lastExtractedAt)),
    el('td', { className: 'actions' }, format, exportButton, deleteButton),
  );
}

async function renderConversations(): Promise<void> {
  const repo = await repository();
  const conversations = await repo.listConversations();
  const imageCounts = await Promise.all(conversations.map((record) => repo.countImages(record.conversationKey)));
  byId('conversations').querySelector('tbody')!.replaceChildren(...conversations.map((record, i) => conversationRow(record, imageCounts[i] ?? 0)));
  byId('conversations').hidden = conversations.length === 0;
  byId('no-conversations').hidden = conversations.length > 0;
  byId<HTMLButtonElement>('btn-export-all').disabled = conversations.length === 0;
}

async function renderSessions(): Promise<void> {
  const repo = await repository();
  await repo.markStaleSessions(Date.now(), STALE_SESSION_MS);
  const sessions = await repo.listSessions({ limit: 50 });
  byId('sessions').querySelector('tbody')!.replaceChildren(
    ...sessions.map((session) => {
      const end = session.endedAt ?? session.updatedAt;
      return el(
        'tr',
        {},
        el('td', {}, formatDateTime(session.startedAt)),
        el('td', {}, session.conversationTitle ?? session.conversationKey),
        el('td', {}, `${MODE_LABELS[session.mode]}${session.rescan ? ' (re-read)' : ''}${session.resumeOf ? ' (resumed)' : ''}`),
        el('td', {}, STATUS_LABELS[session.status]),
        el('td', { className: 'small' }, session.stopReason ? STOP_REASON_LABELS[session.stopReason] : '', session.error ? el('div', { className: 'error-text' }, session.error) : null),
        el('td', { className: 'num' }, formatNumber(session.counters.inserted)),
        el('td', { className: 'num' }, formatNumber(session.counters.updated)),
        el('td', { className: 'num' }, formatNumber(session.counters.unchanged)),
        el('td', { className: 'num' }, imagesCell(session.counters)),
        el('td', {}, formatDuration(Date.parse(end) - Date.parse(session.startedAt))),
      );
    }),
  );
  byId('sessions').hidden = sessions.length === 0;
  byId('no-sessions').hidden = sessions.length > 0;
}

/** Saved images, plus failures; sessions recorded before version 1.1 have no image counters. */
function imagesCell(counters: Partial<SessionCounters>): string {
  if (counters.imagesSaved === undefined) return '–';
  const failed = counters.imagesFailed ?? 0;
  return failed > 0 ? `${formatNumber(counters.imagesSaved)} (${formatNumber(failed)} not saved)` : formatNumber(counters.imagesSaved);
}

async function renderStorage(): Promise<void> {
  try {
    const estimate = await navigator.storage.estimate();
    const usedMb = ((estimate.usage ?? 0) / 1024 / 1024).toFixed(1);
    byId('storage-info').textContent = `${usedMb} MB used in this browser profile`;
  } catch {
    byId('storage-info').textContent = '';
  }
}

async function render(): Promise<void> {
  await Promise.all([renderConversations(), renderSessions(), renderStorage()]);
}

// ---------------------------------------------------------------- settings

function buildSettingsFields(): void {
  const container = byId('settings-fields');
  const fields: HTMLElement[] = NUMBER_FIELDS.map(({ key, label, step }) => {
    const [min, max] = SETTING_LIMITS[key];
    return el(
      'label',
      { className: 'field', for: key },
      el('span', {}, label),
      el('input', { type: 'number', id: key, name: key, min: String(min), max: String(max), step: String(step ?? 1), required: true }),
    );
  });
  fields.push(
    el('label', { className: 'field', for: 'selfDisplayName' }, el('span', {}, 'Your display name (sender of your own messages)'), el('input', { type: 'text', id: 'selfDisplayName', maxlength: '200' })),
    el(
      'label',
      { className: 'field', for: 'dateOrder' },
      el('span', {}, 'Date order used by Teams (fallback only)'),
      el(
        'select',
        { id: 'dateOrder' },
        el('option', { value: 'auto' }, 'Automatic (browser language)'),
        el('option', { value: 'MDY' }, 'Month/Day/Year'),
        el('option', { value: 'DMY' }, 'Day/Month/Year'),
        el('option', { value: 'YMD' }, 'Year/Month/Day'),
      ),
    ),
    el('label', { className: 'check field', for: 'pauseWhenHidden' }, el('input', { type: 'checkbox', id: 'pauseWhenHidden' }), el('span', {}, 'Pause while the Teams tab is hidden (recommended: background tabs are throttled)')),
    el('label', { className: 'check field', for: 'saveImages' }, el('input', { type: 'checkbox', id: 'saveImages' }), el('span', {}, 'Save the images shown in messages (the copy Teams already displays)')),
  );
  container.replaceChildren(...fields);
}

function fillSettings(settings: ScrapeSettings): void {
  for (const { key } of NUMBER_FIELDS) byId<HTMLInputElement>(key).value = String(settings[key]);
  byId<HTMLInputElement>('selfDisplayName').value = settings.selfDisplayName;
  byId<HTMLSelectElement>('dateOrder').value = settings.dateOrder;
  byId<HTMLInputElement>('pauseWhenHidden').checked = settings.pauseWhenHidden;
  byId<HTMLInputElement>('saveImages').checked = settings.saveImages;
  byId<HTMLTextAreaElement>('selectorOverrides').value = settings.selectorOverrides;
}

function readSettings(): ScrapeSettings {
  const raw: Record<string, unknown> = {};
  for (const { key } of NUMBER_FIELDS) raw[key] = byId<HTMLInputElement>(key).value;
  raw.selfDisplayName = byId<HTMLInputElement>('selfDisplayName').value;
  raw.dateOrder = byId<HTMLSelectElement>('dateOrder').value;
  raw.pauseWhenHidden = byId<HTMLInputElement>('pauseWhenHidden').checked;
  raw.saveImages = byId<HTMLInputElement>('saveImages').checked;
  raw.selectorOverrides = byId<HTMLTextAreaElement>('selectorOverrides').value;
  raw.revision = SETTINGS_REVISION;
  return normalizeSettings(raw);
}

async function loadSettings(): Promise<ScrapeSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
}

async function saveSettings(event: Event): Promise<void> {
  event.preventDefault();
  const settings = readSettings();
  try {
    const profile = buildSelectorProfile(settings.selectorOverrides);
    const invalid = findInvalidSelectors(profile, document);
    if (invalid.length > 0) throw new Error(`Invalid selectors: ${invalid.join(', ')}`);
  } catch (error) {
    message('settings-message', errorText(error), 'error');
    return;
  }
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settingsForStorage(settings) });
  fillSettings(settings);
  message('settings-message', 'Saved. New settings apply to the next extraction run.', 'success');
}

function wire(): void {
  byId('settings-form').addEventListener('submit', (event) => void saveSettings(event));
  byId('btn-image-close').addEventListener('click', closeImages);
  byId<HTMLDialogElement>('image-dialog').addEventListener('close', closeImages);
  byId('btn-defaults').addEventListener('click', () => {
    fillSettings({ ...DEFAULT_SETTINGS });
    message('settings-message', 'Defaults restored in the form. Click "Save settings" to apply.');
  });
  byId('btn-insert-selectors').addEventListener('click', () => {
    const { version: _version, ...profile } = DEFAULT_SELECTOR_PROFILE;
    byId<HTMLTextAreaElement>('selectorOverrides').value = JSON.stringify(profile, null, 2);
    message('settings-message', 'Default selectors inserted. Edit only the entries you need, remove the rest, then save.');
  });
  byId('btn-export-all').addEventListener('click', () => {
    const format = byId<HTMLSelectElement>('export-all-format').value as DownloadFormat;
    exportConversations('all', format).catch((error) => message('archive-message', errorText(error), 'error'));
  });
  byId<HTMLInputElement>('import-file').addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const summary = await importArchive(await repository(), await file.text());
      const images = summary.imagesInserted + summary.imagesUnchanged;
      message(
        'archive-message',
        `Imported ${summary.conversations} conversation(s): ${formatNumber(summary.inserted)} new, ${formatNumber(summary.updated)} merged, ${formatNumber(summary.unchanged)} already present.` +
          (images > 0 ? ` Images: ${formatNumber(summary.imagesInserted)} new, ${formatNumber(summary.imagesUnchanged)} already present.` : ''),
        'success',
      );
      await render();
    } catch (error) {
      message('archive-message', `Import failed: ${errorText(error)}`, 'error');
    }
  });
}

async function main(): Promise<void> {
  buildSettingsFields();
  wire();
  fillSettings(await loadSettings());
  await render();
  // Keep the session log fresh while a run is in progress; re-render everything when the tab regains focus.
  setInterval(() => void Promise.all([renderSessions(), renderStorage()]), 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void render();
  });
}

void main();
