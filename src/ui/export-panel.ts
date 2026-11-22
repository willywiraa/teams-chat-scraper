/**
 * The app page's Export section: conversations × format × period × content × packaging.
 * The last choices are remembered (in chrome.storage.local); on first use it suggests an HTML
 * page with everything.
 */
import {
  DEFAULT_EXPORT_CHOICES,
  EXPORT_FORMATS,
  fixedContent,
  FORMATS,
  isFullBackup,
  normalizeChoices,
  packagingsFor,
  presetChoices,
  rangeFor,
  type ExportChoices,
  type ExportContent,
  type ExportFormat,
  type ExportPreset,
  type Packaging,
  type RangeChoice,
} from '../export/options';
import { runExport, writePrintable, type ExportProgress, type ExportRequest, type ExportTotals } from '../export/pipeline';
import { conversationLabel, type ConversationRecord } from '../shared/types';
import type { ArchiveRepository } from '../storage/repository';
import { byId, countOf, downloadBlob, el, errorText, formatNumber } from './common';
import { recordBackup } from './last-backup';

export const EXPORT_CHOICES_KEY = 'exportChoices.v1';

const CONTENT_FIELDS: Array<{ key: keyof ExportContent; id: string; label: string }> = [
  { key: 'images', id: 'export-images', label: 'Pictures' },
  { key: 'attachments', id: 'export-attachments', label: 'File attachments (names and links)' },
  { key: 'replies', id: 'export-replies', label: 'Reply context (the message a reply quotes)' },
  { key: 'reactions', id: 'export-reactions', label: 'Reactions (emoji and how many chose each)' },
  { key: 'systemMessages', id: 'export-system', label: 'System messages (joined, added, renamed…)' },
  { key: 'editHistory', id: 'export-history', label: 'Edit history (earlier versions of edited messages)' },
];

const RANGE_LABELS: Record<RangeChoice, string> = {
  all: 'All archived messages',
  'last-24h': 'Last 24 hours',
  'last-7d': 'Last 7 days',
  'last-30d': 'Last 30 days',
  custom: 'Custom period…',
};

export interface ExportPanelHost {
  repository(): Promise<ArchiveRepository>;
}

function localInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function packagingLabel(format: ExportFormat, packaging: Packaging): string {
  if (format === 'pdf') return 'Printed page';
  if (packaging === 'zip') return format === 'package' ? 'ZIP' : 'ZIP with the pictures as files';
  return format === 'html' ? 'One file, pictures embedded' : 'One file';
}

/** What the export will produce, in a sentence or two. */
export function explainChoices(choices: ExportChoices, conversations: number): string {
  const several = conversations > 1;
  const folders = several ? ' One folder per conversation.' : '';
  const { content } = choices;
  switch (choices.format) {
    case 'html':
      if (choices.packaging === 'zip') return `A ZIP with chat.html and an images folder, the pictures shown in place.${folders}${several ? ' index.html links the conversations.' : ''}`;
      return `One HTML page${several ? ' with all selected conversations' : ''}.${content.images ? ' The pictures are embedded, so the file can be large.' : ''}`;
    case 'pdf':
      return 'Opens a printable page in a new tab and the print dialog: choose "Save as PDF" as the printer.';
    case 'markdown':
      return choices.packaging === 'zip' ? `A ZIP with chat.md and an images folder, the pictures shown in place.${folders}` : 'One Markdown file. Select Pictures to get a ZIP with them.';
    case 'text':
      return choices.packaging === 'zip' ? `A ZIP with chat.txt and an images folder; the text names each picture's file.${folders}` : 'One plain-text file. Select Pictures to get a ZIP with them.';
    case 'csv':
      return `${choices.packaging === 'zip' ? `A ZIP with messages.csv and an images folder; the pictures column names the files.${folders}` : 'One CSV file.'} One row per message, UTF-8 for Excel; cells that look like formulas are kept as text.`;
    case 'json':
      return `Complete archive records in one file, which Import archive… reads back.${content.images ? ' Pictures are included as base64 data.' : ''} Attachments and reply context are always kept.`;
    case 'package':
      return 'A ZIP with manifest.json and, per conversation, conversation.json, messages.jsonl, a Markdown transcript and the pictures named by their SHA-256. Import archive… reads it back, so it is also the backup format for large archives. Attachments and reply context are always kept.';
  }
}

export class ExportPanel {
  private records: ConversationRecord[] = [];
  private choices: ExportChoices = normalizeChoices(DEFAULT_EXPORT_CHOICES);
  private loaded = false;
  private running = false;
  /** The conversations chosen when the section was last shown, kept when it is shown again. */
  private chosen: Set<string> | null = null;

  constructor(private readonly host: ExportPanelHost) {
    this.build();
  }

