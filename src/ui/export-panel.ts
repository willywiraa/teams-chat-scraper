/**
 * The app page's Export section: conversations × format × period × content × packaging.
 * The last choices are remembered (in chrome.storage.local); on first use it suggests an HTML
 * page with everything.
 */
import {
  DEFAULT_EXPORT_CHOICES,
  effectiveContent,
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
import { exportFileNameFor, runExport, writePrintable, type ExportProgress, type ExportRequest, type ExportTotals } from '../export/pipeline';
import { conversationLabel, type ConversationRecord } from '../shared/types';
import type { ArchiveRepository } from '../storage/repository';
import { byId, countOf, downloadBlob, el, errorText, formatAgo, formatNumber, TYPE_LABELS } from './common';
import { icon } from './icons';
import { recordBackup } from './last-backup';
import { filterConversations, lastActivityOf, TYPE_FILTERS, type TypeFilter } from './view-models';

export const EXPORT_CHOICES_KEY = 'exportChoices.v1';

const CONTENT_FIELDS: Array<{ key: keyof ExportContent; id: string; label: string; note: string }> = [
  { key: 'images', id: 'export-images', label: 'Pictures', note: '' },
  { key: 'attachments', id: 'export-attachments', label: 'File attachments', note: 'names and links' },
  { key: 'replies', id: 'export-replies', label: 'Reply context', note: 'the message a reply quotes' },
  { key: 'reactions', id: 'export-reactions', label: 'Reactions', note: 'emoji and how many chose each' },
  { key: 'systemMessages', id: 'export-system', label: 'System messages', note: 'joined, added, renamed…' },
  { key: 'editHistory', id: 'export-history', label: 'Edit history', note: 'earlier versions of edited messages' },
];

const RANGE_LABELS: Record<RangeChoice, string> = {
  all: 'All archived',
  'last-24h': '24 hours',
  'last-7d': '7 days',
  'last-30d': '30 days',
  custom: 'A period…',
};

/** The format tiles: a short name, and what the format is for. */
export const FORMAT_TILES: Record<ExportFormat, { name: string; line: string }> = {
  html: { name: 'HTML page', line: 'To read in a browser' },
  pdf: { name: 'PDF', line: 'Opens the print dialog to save a PDF' },
  markdown: { name: 'Markdown', line: 'For notes apps and wikis' },
  text: { name: 'Plain text', line: 'Text without formatting' },
  csv: { name: 'CSV', line: 'One row per message, opens in Excel' },
  json: { name: 'JSON', line: 'Complete records, Import archive… reads it' },
  package: { name: 'Knowledge package', line: 'A ZIP for knowledge tools and backups' },
};

const PRESETS: readonly ExportPreset[] = ['knowledge', 'backup'];

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

/** A radio drawn as a tile: a name and a line under it. */
function tile(name: string, value: string, title: string, line: string): HTMLLabelElement {
  const id = `${name}-${value}`;
  return el(
    'label',
    { className: 'tile', for: id },
    el('input', { type: 'radio', name, id, value }),
    el('span', { className: 'tile-text' }, el('span', { className: 'tile-name' }, title), el('span', { className: 'tile-line' }, line)),
  );
}

/** A radio drawn as one of a row of buttons, with an optional count after its label. */
function segment(name: string, value: string, text: string, count?: number): HTMLLabelElement {
  const id = `${name}-${value}`;
  return el(
    'label',
    { className: 'segment', for: id },
    el('input', { type: 'radio', name, id, value }),
    el('span', {}, text, count === undefined ? null : el('span', { className: 'segment-count' }, ` ${formatNumber(count)}`)),
  );
}

function checkedValue(name: string): string | null {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;
}

function check(name: string, value: string): void {
  for (const input of document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) input.checked = input.value === value;
}

/** The preset whose choices the form holds, or null when it holds neither. */
export function presetInUse(choices: ExportChoices): ExportPreset | null {
  const content = effectiveContent(choices.format, choices.content);
  for (const preset of PRESETS) {
    const wanted = presetChoices(preset);
    const same =
      choices.format === wanted.format &&
      choices.packaging === wanted.packaging &&
      choices.range === wanted.range &&
      (Object.keys(wanted.content) as Array<keyof ExportContent>).every((key) => content[key] === wanted.content[key]);
    if (same) return preset;
  }
  return null;
}

/** The name the export will be saved under, named as the export pipeline names it; null for PDF, which is printed. */
export function plannedFileName(choices: Pick<ExportChoices, 'format' | 'packaging'>, records: readonly ConversationRecord[], now: Date): string | null {
  switch (choices.format) {
    case 'pdf':
      return null;
    case 'package':
      return exportFileNameFor(records, now, 'zip', 'package');
    case 'json':
      return exportFileNameFor(records, now, 'json');
    default:
      return exportFileNameFor(records, now, choices.packaging === 'zip' ? 'zip' : FORMATS[choices.format].extension);
  }
}

/** A conversation's line in the picker, after its name: "Group chat · 451 messages · updated 3 days ago". */
export function conversationFacts(record: ConversationRecord, nowMs: number = Date.now()): string {
  return `${TYPE_LABELS[record.type]} · ${countOf(record.messageCount, 'message')} · updated ${formatAgo(lastActivityOf(record), nowMs)}`;
}

/** The archive keys among `records` that `keys` name, by key or by an alias. */
function keysIn(records: readonly ConversationRecord[], keys: readonly string[]): string[] {
  const wanted = new Set(keys);
  return records.filter((record) => wanted.has(record.conversationKey) || (record.aliases ?? []).some((alias) => wanted.has(alias))).map((record) => record.conversationKey);
}

/**
 * What the export will produce: a sentence or two for everyone, and for JSON and the package, the
 * files inside for those who need them ('' for the other formats).
 */
export function explainChoices(choices: ExportChoices, conversations: number): { text: string; inside: string } {
  const several = conversations > 1;
  const folders = several ? ' One folder per conversation.' : '';
  const { content } = choices;
  const plain = (text: string) => ({ text, inside: '' });
  switch (choices.format) {
    case 'html':
      if (choices.packaging === 'zip') return plain(`A ZIP with chat.html and an images folder, the pictures shown in place.${folders}${several ? ' index.html links the conversations.' : ''}`);
      return plain(`One HTML page${several ? ' with all selected conversations' : ''}.${content.images ? ' The pictures are embedded, so the file can be large.' : ''}`);
    case 'pdf':
      return plain('Opens a printable page in a new tab and the print dialog: choose "Save as PDF" as the printer.');
    case 'markdown':
      return plain(choices.packaging === 'zip' ? `A ZIP with chat.md and an images folder, the pictures shown in place.${folders}` : 'One Markdown file. Select Pictures to get a ZIP with them.');
    case 'text':
      return plain(choices.packaging === 'zip' ? `A ZIP with chat.txt and an images folder; the text names each picture's file.${folders}` : 'One plain-text file. Select Pictures to get a ZIP with them.');
    case 'csv':
      return plain(
        `${choices.packaging === 'zip' ? `A ZIP with messages.csv and an images folder; the pictures column names the files.${folders}` : 'One CSV file.'} One row per message, and it opens in Excel. Cells that look like formulas are kept as text.`,
      );
    case 'json':
      return {
        text: `One file with the complete archive records, which Import archive… reads back.${content.images ? ' The pictures are included in the file.' : ''}`,
        inside: `JSON: each conversation's record and its messages${content.images ? ', with the pictures as base64 data' : ''}.`,
      };
    case 'package':
      return {
        text: 'A ZIP for knowledge tools and backups, with a Markdown transcript of each conversation and its pictures. Import archive… reads it back, so it is also the backup format for large archives.',
        inside: 'manifest.json and, per conversation, conversation.json, messages.jsonl, a Markdown transcript and the pictures named by their SHA-256.',
      };
  }
}

/** What the Export button writes, in its label. */
const FILE_KINDS: Record<ExportFormat, string> = { html: 'HTML', pdf: 'PDF', markdown: 'Markdown', text: 'text', csv: 'CSV', json: 'JSON', package: 'ZIP' };

/** "Export 2 conversations (ZIP)"; for PDF, what the button opens. */
export function exportButtonLabel(choices: Pick<ExportChoices, 'format' | 'packaging'>, conversations: number): string {
  if (choices.format === 'pdf') return 'Open the print dialog';
  if (conversations === 0) return 'Export';
  return `Export ${countOf(conversations, 'conversation')} (${choices.packaging === 'zip' ? 'ZIP' : FILE_KINDS[choices.format]})`;
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
    byId('export-formats').replaceChildren(...EXPORT_FORMATS.map((format) => tile('export-format', format, FORMAT_TILES[format].name, FORMAT_TILES[format].line)));
    byId('export-range').replaceChildren(...(Object.keys(RANGE_LABELS) as RangeChoice[]).map((range) => segment('export-range', range, RANGE_LABELS[range])));
    byId('export-content').replaceChildren(
      ...CONTENT_FIELDS.map(({ id, label, note }) =>
        el('label', { className: 'check field', for: id }, el('input', { type: 'checkbox', id }), el('span', {}, label, note ? el('span', { className: 'muted' }, ` ${note}`) : null)),
      ),
    );
    byId('export-filter-icon').replaceWith(icon('search'));
    // The controls are radios and checkboxes in these groups; a change anywhere in one is read whole.
    for (const id of ['export-formats', 'export-packaging', 'export-range', 'export-from', 'export-to', 'export-content']) {
      byId(id).addEventListener('change', () => this.readControls());
    }
    byId('export-conversations').addEventListener('change', () => {
      this.message('');
      this.update();
    });
    byId('export-filter').addEventListener('input', () => this.applyFilter());
    byId('export-types').addEventListener('change', () => this.applyFilter());
    byId('btn-export-select-all').addEventListener('click', () => this.select(() => true));
    byId('btn-export-select-none').addEventListener('click', () => this.select(() => false));
    byId('btn-export-select-shown').addEventListener('click', () => this.select((row) => !row.hidden));
    for (const preset of PRESETS) byId(`preset-${preset}`).addEventListener('change', () => this.applyPreset(preset));
    // Opened from the click itself: the print tab must be opened before anything is awaited.
    byId('btn-export-run').addEventListener('click', () => this.run());
  }

  /**
   * Shows the section for these conversations: the given ones selected (by key or alias), else
   * those selected before (all the first time).
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
    const wanted = selected ? keysIn(records, selected) : [];
    const chosen = new Set(wanted.length > 0 ? wanted : this.chosen && this.chosen.size > 0 ? [...this.chosen] : records.map((record) => record.conversationKey));
    this.chosen = chosen;
    const now = Date.now();
    byId('export-conversations').replaceChildren(
      ...records.map((record, i) =>
        el(
          'label',
          { className: 'check field', for: `export-conv-${i}` },
          el('input', { type: 'checkbox', id: `export-conv-${i}`, value: record.conversationKey, checked: chosen.has(record.conversationKey) }),
          el('span', {}, conversationLabel(record), el('span', { className: 'muted' }, ` · ${conversationFacts(record, now)}`)),
        ),
      ),
    );
    this.buildTypes();
    byId('export-empty').hidden = records.length > 0;
    byId('export-select-row').hidden = records.length === 0;
    byId('export-tools').hidden = records.length === 0;
    this.message('');
    this.applyFilter(false);
    this.writeControls();
  }

  /** Sets a preset's choices (Full backup from the Storage settings, for example). */
  usePreset(preset: ExportPreset): void {
    this.applyPreset(preset);
  }

  /** The chips for the chat types the archive holds, each with its count; none when it holds one type. */
  private buildTypes(): void {
    const countOfType = (type: TypeFilter) => (type === 'all' ? this.records.length : this.records.filter((record) => record.type === type).length);
    const present = TYPE_FILTERS.filter(({ value }) => value !== 'all' && countOfType(value) > 0);
    const current = checkedValue('export-type') ?? 'all';
    byId('export-types').replaceChildren(
      ...[{ value: 'all' as TypeFilter, label: 'All' }, ...present].map(({ value, label }) => segment('export-type', value, label, countOfType(value))),
    );
    byId('export-types-field').hidden = present.length < 2;
    check('export-type', present.length >= 2 && present.some(({ value }) => value === current) ? current : 'all');
  }

  /** Shows the conversations the filter and the chosen type let through; the others keep their check. */
  private applyFilter(update = true): void {
    const query = byId<HTMLInputElement>('export-filter').value;
    const type = (checkedValue('export-type') ?? 'all') as TypeFilter;
    const shown = new Set(filterConversations(this.records, { query, type }).map((record) => record.conversationKey));
    for (const input of this.inputs()) {
      const row = input.closest('label');
      if (row) row.hidden = !shown.has(input.value);
    }
    byId('export-no-match').hidden = this.records.length === 0 || shown.size > 0;
    byId('btn-export-select-shown').hidden = shown.size === this.records.length;
    if (update) this.update();
  }

  private inputs(): HTMLInputElement[] {
    return Array.from(byId('export-conversations').querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  }

  private selectedKeys(): string[] {
    return this.inputs()
      .filter((input) => input.checked)
      .map((input) => input.value);
  }

  /** Checks the conversations whose row `wanted` accepts and clears the others. */
  private select(wanted: (row: HTMLElement) => boolean): void {
    this.message('');
    for (const input of this.inputs()) {
      const row = input.closest('label');
      if (row) input.checked = wanted(row);
    }
    this.update();
  }

  /** The preset's tile shows *In use* while the form holds its choices. */
  private applyPreset(preset: ExportPreset): void {
    this.choices = normalizeChoices(presetChoices(preset));
    this.message('');
    this.writeControls();
  }

  /** Reads the choices from the controls, then makes them consistent and shows them again. */
  private readControls(): void {
    this.message('');
    const content = { ...this.choices.content };
    for (const { key, id } of CONTENT_FIELDS) {
      const input = byId<HTMLInputElement>(id);
      if (!input.disabled) content[key] = input.checked;
    }
    const range = (checkedValue('export-range') ?? this.choices.range) as RangeChoice;
    let from = byId<HTMLInputElement>('export-from').value;
    if (range === 'custom' && !from && !byId<HTMLInputElement>('export-to').value) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      from = localInputValue(start.getTime() - 7 * 86_400_000);
    }
    this.choices = normalizeChoices({
      format: checkedValue('export-format') ?? this.choices.format,
      packaging: checkedValue('export-packaging') ?? this.choices.packaging,
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
    check('export-format', choices.format);
    const packagings = choices.format === 'pdf' ? (['file'] as Packaging[]) : packagingsFor(choices.format, choices.content);
    const packaging = byId('export-packaging');
    // Drawn again only when the ways to package change, so the focus stays on the one chosen.
    const signature = packagings.map((value) => `${value}:${packagingLabel(choices.format, value)}`).join('|');
    if (packaging.dataset.signature !== signature) {
      packaging.replaceChildren(...packagings.map((value) => segment('export-packaging', value, packagingLabel(choices.format, value))));
      packaging.dataset.signature = signature;
    }
    check('export-packaging', choices.packaging);
    // With one way to package it, the explanation says which.
    byId('export-packaging-field').hidden = packagings.length < 2;
    check('export-range', choices.range);
    byId<HTMLInputElement>('export-from').value = choices.from;
    byId<HTMLInputElement>('export-to').value = choices.to;
    byId('export-period').hidden = choices.range !== 'custom';
    const fixed = fixedContent(choices.format);
    for (const { key, id } of CONTENT_FIELDS) {
      const input = byId<HTMLInputElement>(id);
      const forced = fixed[key];
      input.checked = forced ?? choices.content[key];
      input.disabled = forced !== undefined;
    }
    byId('export-content-note').hidden = Object.keys(fixed).length === 0;
    const preset = presetInUse(choices);
    for (const name of PRESETS) byId<HTMLInputElement>(`preset-${name}`).checked = name === preset;
    this.update();
  }

  private update(): void {
    const keys = this.selectedKeys();
    const count = keys.length;
    const notShown = this.inputs().filter((input) => input.checked && input.closest('label')?.hidden).length;
    byId('export-selected-count').textContent = `${count} of ${this.records.length} selected${notShown > 0 ? ` (${notShown} not shown)` : ''}`;
    const explained = explainChoices(this.choices, count);
    byId('export-explain').textContent = explained.text;
    byId('export-inside-text').textContent = explained.inside;
    byId('export-inside').hidden = explained.inside === '';
    const button = byId<HTMLButtonElement>('btn-export-run');
    button.textContent = this.running ? 'Exporting…' : exportButtonLabel(this.choices, count);
    button.disabled = this.running || count === 0;
    // A disabled Export says why.
    const hint = byId('export-run-hint');
    hint.textContent = this.running ? '' : this.records.length === 0 ? 'Nothing to export yet.' : count === 0 ? 'Select at least one conversation.' : '';
    hint.hidden = hint.textContent === '';
    if (!this.running) this.showFileName(keys);
  }

  /**
   * The bar's line before an export: the file it will save, or for PDF what opens. A result or an
   * error in the bar takes its place until a choice changes.
   */
  private showFileName(keys: readonly string[]): void {
    const chosen = new Set(keys);
    const records = this.records.filter((record) => chosen.has(record.conversationKey));
    const name = records.length === 0 ? null : plannedFileName(this.choices, records, new Date());
    const said = !byId('export-message').hidden;
    const line = said || records.length === 0 ? '' : name === null ? 'Opens the print dialog in a new tab' : `Will save ${name}`;
    const element = byId('export-will-save');
    element.textContent = line;
    element.hidden = line === '';
    byId('export-progress').hidden = true;
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

  /** The bar's line during an export, and a bar for which conversation of several is being written. */
  private progress = (progress: ExportProgress): void => {
    const several = progress.conversations > 1;
    const line = byId('export-will-save');
    line.textContent = `Writing ${formatNumber(progress.messages)} messages${several ? `, conversation ${progress.conversation} of ${progress.conversations}` : ''}`;
    line.hidden = false;
    const bar = byId('export-progress');
    bar.hidden = !several;
    if (several) {
      const percent = Math.round(((progress.conversation - 1) / progress.conversations) * 100);
      byId('export-progress-fill').style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
      bar.setAttribute('aria-valuetext', `Conversation ${progress.conversation} of ${progress.conversations}`);
    }
  };

  private run(): void {
    const keys = this.selectedKeys();
    if (this.running || keys.length === 0) return;
    const request = this.request(keys);
    if (!request) {
      this.update();
      return;
    }
    const win = request.format === 'pdf' ? window.open('', '_blank') : null;
    this.running = true;
    this.message('');
    this.update();
    const line = byId('export-will-save');
    line.textContent = 'Preparing the export…';
    line.hidden = false;
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
