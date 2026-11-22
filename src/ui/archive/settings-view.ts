/**
 * The Settings section: General (scrolling speed, images, pausing, run limits),
 * Advanced (collapsed: every scrolling and waiting value, names and dates, selector overrides),
 * Storage (usage, backup, import), Troubleshooting (diagnostics of an open Teams tab) and About.
 * The theme is in the page's header: it applies at once, while these wait for Save settings.
 *
 * The stored settings keep their keys; the speed preset is worked out from the stored values,
 * so earlier custom values show as Custom.
 */
import type { DiagnosticsReport } from '../../extractor/diagnostics';
import { buildSelectorProfile, DEFAULT_SELECTOR_PROFILE, findInvalidSelectors } from '../../extractor/selectors';
import { TEAMS_MATCH_PATTERNS, type ContentStatus, type Response } from '../../shared/protocol';
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
import { byId, el, errorText, formatNumber, TYPE_LABELS } from '../common';
import type { SettingsSection } from '../view-models';
import type { AppContext } from './context';
import { storageUsed } from './overview';

type NumericSetting = keyof typeof SETTING_LIMITS;
interface NumberField {
  key: NumericSetting;
  label: string;
  step?: number;
}

const GENERAL_NUMBERS: NumberField[] = [
  { key: 'maxDurationMinutes', label: 'Maximum run duration (minutes)' },
  { key: 'updateOverlapDays', label: 'Update: days before the last update to check again for edits and late replies' },
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
  gentle: 'Gentle: slower, for slow computers or connections',
  normal: 'Normal',
  fast: 'Fast: shorter waits, for fast computers',
  custom: 'Custom (set under Advanced)',
};

function numberField({ key, label, step }: NumberField): HTMLLabelElement {
  const [min, max] = SETTING_LIMITS[key];
  return el(
    'label',
    { className: 'field', for: key },
    el('span', {}, label),
    el('input', { type: 'number', id: key, name: key, min: String(min), max: String(max), step: String(step ?? 1), inputmode: 'decimal' }),
    el('span', { className: 'hint' }, `${formatNumber(min)} to ${formatNumber(max)}`),
  );
}

function checkField(id: string, label: string): HTMLLabelElement {
  return el('label', { className: 'check field', for: id }, el('input', { type: 'checkbox', id }), el('span', {}, label));
}

function settingsMessage(text: string, kind: 'notice' | 'error' | 'success' = 'notice'): void {
  const element = byId('settings-message');
  element.textContent = text;
  element.className = `${kind} small`;
  element.hidden = text === '';
}

// ------------------------------------------------------------------- form

export function buildSettings(app: AppContext): void {
  byId('settings-general-fields').replaceChildren(
    el(
      'label',
      { className: 'field', for: 'scroll-speed' },
      el('span', {}, 'Scrolling speed'),
      el('select', { id: 'scroll-speed' }, ...(Object.keys(SPEED_LABELS) as Array<ScrollSpeed | 'custom'>).map((speed) => el('option', { value: speed }, SPEED_LABELS[speed]))),
    ),
    ...GENERAL_NUMBERS.map(numberField),
    checkField('saveImages', 'Save the images shown in messages (the copy Teams already displays)'),
    checkField('pauseWhenHidden', 'Pause while the Teams tab is hidden (recommended: background tabs are throttled)'),
  );
  byId('settings-fields').replaceChildren(
    ...ADVANCED_NUMBERS.map(numberField),
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
    checkField('rescanByDefault', 'Re-read archived parts at normal speed by default (the popup’s option under More)'),
  );

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
  byId('btn-storage-backup').addEventListener('click', () => app.exportConversations(undefined, 'backup'));
  byId('btn-diag-refresh').addEventListener('click', () => void findTeamsTabs(null));
  byId('btn-diag').addEventListener('click', () => void runDiagnostics());
  byId('btn-diag-copy').addEventListener('click', () => void navigator.clipboard.writeText(diagnosticsText).then(() => setDiagStatus('Report copied.')));
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

/** Shows the Settings section, scrolled to a part of it; `tabId` chooses the Teams tab for diagnostics. */
export async function showSettings(app: AppContext, section: SettingsSection | null, tabId: number | null): Promise<void> {
  if (!filled) {
    fillSettings(await loadSettings());
    filled = true;
  }
  await renderStorage();
  if (section === 'troubleshooting' || tabId !== null || byId<HTMLSelectElement>('diag-tab').options.length === 0) await findTeamsTabs(tabId);
  if (section === 'advanced') byId<HTMLDetailsElement>('settings-advanced').open = true;
  const target = section === 'storage' ? 'settings-storage' : section === 'troubleshooting' ? 'settings-troubleshooting' : section === 'advanced' ? 'settings-advanced' : null;
  if (target) byId(target).scrollIntoView({ block: 'start' });
}

/** The heading to move the focus to when a part of Settings is opened by its address. */
export function settingsHeading(section: SettingsSection | null): HTMLElement | null {
  return section ? byId(`${section}-title`) : null;
}

/** The storage figures; what the archive holds is in Overview. */
async function renderStorage(): Promise<void> {
  const storage = await storageUsed();
  let persisted: boolean | null = null;
  try {
    persisted = await navigator.storage.persisted();
  } catch {
    persisted = null;
  }
  const stat = (label: string, value: string) => el('div', {}, el('dt', {}, label), el('dd', {}, value));
  byId('storage-stats').replaceChildren(
    stat('Used', storage?.used ?? '–'),
    stat('Available to the browser', storage?.quota ?? '–'),
    stat('Kept when space runs low', persisted === null ? '–' : persisted ? 'Yes' : 'No'),
  );
}

// -------------------------------------------------------- troubleshooting

let diagnosticsText = '';

function setDiagStatus(text: string): void {
  byId('diag-status').textContent = text;
}

/** Lists the open Teams tabs, the most recently used first, choosing `preferred` when it is one of them. */
async function findTeamsTabs(preferred: number | null): Promise<void> {
  const select = byId<HTMLSelectElement>('diag-tab');
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: TEAMS_MATCH_PATTERNS });
  } catch (error) {
    setDiagStatus(`Teams tabs could not be listed: ${errorText(error)}`);
  }
  tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const previous = preferred ?? (select.value ? Number(select.value) : null);
  select.replaceChildren(...tabs.filter((tab) => tab.id !== undefined).map((tab) => el('option', { value: String(tab.id) }, tab.title || 'Microsoft Teams')));
  if (previous !== null && tabs.some((tab) => tab.id === previous)) select.value = String(previous);
  select.disabled = tabs.length === 0;
  byId<HTMLButtonElement>('btn-diag').disabled = tabs.length === 0;
  byId('diag-tabs-empty').hidden = tabs.length > 0;
}