  private build(): void {
    byId('export-format').replaceChildren(...EXPORT_FORMATS.map((format) => el('option', { value: format }, FORMATS[format].label)));
    byId('export-range').replaceChildren(...(Object.keys(RANGE_LABELS) as RangeChoice[]).map((range) => el('option', { value: range }, RANGE_LABELS[range])));
    byId('export-content').replaceChildren(
      ...CONTENT_FIELDS.map(({ id, label }) => el('label', { className: 'check field', for: id }, el('input', { type: 'checkbox', id }), el('span', {}, label))),
    );
    for (const id of ['export-format', 'export-packaging', 'export-range', 'export-from', 'export-to', ...CONTENT_FIELDS.map((field) => field.id)]) {
      byId(id).addEventListener('change', () => this.readControls());
    }
    byId('export-conversations').addEventListener('change', () => this.update());
    byId('btn-export-select-all').addEventListener('click', () => this.selectAll(true));
    byId('btn-export-select-none').addEventListener('click', () => this.selectAll(false));
    byId('btn-preset-knowledge').addEventListener('click', () => this.applyPreset('knowledge'));
    byId('btn-preset-backup').addEventListener('click', () => this.applyPreset('backup'));
    // Opened from the click itself: the print tab must be opened before anything is awaited.
    byId('btn-export-run').addEventListener('click', () => this.run());
  }

  /**
   * Shows the section for these conversations: the given ones selected, else those selected
   * before (all the first time).
   */
  async show(records: ConversationRecord[], selected?: readonly string[]): Promise<void> {
    if (!this.loaded) {
      try {
        const stored = await chrome.storage.local.get(EXPORT_CHOICES_KEY);
        this.choices = normalizeChoices(stored[EXPORT_CHOICES_KEY] ?? DEFAULT_EXPORT_CHOICES);
      } catch {
        this.choices = normalizeChoices(DEFAULT_EXPORT_CHOICES);
      }
      this.loaded = true;
    }
    if (this.running) return;
    this.records = records;
    if (this.chosen && !selected) this.chosen = new Set(this.selectedKeys());
    const chosen = new Set(selected ?? (this.chosen && this.chosen.size > 0 ? [...this.chosen] : records.map((record) => record.conversationKey)));
    this.chosen = chosen;
    byId('export-conversations').replaceChildren(
      ...records.map((record, i) =>
        el(
          'label',
          { className: 'check field', for: `export-conv-${i}` },
          el('input', { type: 'checkbox', id: `export-conv-${i}`, value: record.conversationKey, checked: chosen.has(record.conversationKey) }),
          el('span', {}, conversationLabel(record), el('span', { className: 'muted' }, ` · ${countOf(record.messageCount, 'message')}`)),
        ),
      ),
    );
    byId('export-empty').hidden = records.length > 0;
    byId('export-select-row').hidden = records.length === 0;
    this.message('');
    this.writeControls();
  }

  /** Sets a preset's choices (Full backup from the Storage settings, for example). */
  usePreset(preset: ExportPreset): void {
    this.applyPreset(preset);
  }

  private selectedKeys(): string[] {
    return Array.from(byId('export-conversations').querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .filter((input) => input.checked)
      .map((input) => input.value);
  }

  private selectAll(checked: boolean): void {
    for (const input of byId('export-conversations').querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) input.checked = checked;
    this.update();
  }

  private applyPreset(preset: ExportPreset): void {
    this.choices = normalizeChoices(presetChoices(preset));
    this.writeControls();
    this.message(preset === 'knowledge' ? 'Knowledge system: the package with pictures, attachments, replies and edit history, without system messages.' : 'Full backup: the package with everything.');
  }

  /** Reads the choices from the controls, then makes them consistent and shows them again. */
  private readControls(): void {
    const content = { ...this.choices.content };
    for (const { key, id } of CONTENT_FIELDS) {
      const input = byId<HTMLInputElement>(id);
      if (!input.disabled) content[key] = input.checked;
    }
    const range = byId<HTMLSelectElement>('export-range').value as RangeChoice;
    let from = byId<HTMLInputElement>('export-from').value;
    if (range === 'custom' && !from && !byId<HTMLInputElement>('export-to').value) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      from = localInputValue(start.getTime() - 7 * 86_400_000);
    }
    this.choices = normalizeChoices({
      format: byId<HTMLSelectElement>('export-format').value,
      packaging: byId<HTMLSelectElement>('export-packaging').value,
      range,
      from,
      to: byId<HTMLInputElement>('export-to').value,
      content,
    });
    this.writeControls();
  }

