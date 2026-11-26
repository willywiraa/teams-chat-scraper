/**
 * Settings on the archive page: General (scrolling speed, pictures, pausing, your name, date
 * order, run limits) and Advanced (collapsed: every scrolling and waiting value, re-reading by
 * default, selector overrides). The theme is in the page's header: it applies at once, while
 * these wait for Save settings.
 *
 * The stored settings keep their keys; the speed preset is worked out from the stored values,
 * so earlier custom values show as Custom.
 */
import { buildSelectorProfile, DEFAULT_SELECTOR_PROFILE, findInvalidSelectors } from '../../extractor/selectors';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  SETTING_LIMITS,
  SETTINGS_REVISION,
  SETTINGS_STORAGE_KEY,
  settingsForStorage,
  SPEED_KEYS,
  SPEED_PRESETS,
  speedOf,
  type ScrapeSettings,
  type ScrollSpeed,
} from '../../shared/settings';
import { byId, el, errorText, formatNumber } from '../common';

type NumericSetting = keyof typeof SETTING_LIMITS;
interface NumberField {
  key: NumericSetting;
  label: string;
  step?: number;
  /** The line under the field; else its range, "1 to 1,440". */
  hint?: string;
}

/** General: a short label, and what it means in the line under the field. */
const GENERAL_NUMBERS: NumberField[] = [
  { key: 'maxDurationMinutes', label: 'Longest run (minutes)' },
  { key: 'updateOverlapDays', label: 'Recheck days', hint: 'Days before the last update checked again for edits.' },
];

const ADVANCED_NUMBERS: NumberField[] = [
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
  { key: 'incrementalOverlap', label: 'Update: archived messages to see again before stopping (at least)' },
  { key: 'maxImageMB', label: 'Largest image to save (MB)' },
];

const NUMBER_FIELDS = [...GENERAL_NUMBERS, ...ADVANCED_NUMBERS];

const SPEED_LABELS: Record<ScrollSpeed | 'custom', string> = {
  gentle: 'Gentle',
  normal: 'Normal',
  fast: 'Fast',
  custom: 'Custom (set under Advanced)',
};

function numberField({ key, label, step, hint }: NumberField): HTMLLabelElement {
  const [min, max] = SETTING_LIMITS[key];
  return el(
    'label',
    { className: 'field', for: key },
    el('span', {}, label),
    el('input', { type: 'number', id: key, name: key, min: String(min), max: String(max), step: String(step ?? 1), inputmode: 'decimal' }),
    el('span', { className: 'hint' }, hint ?? `${formatNumber(min)} to ${formatNumber(max)}`),
  );
}

/** A checkbox, its short label, and the line under the label that explains it. */
function checkField(id: string, label: string, hint?: string): HTMLLabelElement {
  return el(
    'label',
    { className: 'check field', for: id },
    el('input', { type: 'checkbox', id }),
    el('span', {}, label, hint ? el('span', { className: 'hint' }, hint) : null),
  );
}

/** What the bar beside **Save settings** says until something is saved or reset. */
const SETTINGS_NOTE = 'New settings apply to the next run.';

function settingsMessage(text: string, kind: 'notice' | 'error' | 'success' = 'notice'): void {
  const element = byId('settings-message');
  element.textContent = text || SETTINGS_NOTE;
  element.className = text ? `${kind} small` : 'muted small';
}

// ------------------------------------------------------------------- form

export function buildSettings(): void {
  byId('settings-general-fields').replaceChildren(
    el(
      'label',
      { className: 'field', for: 'scroll-speed' },
      el('span', {}, 'Scrolling speed'),
      el('select', { id: 'scroll-speed' }, ...(Object.keys(SPEED_LABELS) as Array<ScrollSpeed | 'custom'>).map((speed) => el('option', { value: speed }, SPEED_LABELS[speed]))),
      el('span', { className: 'hint' }, 'Use Gentle on slow computers.'),
    ),
    ...GENERAL_NUMBERS.map(numberField),
    el(
      'label',
      { className: 'field', for: 'selfDisplayName' },
      el('span', {}, 'Your display name'),
      el('input', { type: 'text', id: 'selfDisplayName', maxlength: '200', placeholder: 'As shown in Teams' }),
      el('span', { className: 'hint' }, 'Marks your own messages.'),
    ),
    el(
      'label',
      { className: 'field', for: 'dateOrder' },
      el('span', {}, 'Date order'),
      el(
        'select',
        { id: 'dateOrder' },
        el('option', { value: 'auto' }, 'Automatic'),
        el('option', { value: 'MDY' }, 'Month/Day/Year'),
        el('option', { value: 'DMY' }, 'Day/Month/Year'),
        el('option', { value: 'YMD' }, 'Year/Month/Day'),
      ),
      el('span', { className: 'hint' }, 'Only if Teams dates read wrong.'),
    ),
    checkField('saveImages', 'Keep pictures while capturing', 'Needed to include pictures in saved files.'),
    checkField('pauseWhenHidden', 'Pause when the Teams tab is hidden', 'Recommended. Hidden tabs run slowly.'),
  );
  byId('settings-fields').replaceChildren(
    ...ADVANCED_NUMBERS.map(numberField),
    checkField('rescanByDefault', 'Re-read archived parts by default', 'The popup’s option under Options. Finds edits and deletions. Slower.'),
  );
  // How many settings Advanced holds while it is closed: the numbers, the checkbox and the selector overrides.
  byId('advanced-hint').textContent = `${ADVANCED_NUMBERS.length + 2} settings`;

  byId<HTMLSelectElement>('scroll-speed').addEventListener('change', (event) => {
    const speed = (event.target as HTMLSelectElement).value as ScrollSpeed | 'custom';
    if (speed === 'custom') return;
    for (const key of SPEED_KEYS) byId<HTMLInputElement>(key).value = String(SPEED_PRESETS[speed][key]);
    showSpeed();
  });
  for (const key of SPEED_KEYS) byId(key).addEventListener('input', showSpeed);
  byId('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings();
  });
  byId('btn-defaults').addEventListener('click', () => {
    fillSettings({ ...DEFAULT_SETTINGS });
    settingsMessage('Defaults restored in the form. Click "Save settings" to apply.');
  });
  byId('btn-insert-selectors').addEventListener('click', () => {
    const { version: _version, ...profile } = DEFAULT_SELECTOR_PROFILE;
    byId<HTMLTextAreaElement>('selectorOverrides').value = JSON.stringify(profile, null, 2);
    settingsMessage('Default selectors inserted. Edit only the entries you need, remove the rest, then save.');
  });
}