async function sendToTab<T>(tabId: number, command: { type: 'content/status' | 'content/diagnostics' }): Promise<T> {
  const response = (await chrome.tabs.sendMessage(tabId, command)) as Response<T> | undefined;
  if (!response) throw new Error('No response from the page');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

const PROBE_REGION_LABELS: Record<string, string> = {
  'selected-entry': 'selected entry',
  'chat-header': 'header',
  'message-list': 'messages',
  main: 'main area',
  elsewhere: 'chat list and rest',
};

/** For example "header 1, chat list and rest 12", or "none". */
function idPlaces(report: DiagnosticsReport, family: 'thread' | 'person'): string {
  const places = Object.entries(report.identifiers.distinct[family]).filter(([, count]) => (count ?? 0) > 0);
  return places.length > 0 ? places.map(([region, count]) => `${PROBE_REGION_LABELS[region] ?? region} ${count}`).join(', ') : 'none';
}

export function diagnosticsSummary(report: DiagnosticsReport): string {
  const p = report.parse;
  const parts = [
    report.messageList.found ? 'message list found' : 'message list NOT found',
    report.conversation.detected ? `chat detected (${report.conversation.hasThreadId ? 'by id' : 'by title'})` : 'chat NOT detected',
    `${p.messages} messages parsed (${p.withMessageId} with id, ${p.senderExplicit + p.senderSelf + p.senderInferred} with sender, ${p.withReactions ?? 0} with reactions)`,
    `chat ids on the page: ${idPlaces(report, 'thread')}`,
    `person ids: ${idPlaces(report, 'person')}`,
  ];
  return parts.join(' · ') + (report.warnings.length ? ` · ${report.warnings.join(' ')}` : '');
}

async function runDiagnostics(): Promise<void> {
  const tabId = Number(byId<HTMLSelectElement>('diag-tab').value);
  const output = byId('diag-output');
  diagnosticsText = '';
  setDiagStatus('Running diagnostics…');
  try {
    const status = await sendToTab<ContentStatus>(tabId, { type: 'content/status' });
    const chat = status.conversation
      ? `Chat: ${status.conversation.title ?? 'untitled'} (${TYPE_LABELS[status.conversation.type]}, recognised ${status.conversation.threadId ? 'by its id' : 'by its title and messages'})`
      : `No chat detected${status.conversationError ? `: ${status.conversationError}` : ''}`;
    const onScreen = status.visibleMessages === null ? '' : ` · ${formatNumber(status.visibleMessages)} messages on screen`;
    const report = await sendToTab<DiagnosticsReport>(tabId, { type: 'content/diagnostics' });
    // The version says which selectors the report was made with.
    diagnosticsText = JSON.stringify({ extensionVersion: chrome.runtime.getManifest().version, ...report }, null, 2);
    setDiagStatus(`${chat}${onScreen}`);
    byId('diag-summary').textContent = diagnosticsSummary(report);
    output.textContent = diagnosticsText;
  } catch (error) {
    const text = errorText(error);
    setDiagStatus(
      /Receiving end does not exist|Could not establish connection|No response from the page/i.test(text)
        ? 'The extension is not connected to this tab: it was opened before the extension was loaded or updated. Reload the Teams tab, then try again.'
        : `Diagnostics failed: ${text}`,
    );
    byId('diag-summary').textContent = '';
    output.textContent = '';
  }
  byId('diag-summary').hidden = diagnosticsText === '';
  output.hidden = diagnosticsText === '';
  byId('btn-diag-copy').hidden = diagnosticsText === '';
}
