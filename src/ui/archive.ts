/** Archive page: browse archived conversations, export / import, session log and settings. */
import { importArchiveFile } from '../export/import';
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
import { conversationLabel, type ConversationRecord, type SessionCounters, type StoredImage } from '../shared/types';
import { titleHistoryOf } from '../storage/conversation-identity';
import { coverageStatus } from '../storage/coverage';
import { ArchiveRepository } from '../storage/repository';
import {
  byId,
  captureLabel,
  el,
  errorText,
  formatAgo,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  STATUS_LABELS,
  STOP_REASON_LABELS,
  TYPE_LABELS,
} from './common';
import { ExportDialog } from './export-dialog';

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
  { key: 'updateOverlapDays', label: 'Update: days before the last update to check again for edits and late replies' },
  { key: 'incrementalOverlap', label: 'Update: archived messages to see again before stopping (at least)' },
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

/** The export dialog, made on first use. */
let exportDialog: ExportDialog | null = null;

async function openExport(selected?: string[]): Promise<void> {
  exportDialog ??= new ExportDialog({ repository, notify: (text, kind) => message('archive-message', text, kind) });
  await exportDialog.open(await (await repository()).listConversations(), selected);
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
  byId('image-dialog-title').textContent = `${conversationLabel(record)}: ${formatNumber(images.length)} saved images`;
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

/** The name shown, then what else the chat was called and its key. */
function conversationCell(record: ConversationRecord): HTMLTableCellElement {
  const label = conversationLabel(record);
  const details: string[] = [];
  if (record.displayName && record.title) details.push(`In Teams: ${record.title}`);
  const earlier = titleHistoryOf(record)
    .map((seen) => seen.title)
    .filter((title) => title !== label && title !== record.title)
    .reverse();
  if (earlier.length > 0) details.push(`Earlier: ${earlier.slice(0, 3).join(', ')}${earlier.length > 3 ? ', …' : ''}`);
  if (record.mergedInto) details.push('Being merged into another conversation');
  return el(
    'td',
    {},
    el('div', { className: 'conv-title' }, label),
    details.length > 0 ? el('div', { className: 'muted small' }, details.join(' · ')) : null,
    el('div', { className: 'muted small mono' }, record.conversationKey),
  );
}

async function renameRecord(record: ConversationRecord): Promise<void> {
  const name = prompt('Name for this chat in the archive and in exports. Leave empty to show the Teams title.', record.displayName ?? record.title ?? '');
  if (name === null) return;
  const renamed = await (await repository()).renameConversation(record.conversationKey, name);
  message('archive-message', renamed.displayName ? `Renamed to “${renamed.displayName}”.` : 'The Teams title is shown again.', 'success');
  await render();
}

function conversationRow(record: ConversationRecord, imageCount: number): HTMLTableRowElement {
  const status = coverageStatus(record.coverage, record.newestSortKey);
  const merging = Boolean(record.mergedInto);
  const exportButton = el('button', {
    title: 'Export this chat: HTML, PDF, Markdown, text, CSV, JSON or a knowledge package',
    onclick: () => void openExport([record.conversationKey]).catch((e) => message('archive-message', errorText(e), 'error')),
  }, 'Export…');
  const renameButton = el('button', {
    disabled: merging,
    title: 'Give this chat a name in the archive',
    onclick: () => void renameRecord(record).catch((e) => message('archive-message', errorText(e), 'error')),
  }, 'Rename');
  const mergeButton = el('button', {
    disabled: merging,
    title: 'Merge with another entry of the same chat',
    onclick: () => void openMerge(record).catch((e) => message('archive-message', errorText(e), 'error')),
  }, 'Merge…');
  const deleteButton = el('button', {
    className: 'danger',
    disabled: merging,
    onclick: async () => {
      const ok = confirm(
        `Delete "${conversationLabel(record)}" with ${record.messageCount} archived messages${imageCount > 0 ? ` and ${imageCount} images` : ''} from this browser?\n\nThis cannot be undone. Export a backup first if you may need it.`,
      );
      if (!ok) return;
      try {
        const repo = await repository();
        const removed = await repo.deleteConversation(record.conversationKey);
        message('archive-message', `Deleted ${formatNumber(removed.messages)} messages, ${formatNumber(removed.images)} images and ${removed.sessions} sessions.`, 'success');
      } catch (error) {
        message('archive-message', errorText(error), 'error');
      }
      await render();
    },
  }, 'Delete');
  return el(
    'tr',
    {},
    conversationCell(record),
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
    el(
      'td',
      { title: record.lastUpdate ? `Brought up to date on ${formatDateTime(record.lastUpdate.at)}` : 'No run has brought this chat up to date yet' },
      record.lastUpdate ? formatAgo(record.lastUpdate.at) : '–',
      el('div', { className: 'muted small' }, `last run ${formatDateTime(record.lastExtractedAt)}`),
    ),
    el('td', { className: 'actions' }, exportButton, renameButton, mergeButton, deleteButton),
  );
}

// ----------------------------------------------------------------- merging

let mergeSource: ConversationRecord | null = null;
let mergeTargets: ConversationRecord[] = [];
/** For each other entry, how many messages it shares with the entry being merged. */
let mergeShared = new Map<string, number>();

/** Every name an entry was shown under, for suggesting entries of the same chat first. */
function namesOf(record: ConversationRecord): string[] {
  const names = [record.displayName, record.title, ...titleHistoryOf(record).map((seen) => seen.title)];
  return names.filter((name): name is string => Boolean(name)).map((name) => name.toLocaleLowerCase().replace(/\s+/g, ' ').trim());
}

/** 2 when two entries were shown under the same name, 1 when a name of one contains a name of the other. */
function nameLikeness(names: string[], others: string[]): number {
  let likeness = 0;
  for (const name of names) {
    for (const other of others) {
      if (name === other) return 2;
      const [shorter, longer] = name.length <= other.length ? [name, other] : [other, name];
      if (shorter.length >= 3 && longer.includes(shorter)) likeness = 1;
    }
  }
  return likeness;
}

function mergeTargetLabel(other: ConversationRecord, shared: number): string {
  const parts = [conversationLabel(other), `${formatNumber(other.messageCount)} messages`, `last run ${formatDate(other.lastExtractedAt)}`];
  if (shared > 0) parts.push(`${formatNumber(shared)} in common`);
  return parts.join(' · ');
}

async function openMerge(record: ConversationRecord): Promise<void> {
  const repo = await repository();
  const others = (await repo.listConversations()).filter((other) => other.conversationKey !== record.conversationKey && !other.mergedInto);
  if (others.length === 0) {
    message('archive-message', 'There is no other archived conversation to merge with.');
    return;
  }
  // Suggest the entries most likely to be the same chat first, but let the user choose.
  const shared = new Map((await repo.entriesSharingMessages(record.conversationKey)).map((entry) => [entry.conversationKey, entry.shared] as const));
  const names = namesOf(record);
  const likeness = new Map(others.map((other) => [other.conversationKey, nameLikeness(names, namesOf(other))] as const));
  const sharedWith = (other: ConversationRecord) => shared.get(other.conversationKey) ?? 0;
  const likenessOf = (other: ConversationRecord) => likeness.get(other.conversationKey) ?? 0;
  others.sort((a, b) => sharedWith(b) - sharedWith(a) || likenessOf(b) - likenessOf(a) || b.lastExtractedAt.localeCompare(a.lastExtractedAt));
  mergeSource = record;
  mergeTargets = others;
  mergeShared = shared;
  byId('merge-source').textContent = `Merge “${conversationLabel(record)}” (${formatNumber(record.messageCount)} messages) with another archive entry of the same chat, for example after Teams renamed it.`;
  const select = byId<HTMLSelectElement>('merge-target');
  select.replaceChildren(
    el('option', { value: '' }, 'Choose the entry of the same chat…'),
    ...others.map((other) => el('option', { value: other.conversationKey }, mergeTargetLabel(other, sharedWith(other)))),
  );
  select.value = '';
  explainMerge();
  message('merge-message', '');
  byId<HTMLDialogElement>('merge-dialog').showModal();
}

function explainMerge(): void {
  const target = mergeTargets.find((other) => other.conversationKey === byId<HTMLSelectElement>('merge-target').value);
  byId<HTMLButtonElement>('btn-merge-confirm').disabled = !target;
  if (!mergeSource) return;
  if (!target) {
    byId('merge-explain').textContent = 'Entries that hold some of the same messages, or were shown under a similar name, are listed first.';
    return;
  }
  const source = conversationLabel(mergeSource);
  const shared = mergeShared.get(target.conversationKey) ?? 0;
  const evidence =
    shared === 0
      ? 'No message was found in both entries: make sure they are the same chat. '
      : `${shared === 1 ? 'One message is' : `${formatNumber(shared)} messages are`} in both entries, so they are most likely the same chat. `;
  byId('merge-explain').textContent =
    evidence +
    `The messages, pictures and run history of “${source}” move into “${conversationLabel(target)}”, and “${source}” leaves the list. ` +
    'Messages archived in both are kept once. Its key and titles become other names of that entry, so the chat is found under either. ' +
    'This cannot be undone: export a backup first if you may need it.';
}

async function confirmMerge(): Promise<void> {
  const source = mergeSource;
  const targetKey = byId<HTMLSelectElement>('merge-target').value;
  if (!source || !targetKey) return;
  const buttons = [byId<HTMLButtonElement>('btn-merge-confirm'), byId<HTMLButtonElement>('btn-merge-cancel')];
  for (const button of buttons) button.disabled = true;
  try {
    const outcome = await (await repository()).mergeConversations(source.conversationKey, targetKey, {
      staleSessionMs: STALE_SESSION_MS,
      onProgress: (progress) =>
        message('merge-message', `Moving… ${formatNumber(progress.messagesMoved)} of ${formatNumber(source.messageCount)} messages${progress.imagesMoved > 0 ? `, ${formatNumber(progress.imagesMoved)} images` : ''}`),
    });
    byId<HTMLDialogElement>('merge-dialog').close();
    message('archive-message', `Merged into “${conversationLabel(outcome.target)}”, which now holds ${formatNumber(outcome.target.messageCount)} messages.`, 'success');
  } catch (error) {
    message('merge-message', errorText(error), 'error');
  } finally {
    for (const button of buttons) button.disabled = false;
    await render();
  }
}

/** Finishes merges that were interrupted, for example by closing this page. */
async function resumeMerges(): Promise<void> {
  try {
    const finished = await (await repository()).resumePendingMerges({ staleSessionMs: STALE_SESSION_MS });
    if (finished > 0) message('archive-message', `Finished ${finished === 1 ? 'a merge' : `${finished} merges`} that had been interrupted.`, 'success');
  } catch (error) {
    message('archive-message', `An interrupted merge could not be finished: ${errorText(error)}`, 'error');
  }
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
        el('td', {}, `${captureLabel(session.mode, session.captureFrom)}${session.rescan ? ' (re-read)' : ''}${session.resumeOf ? ' (resumed)' : ''}`),
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
  byId('merge-target').addEventListener('change', explainMerge);
  byId('btn-merge-confirm').addEventListener('click', () => void confirmMerge());
  byId('btn-merge-cancel').addEventListener('click', () => byId<HTMLDialogElement>('merge-dialog').close());
  byId<HTMLDialogElement>('merge-dialog').addEventListener('close', () => {
    mergeSource = null;
    mergeTargets = [];
  });
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
    openExport().catch((error) => message('archive-message', errorText(error), 'error'));
  });
  byId<HTMLInputElement>('import-file').addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      message('archive-message', `Checking ${file.name}…`);
      const summary = await importArchiveFile(await repository(), file, {
        onProgress: (progress) =>
          message(
            'archive-message',
            progress.phase === 'checking'
              ? `Checking ${file.name}: ${formatNumber(progress.messages)} messages so far. Nothing is written until the whole file has been checked.`
              : `Importing: ${formatNumber(progress.messages)} messages written (${progress.conversations} conversations finished)…`,
          ),
      });
      const images = summary.imagesInserted + summary.imagesUnchanged;
      const placed = [
        summary.joinedExisting > 0 ? `${summary.joinedExisting} added to an entry of the same chat under another name` : '',
        summary.keptSeparate > 0 ? `${summary.keptSeparate} kept separate because an archived chat with the same title holds other messages` : '',
      ].filter(Boolean);
      message(
        'archive-message',
        `Imported ${summary.conversations} conversation(s)${placed.length > 0 ? ` (${placed.join('; ')})` : ''}: ` +
          `${formatNumber(summary.inserted)} new, ${formatNumber(summary.updated)} merged, ${formatNumber(summary.unchanged)} already present.` +
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
  await resumeMerges();
  await render();
  // Keep the session log fresh while a run is in progress; re-render everything when the tab regains focus.
  setInterval(() => void Promise.all([renderSessions(), renderStorage()]), 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void render();
  });
}

void main();