/** The speed select shows the preset the scrolling values match, and Custom only when they match none. */
function showSpeed(): void {
  const values = Object.fromEntries(SPEED_KEYS.map((key) => [key, Number(byId<HTMLInputElement>(key).value)])) as Pick<ScrapeSettings, (typeof SPEED_KEYS)[number]>;
  const speed = speedOf(values);
  const select = byId<HTMLSelectElement>('scroll-speed');
  const custom = select.querySelector<HTMLOptionElement>('option[value="custom"]') as HTMLOptionElement;
  custom.hidden = speed !== 'custom';
  custom.disabled = speed !== 'custom';
  select.value = speed;
}

function fillSettings(settings: ScrapeSettings): void {
  for (const { key } of NUMBER_FIELDS) byId<HTMLInputElement>(key).value = String(settings[key]);
  byId<HTMLInputElement>('selfDisplayName').value = settings.selfDisplayName;
  byId<HTMLSelectElement>('dateOrder').value = settings.dateOrder;
  byId<HTMLInputElement>('pauseWhenHidden').checked = settings.pauseWhenHidden;
  byId<HTMLInputElement>('saveImages').checked = settings.saveImages;
  byId<HTMLInputElement>('rescanByDefault').checked = settings.rescanByDefault;
  byId<HTMLTextAreaElement>('selectorOverrides').value = settings.selectorOverrides;
  showSpeed();
}

function readSettings(): { settings: ScrapeSettings; adjusted: string[] } {
  const raw: Record<string, unknown> = {};
  for (const { key } of NUMBER_FIELDS) raw[key] = byId<HTMLInputElement>(key).value;
  raw.selfDisplayName = byId<HTMLInputElement>('selfDisplayName').value;
  raw.dateOrder = byId<HTMLSelectElement>('dateOrder').value;
  raw.pauseWhenHidden = byId<HTMLInputElement>('pauseWhenHidden').checked;
  raw.saveImages = byId<HTMLInputElement>('saveImages').checked;
  raw.rescanByDefault = byId<HTMLInputElement>('rescanByDefault').checked;
  raw.selectorOverrides = byId<HTMLTextAreaElement>('selectorOverrides').value;
  raw.revision = SETTINGS_REVISION;
  const settings = normalizeSettings(raw);
  // Empty, out-of-range or fractional values are corrected: say which.
  const adjusted = NUMBER_FIELDS.filter(({ key }) => String(settings[key]) !== String(raw[key]).trim()).map(({ label }) => label);
  return { settings, adjusted };
}

async function loadSettings(): Promise<ScrapeSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
}

async function saveSettings(): Promise<void> {
  const { settings, adjusted } = readSettings();
  try {
    const profile = buildSelectorProfile(settings.selectorOverrides);
    const invalid = findInvalidSelectors(profile, document);
    if (invalid.length > 0) throw new Error(`Invalid selectors: ${invalid.join(', ')}`);
  } catch (error) {
    byId<HTMLDetailsElement>('settings-advanced').open = true;
    settingsMessage(errorText(error), 'error');
    return;
  }
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settingsForStorage(settings) });
  fillSettings(settings);
  settingsMessage(
    `Saved. New settings apply to the next run.${adjusted.length > 0 ? ` Adjusted to the allowed range: ${adjusted.join('; ')}.` : ''}`,
    'success',
  );
}

// ---------------------------------------------------------------- section

let filled = false;

/** Fills the form with the stored settings, once: after that it keeps what is being edited. */
export async function showSettings(openAdvanced: boolean): Promise<void> {
  if (!filled) {
    fillSettings(await loadSettings());
    filled = true;
  }
  if (openAdvanced) byId<HTMLDetailsElement>('settings-advanced').open = true;
}