  /** Shows the choices in the controls, with what each format allows. */
  private writeControls(): void {
    const { choices } = this;
    byId<HTMLSelectElement>('export-format').value = choices.format;
    const packagings = choices.format === 'pdf' ? (['file'] as Packaging[]) : packagingsFor(choices.format, choices.content);
    const packaging = byId<HTMLSelectElement>('export-packaging');
    packaging.replaceChildren(...packagings.map((value) => el('option', { value }, packagingLabel(choices.format, value))));
    packaging.value = choices.packaging;
    packaging.disabled = packagings.length < 2;
    byId<HTMLSelectElement>('export-range').value = choices.range;
    byId<HTMLInputElement>('export-from').value = choices.from;
    byId<HTMLInputElement>('export-to').value = choices.to;
    byId('export-period').hidden = choices.range !== 'custom';
    const fixed = fixedContent(choices.format);
    for (const { key, id } of CONTENT_FIELDS) {
      const input = byId<HTMLInputElement>(id);
      const forced = fixed[key];
      input.checked = forced ?? choices.content[key];
      input.disabled = forced !== undefined;
      input.parentElement!.title = forced !== undefined ? 'Always kept in archive records: they are part of the message.' : '';
    }
    this.update();
  }

  private update(): void {
    const count = this.selectedKeys().length;
    byId('export-selected-count').textContent = `${count} of ${this.records.length} selected`;
    byId('export-explain').textContent = explainChoices(this.choices, count);
    byId<HTMLButtonElement>('btn-export-run').disabled = this.running || count === 0;
    // A disabled Export says why.
    const hint = byId('export-run-hint');
    hint.textContent = this.running ? '' : this.records.length === 0 ? 'Nothing to export yet.' : count === 0 ? 'Select at least one conversation.' : '';
    hint.hidden = hint.textContent === '';
  }

  private message(text: string, kind: 'notice' | 'error' | 'success' = 'notice'): void {
    const element = byId('export-message');
    element.textContent = text;
    element.className = `${kind} small`;
    element.hidden = text === '';
  }

  private request(keys: string[]): ExportRequest | null {
    const period = rangeFor(this.choices, Date.now());
    if ('error' in period) {
      this.message(period.error, 'error');
      return null;
    }
    return {
      conversations: keys,
      format: this.choices.format,
      packaging: this.choices.packaging,
      range: period.range,
      content: this.choices.content,
      generatorVersion: chrome.runtime.getManifest().version,
    };
  }

  private progress = (progress: ExportProgress): void => {
    this.message(`Writing ${formatNumber(progress.messages)} messages (conversation ${progress.conversation} of ${progress.conversations})…`);
  };

  private run(): void {
    const keys = this.selectedKeys();
    if (this.running || keys.length === 0) return;
    const request = this.request(keys);
    if (!request) return;
    const win = request.format === 'pdf' ? window.open('', '_blank') : null;
    this.running = true;
    this.update();
    this.message('Preparing the export…');
    void chrome.storage.local.set({ [EXPORT_CHOICES_KEY]: this.choices }).catch(() => undefined);
    const work = request.format === 'pdf' ? this.print(request, win) : this.download(request);
    void work
      .then((text) => this.message(text, 'success'))
      .catch((error) => this.message(errorText(error), 'error'))
      .finally(() => {
        this.running = false;
        this.update();
      });
  }

  private async download(request: ExportRequest): Promise<string> {
    const outcome = await runExport(await this.host.repository(), request, this.progress);
    downloadBlob(outcome.fileName, outcome.blob);
    const archived = this.records.map((record) => record.conversationKey);
    if (isFullBackup(request, archived)) {
      await recordBackup({ at: new Date().toISOString(), conversations: outcome.conversations, messages: outcome.messages }).catch(() => undefined);
    }
    return `Exported ${summaryText(outcome)} as ${outcome.fileName}.`;
  }

  /** Writes the printable page into the new tab, pictures as object URLs, and opens the print dialog there. */
  private async print(request: ExportRequest, win: Window | null): Promise<string> {
    if (!win) throw new Error('The browser blocked the new tab for printing. Allow pop-ups for this page, then try again.');
    const urls: string[] = [];
    try {
      const repository = await this.host.repository();
      win.document.open();
      const totals = await writePrintable(
        repository,
        request,
        (text) => win.document.write(text),
        (image) => {
          const url = URL.createObjectURL(new Blob([image.data], { type: image.mimeType }));
          urls.push(url);
          return url;
        },
        this.progress,
      );
      win.document.close();
      win.addEventListener('pagehide', () => urls.forEach((url) => URL.revokeObjectURL(url)), { once: true });
      await picturesLoaded(win.document);
      win.focus();
      win.print();
      return `Opened ${summaryText(totals)} for printing. Choose "Save as PDF" as the printer.`;
    } catch (error) {
      urls.forEach((url) => URL.revokeObjectURL(url));
      win.close();
      throw error;
    }
  }
}

function summaryText(totals: ExportTotals): string {
  return `${countOf(totals.messages, 'message')}${totals.pictures > 0 ? ` and ${countOf(totals.pictures, 'picture')}` : ''} from ${countOf(totals.conversations, 'conversation')}`;
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
