/**
 * The choice of a file to save, shown in the popup (after a capture, or from the archive only)
 * and on a chat's page in the archive: the format, and what the file includes. The choices are
 * remembered in chrome.storage.local under the key the Export section used, so they carry over
 * (an HTML page, Markdown or CSV chosen there becomes PDF).
 */
import {
  DEFAULT_SAVE_CHOICES,
  fixedContent,
  normalizeSaveChoices,
  packagingOf,
  SAVE_FORMATS,
  type ExportContent,
  type SaveChoices,
  type SaveFormat,
} from '../export/options';
import { el } from './common';
import { icon, type IconName } from './icons';

export const SAVE_CHOICES_KEY = 'exportChoices.v1';

export const FORMAT_NAMES: Record<SaveFormat, string> = { pdf: 'PDF', text: 'Text', json: 'JSON', package: 'ZIP package' };

/** The names in the popup's row of four, where *ZIP package* would not fit; the line under it says what the ZIP holds. */
export const SHORT_FORMAT_NAMES: Record<SaveFormat, string> = { ...FORMAT_NAMES, package: 'ZIP' };

/** A printer for the print dialog, a page of lines, a page of braces, a page with a zip. */
const FORMAT_ICONS: Record<SaveFormat, IconName> = { pdf: 'printer', text: 'file-text', json: 'file-braces', package: 'file-archive' };

/** The Include list. *Pictures* are the pictures the archive saved while capturing (Settings, Save pictures). */
export const CONTENT_FIELDS: ReadonlyArray<{ key: keyof ExportContent; label: string; icon: IconName }> = [
  { key: 'images', label: 'Pictures', icon: 'image' },
  { key: 'attachments', label: 'File attachments', icon: 'paperclip' },
  { key: 'replies', label: 'Reply context', icon: 'reply' },
  { key: 'reactions', label: 'Reactions', icon: 'smile' },
  { key: 'systemMessages', label: 'System messages', icon: 'info' },
  { key: 'editHistory', label: 'Edit history', icon: 'pencil' },
];

/** The line under the formats: what the chosen one makes. */
export function formatLine(choices: SaveChoices): string {
  switch (choices.format) {
    case 'pdf':
      return 'Opens the print dialog to save a PDF.';
    case 'text':
      return packagingOf(choices) === 'zip' ? 'A ZIP with the text and the pictures as files.' : 'One plain-text file.';
    case 'json':
      return 'Complete records in one file. Import archive… reads it back.';
    case 'package':
      return 'A ZIP with a transcript, the records and the pictures. Import archive… reads it back.';
  }
}

/** The file, after "save": "a PDF", "the text and pictures (ZIP)". */
export function fileNoun(choices: SaveChoices): string {
  switch (choices.format) {
    case 'pdf':
      return 'a PDF';
    case 'text':
      return packagingOf(choices) === 'zip' ? 'the text and pictures (ZIP)' : 'a text file';
    case 'json':
      return 'a JSON file';
    case 'package':
      return 'a ZIP package';
  }
}

/** The file in the popup's capture button, after "save": "PDF", "text", "text (ZIP)", "JSON", "ZIP". */
export function fileShortName(choices: SaveChoices): string {
  switch (choices.format) {
    case 'pdf':
      return 'PDF';
    case 'text':
      return packagingOf(choices) === 'zip' ? 'text (ZIP)' : 'text';
    case 'json':
      return 'JSON';
    case 'package':
      return 'ZIP';
  }
}

export async function loadSaveChoices(): Promise<SaveChoices> {
  try {
    const stored = await chrome.storage.local.get(SAVE_CHOICES_KEY);
    return normalizeSaveChoices(stored[SAVE_CHOICES_KEY] ?? DEFAULT_SAVE_CHOICES);
  } catch {
    return normalizeSaveChoices(DEFAULT_SAVE_CHOICES);
  }
}

export function rememberSaveChoices(choices: SaveChoices): void {
  void chrome.storage.local.set({ [SAVE_CHOICES_KEY]: choices }).catch(() => undefined);
}

