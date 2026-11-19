/** Archive page: browse archived conversations, export / import, session log and settings. */
import { exportFileName, serializeArchive, type ExportFormat } from '../export/exporters';
import { buildArchiveExport } from '../export/format';
import { importArchive } from '../export/import';
import { buildSelectorProfile, DEFAULT_SELECTOR_PROFILE, findInvalidSelectors } from '../extractor/selectors';
import { STALE_SESSION_MS } from '../shared/protocol';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  SETTING_LIMITS,
  SETTINGS_STORAGE_KEY,
  type ScrapeSettings,
} from '../shared/settings';
import type { ConversationRecord } from '../shared/types';
import { coverageStatus } from '../storage/coverage';
import { ArchiveRepository } from '../storage/repository';
import {
  byId,
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

const MIME: Record<ExportFormat, string> = {
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  markdown: 'text/markdown',
};

type NumericSetting = keyof typeof SETTING_LIMITS;

const NUMBER_FIELDS: Array<{ key: NumericSetting; label: string; step?: number }> = [
  { key: 'scrollIntervalMs', label: 'Scroll interval while capturing (ms)' },
  { key: 'seekIntervalMs', label: 'Scroll interval through archived parts (ms)' },
  { key: 'scrollStepRatio', label: 'Scroll step (fraction of the visible height)', step: 0.05 },
  { key: 'settleQuietMs', label: 'Render quiet period (ms)' },
  { key: 'settleTimeoutMs', label: 'Maximum render wait per step (ms)' },
  { key: 'topLoadTimeoutMs', label: 'Wait for older history at the top (ms)' },
  { key: 'maxNoProgressPasses', label: 'Attempts at the top before finishing' },
  { key: 'maxStallPasses', label: 'Steps without new messages before stopping' },
  { key: 'maxSteps', label: 'Maximum scroll steps per run' },
  { key: 'maxDurationMinutes', label: 'Maximum run duration (minutes)' },
  { key: 'incrementalOverlap', label: 'Archived messages to re-see before an update stops' },
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

async function exportConversations(keys: string[] | 'all', format: ExportFormat): Promise<void> {
  const repo = await repository();
  const archive = await buildArchiveExport(
    {
      getConversation: (key) => repo.getConversation(key),
      listConversations: () => repo.listConversations(),
      getMessages: (key) => repo.getMessages(key),
    },
    keys,
    { generatorVersion: chrome.runtime.getManifest().version },
  );
  const text = serializeArchive(archive, format);
  downloadText(exportFileName(archive, format), text, MIME[format]);
  const count = archive.conversations.reduce((sum, conversation) => sum + conversation.messages.length, 0);
  message('archive-message', `Exported ${formatNumber(count)} messages from ${archive.conversations.length} conversation(s).`, 'success');
}

function conversationRow(record: ConversationRecord): HTMLTableRowElement {
  const status = coverageStatus(record.coverage, record.newestSortKey);
  const format = el('select', { 'aria-label': 'Export format' }, el('option', { value: 'json' }, 'JSON'), el('option', { value: 'ndjson' }, 'NDJSON'), el('option', { value: 'markdown' }, 'Markdown'));
  const exportButton = el('button', {
    onclick: () => void exportConversations([record.conversationKey], format.value as ExportFormat).catch((e) => message('archive-message', errorText(e), 'error')),
  }, 'Export');
  const deleteButton = el('button', {
    className: 'danger',
    onclick: async () => {
      const ok = confirm(
        `Delete "${record.title ?? record.conversationKey}" with ${record.messageCount} archived messages from this browser?\n\nThis cannot be undone. Export a backup first if you may need it.`,
      );
      if (!ok) return;
      const repo = await repository();
      const removed = await repo.deleteConversation(record.conversationKey);
      message('archive-message', `Deleted ${formatNumber(removed.messages)} messages and ${removed.sessions} sessions.`, 'success');
      await render();
    },
  }, 'Delete');
  return el(
    'tr',
    {},
    el('td', {}, el('div', { className: 'conv-title' }, record.title ?? '(untitled)'), el('div', { className: 'muted small mono' }, record.conversationKey)),
    el('td', {}, TYPE_LABELS[record.type]),
    el('td', { className: 'num' }, formatNumber(record.messageCount)),
    el('td', {}, status === 'complete' ? 'Complete' : status === 'partial' ? 'Partial' : '–'),
    el('td', {}, record.oldestSortKey !== null ? `${formatDate(record.oldestSortKey)} – ${formatDate(record.newestSortKey)}` : '–'),
    el('td', {}, formatDateTime(record.lastExtractedAt)),
    el('td', { className: 'actions' }, format, exportButton, deleteButton),
  );
}

async function renderConversations(): Promise<void> {
  const repo = await repository();
  const conversations = await repo.listConversations();
  byId('conversations').querySelector('tbody')!.replaceChildren(...conversations.map(conversationRow));
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
        el('td', {}, formatDuration(Date.parse(end) - Date.parse(session.startedAt))),
      );
    }),
  );
  byId('sessions').hidden = sessions.length === 0;
  byId('no-sessions').hidden = sessions.length > 0;
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
  );
  container.replaceChildren(...fields);
}

function fillSettings(settings: ScrapeSettings): void {
  for (const { key } of NUMBER_FIELDS) byId<HTMLInputElement>(key).value = String(settings[key]);
  byId<HTMLInputElement>('selfDisplayName').value = settings.selfDisplayName;
  byId<HTMLSelectElement>('dateOrder').value = settings.dateOrder;
  byId<HTMLInputElement>('pauseWhenHidden').checked = settings.pauseWhenHidden;
  byId<HTMLTextAreaElement>('selectorOverrides').value = settings.selectorOverrides;
}

function readSettings(): ScrapeSettings {
  const raw: Record<string, unknown> = {};
  for (const { key } of NUMBER_FIELDS) raw[key] = byId<HTMLInputElement>(key).value;
  raw.selfDisplayName = byId<HTMLInputElement>('selfDisplayName').value;
  raw.dateOrder = byId<HTMLSelectElement>('dateOrder').value;
  raw.pauseWhenHidden = byId<HTMLInputElement>('pauseWhenHidden').checked;
  raw.selectorOverrides = byId<HTMLTextAreaElement>('selectorOverrides').value;
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
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  fillSettings(settings);
  message('settings-message', 'Saved. New settings apply to the next extraction run.', 'success');
}

function wire(): void {
  byId('settings-form').addEventListener('submit', (event) => void saveSettings(event));
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
    const format = byId<HTMLSelectElement>('export-all-format').value as ExportFormat;
    exportConversations('all', format).catch((error) => message('archive-message', errorText(error), 'error'));
  });
  byId<HTMLInputElement>('import-file').addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const summary = await importArchive(await repository(), await file.text());
      message(
        'archive-message',
        `Imported ${summary.conversations} conversation(s): ${formatNumber(summary.inserted)} new, ${formatNumber(summary.updated)} merged, ${formatNumber(summary.unchanged)} already present.`,
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