/**
 * The format row (segments, the line under it) and the Include checklist, drawn into `root`. A
 * choice the format fixes stays ticked and disabled, with the note that says why.
 */
export class SaveForm {
  private choices: SaveChoices = normalizeSaveChoices(DEFAULT_SAVE_CHOICES);
  private disabled = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (choices: SaveChoices) => void = () => undefined,
    names: Record<SaveFormat, string> = FORMAT_NAMES,
  ) {
    root.replaceChildren(
      el(
        'fieldset',
        { className: 'choice-group' },
        el('legend', { className: 'group-label' }, 'Format'),
        el(
          'div',
          { className: 'segments format-row' },
          ...SAVE_FORMATS.map((format) =>
            el(
              'label',
              { className: 'segment', for: `save-format-${format}` },
              el('input', { type: 'radio', name: 'save-format', id: `save-format-${format}`, value: format }),
              el('span', { className: 'icon-holder' }, icon(FORMAT_ICONS[format])),
              el('span', {}, names[format]),
            ),
          ),
        ),
        el('p', { className: 'small save-line', 'data-part': 'line' }),
      ),
      el(
        'fieldset',
        { className: 'choice-group' },
        el('legend', { className: 'group-label' }, 'Include in the file'),
        el(
          'div',
          { className: 'include-list' },
          ...CONTENT_FIELDS.map(({ key, label, icon: name }) =>
            el(
              'label',
              { className: 'check', for: `save-include-${key}` },
              el('input', { type: 'checkbox', id: `save-include-${key}`, name: 'save-include', value: key }),
              el('span', { className: 'icon-holder check-icon' }, icon(name)),
              el('span', {}, label),
            ),
          ),
        ),
        el(
          'p',
          { className: 'muted small save-line', 'data-part': 'note', hidden: true },
          'JSON and the ZIP package always include file attachments and reply context: they are part of each record.',
        ),
      ),
    );
    // A click on a box fires "input" before "change". The form reads it on "input": the page
    // around it may redraw on that event, and a redraw before the read would undo the click.
    root.addEventListener('input', () => this.read());
    root.addEventListener('change', () => this.read());
    this.write();
  }

  get value(): SaveChoices {
    return { format: this.choices.format, content: { ...this.choices.content } };
  }

  set(choices: SaveChoices): void {
    this.choices = normalizeSaveChoices(choices);
    this.write();
  }

  setDisabled(disabled: boolean): void {
    if (disabled === this.disabled) return;
    this.disabled = disabled;
    this.write();
  }

  private input(selector: string): HTMLInputElement {
    return this.root.querySelector<HTMLInputElement>(selector) as HTMLInputElement;
  }

  private read(): void {
    const format = this.root.querySelector<HTMLInputElement>('input[name="save-format"]:checked')?.value ?? this.choices.format;
    const content = { ...this.choices.content };
    for (const { key } of CONTENT_FIELDS) {
      const input = this.input(`#save-include-${key}`);
      // A choice the format fixes keeps what the user had chosen for the other formats.
      if (!input.disabled) content[key] = input.checked;
    }
    const choices = normalizeSaveChoices({ format, content });
    if (JSON.stringify(choices) === JSON.stringify(this.choices)) return;
    this.choices = choices;
    rememberSaveChoices(this.choices);
    this.write();
    this.onChange(this.value);
  }

  private write(): void {
    for (const input of this.root.querySelectorAll<HTMLInputElement>('input[name="save-format"]')) {
      input.checked = input.value === this.choices.format;
      input.disabled = this.disabled;
    }
    const fixed = fixedContent(this.choices.format);
    for (const { key } of CONTENT_FIELDS) {
      const input = this.input(`#save-include-${key}`);
      input.checked = fixed[key] ?? this.choices.content[key];
      input.disabled = this.disabled || fixed[key] !== undefined;
    }
    (this.root.querySelector('[data-part="line"]') as HTMLElement).textContent = formatLine(this.choices);
    (this.root.querySelector('[data-part="note"]') as HTMLElement).hidden = Object.keys(fixed).length === 0;
  }
}
