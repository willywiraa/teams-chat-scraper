/**
 * Popup / side panel: remote control for the content script in the active Teams tab, plus a
 * summary of what is already archived for the open conversation. One flow: which messages to
 * capture, whether to save a file (its format and what it includes), and one button.
 */
import { saveTargetHash, type SaveChoices, type TimeRange } from '../export/options';
import { capturePlan, updateAnchor, type CaptureChoice } from '../shared/capture';
import {
  STALE_SESSION_MS,
  TEAMS_URL_PATTERN,
  type ContentCommand,
  type ContentStatus,
  type FinishedSessionInfo,
  type Response,
} from '../shared/protocol';
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_STORAGE_KEY, type ScrapeSettings } from '../shared/settings';
import { conversationLabel, type ConversationRecord, type ScrapeMode, type SessionCounters, type SessionRecord } from '../shared/types';
import type { ConversationResolution } from '../storage/conversation-identity';
import { coverageStatus } from '../storage/coverage';
import { ArchiveRepository } from '../storage/repository';
import {
  byId,
  captureLabel,
  countOf,
  el,
  errorText,
  formatDate,
  formatAgo,
  formatDateTime,
  formatDuration,
  formatMoment,
  formatNumber,
  outcomeText,
  runSubject,
  setHidden,
  setText,
  STOP_REASON_LABELS,
  TYPE_LABELS,
} from './common';
import { icon, placeIcons, type IconName } from './icons';
import { LAST_SAVE_KEY, parseLastSave, readLastSave, type LastSave } from './last-save';
import { fileNoun, loadSaveChoices, SaveForm } from './save-form';
import { wireThemeButton } from './theme-button';
import { historyLine, reachShare, routeHash, type Route } from './view-models';

/** The capture choices of the popup: new messages, a period, or the full history. */
type PopupChoice = CaptureChoice;

/** Whether a capture also saves a file (the **Save a file** checkbox), remembered. */
const SAVE_AFTER_KEY = 'saveAfterCapture.v1';

const isPanel = document.body.dataset.mode === 'panel';
let tab: chrome.tabs.Tab | null = null;
let repositoryPromise: Promise<ArchiveRepository> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let resumable: SessionRecord | null = null;
/** How far back this chat's archive reaches (its oldest message), to say where a run passes to. */
let archivedFrom: number | null = null;
let busy = false;
let settings: ScrapeSettings = { ...DEFAULT_SETTINGS };
/** The re-read option is preset from the settings once; after that it is the user's choice. */
let rescanPreset = false;
/** Set by **Start another capture instead**: the capture choices replace Resume for this chat. */
let otherCapture = false;
let saveForm: SaveForm | null = null;
/** What the save page did for the last capture that saved a file. */
let lastSave: LastSave | null = null;
/** What the capture controls were last drawn for; the choice is preset once per chat. */
const captureState: { record: ConversationRecord | null; conversationKey: string | null; idle: boolean; presetFor: string | null } = {
  record: null,
  conversationKey: null,
  idle: false,
  presetFor: null,
};

async function loadSettings(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    settings = normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function repository(): Promise<ArchiveRepository> {
  repositoryPromise ??= ArchiveRepository.open();
  return repositoryPromise;
}

async function sendToTab<T>(command: ContentCommand): Promise<T> {
  if (!tab?.id) throw new Error('No active tab');
  const response = (await chrome.tabs.sendMessage(tab.id, command)) as Response<T> | undefined;
  if (!response) throw new Error('No response from the page');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

function isMissingReceiver(error: unknown): boolean {
  return /Receiving end does not exist|Could not establish connection|No response from the page/i.test(errorText(error));
}

function showView(view: 'message' | 'connect' | 'main', message?: string): void {
  setHidden('view-loading', true);
  setHidden('view-message', view !== 'message');
  setHidden('view-connect', view !== 'connect');
  setHidden('view-main', view !== 'main');
  if (view === 'message') setText('view-message', message ?? '');
}

function stopPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
}

async function init(): Promise<void> {
  stopPolling();
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active ?? null;
  if (!tab?.id || !TEAMS_URL_PATTERN.test(tab.url ?? '')) {
    showView('message', 'Open Microsoft Teams in this tab (teams.microsoft.com or teams.cloud.microsoft), sign in as usual, and open the chat you want to archive.');
    return;
  }
  await loadSettings();
  if (!rescanPreset) {
    byId<HTMLInputElement>('opt-rescan').checked = settings.rescanByDefault;
    rescanPreset = true;
    await loadSaveState();
  }
  await refresh();
  pollTimer = setInterval(() => void refresh(), 1000);
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    let status: ContentStatus;
    try {
      status = await sendToTab<ContentStatus>({ type: 'content/status' });
    } catch (error) {
      if (isMissingReceiver(error)) showView('connect');
      else showView('message', `Cannot reach the Teams page: ${errorText(error)}`);
      return;
    }
    showView('main');
    renderStatus(status);
    await renderArchive(status);
  } finally {
    refreshing = false;
  }
}

function renderStatus(status: ContentStatus): void {
  const conversation = status.conversation;
  setText('conv-title', conversation?.title ?? 'No chat detected');
  setText('conv-type', conversation ? TYPE_LABELS[conversation.type] : '');
  setHidden('conv-type', !conversation);
  setText('conv-meta', conversation ? '' : status.conversationError ?? 'Open a 1:1 or group chat in Teams.');
  setHidden('conv-meta', Boolean(conversation));
  // Without a chat id, the messages on screen tell renamed chats and chats with the same title apart.
  const warning = conversation && !conversation.threadId && status.state === 'idle' && status.evidence && status.evidence.messages.length === 0
    ? 'Teams shows no chat id and no message ids here, so this chat is recognised by its title only. Scroll to some messages first.'
    : '';
  setText('conv-warning', warning);
  setHidden('conv-warning', !warning);

  const idle = status.state === 'idle';
  // What to try is said up front only when the extension finds nothing to archive.
  const result = status.lastResult?.counters;
  const runFoundNothing = result !== undefined && result.uniqueSeen + result.inserted + result.updated + result.unchanged === 0;
  const foundNothing = !conversation || (idle && (status.visibleMessages === 0 || runFoundNothing));
  setHidden('nothing-hint', !foundNothing);
  byId<HTMLButtonElement>('btn-resume-session').disabled = !idle || !conversation || busy;

  // During a run its progress and Stop take the place of the capture controls.
  setHidden('actions', !idle);
  setHidden('run-panel', idle);
  if (!idle) renderProgress(status);
  setHidden('result-panel', !idle || !status.lastResult);
  if (idle && status.lastResult) renderResult(status.lastResult);
  renderStatusBar(status);
}

/**
 * The line at the bottom: that the popup reaches the Teams tab and what the tab shows, or during a
 * run its phase, time and the messages seen so far. The run panel says the same in full.
 */
function renderStatusBar(status: ContentStatus): void {
  const bar = byId('status-bar');
  const seen = status.progress?.counters.uniqueSeen ?? 0;
  let tone = 'ready';
  let text = 'Connected to Teams';
  let detail = '';
  let count: string | null = null;
  if (status.state === 'idle') {
    if (!status.conversation) tone = 'idle';
    detail = !status.conversation ? 'no chat open' : status.visibleMessages === null ? '' : `${countOf(status.visibleMessages, 'message')} on screen`;
  } else {
    tone = status.state === 'paused' ? 'paused' : 'busy';
    text = byId('run-phase').textContent ?? '';
    detail = status.session ? formatDuration(Date.now() - Date.parse(status.session.startedAt)) : '';
    count = `${formatNumber(seen)} seen`;
  }
  bar.dataset.tone = tone;
  setText('status-text', text);
  setText('status-detail', detail ? ` · ${detail}` : '');
  setText('status-count', count ?? '');
  setHidden('status-count', count === null);
}

/**
 * A full-history run starts at the newest message, as Teams loads older ones only from there: it
 * says how far back the archived part goes, so passing it does not look like starting over.
 */
function passingPhase(mode: ScrapeMode | undefined): string {
  return mode === 'full' && archivedFrom !== null ? `Passing archived messages, back to ${formatDate(archivedFrom)}…` : 'Passing archived messages…';
}

function renderProgress(status: ContentStatus): void {
  const progress = status.progress;
  const counters = progress?.counters;
  let phase = 'Starting…';
  if (status.state === 'stopping') phase = 'Stopping…';
  else if (status.state === 'paused' || progress?.phase === 'paused') phase = 'Paused';
  else if (progress?.phase === 'waiting-visible') phase = 'Waiting: Teams tab is hidden';
  else if (progress?.phase === 'running') phase = progress.inCoveredRange ? passingPhase(status.session?.mode) : 'Extracting…';
  setText('run-phase', phase);
  setText(
    'run-elapsed',
    status.session ? `${runName(status.session.mode, status.session.captureFrom)} · ${formatDuration(Date.now() - Date.parse(status.session.startedAt))}` : '',
  );
  setText('run-seen', formatNumber(counters?.uniqueSeen ?? 0));
  setText('run-new', formatNumber(counters?.inserted ?? 0));
  setText('run-updated', formatNumber(counters?.updated ?? 0));
  setText('run-unchanged', formatNumber(counters?.unchanged ?? 0));
  const session = status.session;
  const captureFrom = session?.captureFrom;
  const oldest = progress?.oldestReached ?? null;
  // Only a range capture knows where it ends; an update usually takes seconds.
  const share = session?.mode === 'full' ? reachShare(session.startedAt, captureFrom, oldest) : null;
  const bar = byId('run-bar');
  bar.hidden = share === null;
  if (share !== null) {
    const percent = Math.round(share * 100);
    byId('run-bar-fill').style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(percent));
    bar.setAttribute('aria-valuetext', oldest ? `${percent}%, back to ${formatDateTime(oldest)}` : `${percent}%`);
  }
  let reach = '';
  if (typeof captureFrom === 'number') reach = oldest ? `Back to ${formatDateTime(oldest)}, going back to ${formatMoment(captureFrom)}` : `Going back to ${formatMoment(captureFrom)}`;
  else if (oldest) reach = `Reached back to ${formatDateTime(oldest)}`;
  setText('run-reach', reach);
  setHidden('run-reach', reach === '');
  const detail = [
    counters ? `${formatNumber(counters.passes)} scroll steps` : '',
    counters?.gapsDetected ? `${counters.gapsDetected} gap checks` : '',
    counters?.imagesSaved ? `${countOf(counters.imagesSaved, 'image')} saved` : '',
    counters?.imagesFailed ? `${countOf(counters.imagesFailed, 'image')} not saved` : '',
  ].filter(Boolean);
  setText('run-detail', detail.join(' · '));
  const save = status.session?.save ?? null;
  setText('run-save', save ? `Saves ${fileNoun(save)} when the capture ends.` : '');
  setHidden('run-save', !save);
  const warnings = byId('run-warnings');
  warnings.replaceChildren(...(progress?.warnings ?? []).slice(0, 3).map((w) => el('li', {}, w)));
  warnings.hidden = (progress?.warnings.length ?? 0) === 0;
  const paused = status.state === 'paused';
  setHidden('btn-pause', paused);
  setHidden('btn-continue', !paused);
  byId<HTMLButtonElement>('btn-pause').disabled = status.state !== 'running';
  byId<HTMLButtonElement>('btn-stop').disabled = status.state === 'stopping';
}

/** The run in progress, named as in the capture choice. */
function runName(mode: ScrapeMode, captureFrom: number | null | undefined): string {
  if (mode === 'incremental') return 'New messages since the last update';
  if (mode === 'visible') return 'The messages on screen';
  return captureLabel(mode, captureFrom);
}

/** "· 3 images saved (1 not saved)", or nothing when the run met no images. */
function imageSummary(counters: SessionCounters): string {
  const saved = counters.imagesSaved ?? 0;
  const failed = counters.imagesFailed ?? 0;
  if (saved === 0 && failed === 0) return '';
  return ` · ${formatNumber(saved)} images saved${failed > 0 ? ` (${formatNumber(failed)} not saved)` : ''}`;
}

const RESULT_ICONS: Record<'success' | 'notice' | 'error', IconName> = { success: 'circle-check', notice: 'info', error: 'circle-alert' };

/** Fills the result panel: an icon for its tone, then the lines. */
function showResult(tone: 'success' | 'notice' | 'error', lines: Array<HTMLElement | null>): void {
  const panel = byId('result-panel');
  panel.hidden = false;
  panel.className = `card result ${tone}`;
  panel.replaceChildren(
    el('span', { className: 'result-icon' }, icon(RESULT_ICONS[tone])),
    el('div', { className: 'result-body' }, ...lines.filter((line): line is HTMLElement => line !== null)),
  );
}

function renderResult(result: FinishedSessionInfo): void {
  const counters = result.counters;
  const tone = result.status === 'failed' ? 'error' : result.status === 'completed' ? 'success' : 'notice';
  const children: Array<HTMLElement | null> = [
    el('strong', {}, outcomeText(result.status, result.stopReason)),
    el(
      'div',
      { className: 'small' },
      `${formatNumber(counters.inserted)} new · ${formatNumber(counters.updated)} updated · ${formatNumber(counters.unchanged)} already archived${imageSummary(counters)}`,
    ),
    result.error ? el('div', { className: 'small' }, result.error) : null,
    result.status !== 'completed' && result.mode !== 'visible'
      ? el('div', { className: 'muted small' }, 'Start it again to continue; parts already archived are passed quickly.')
      : null,
    ...result.warnings.slice(0, 3).map((warning) => el('div', { className: 'warning small' }, warning)),
    saveLine(result),
    el('div', { className: 'small result-link' }, archiveLink({ view: 'conversation', key: result.conversationKey }, 'Open this chat in the archive')),
  ];
  showResult(tone, children);
}

/** What became of the file the run was to save, or null when it was to save none. */
function saveLine(result: FinishedSessionInfo): HTMLElement | null {
  if (!result.save) return null;
  const saved = lastSave?.sessionId === result.sessionId ? lastSave : null;
  if (saved?.problem) return el('div', { className: 'warning small' }, saved.problem);
  if (saved) return el('div', { className: 'small' }, saved.fileName ? `Saved ${saved.fileName}.` : 'Opened the print dialog to save a PDF.');
  if (result.savingFile) return el('div', { className: 'small' }, `Saving ${fileNoun(result.save)} in a new tab…`);
  return el('div', { className: 'muted small' }, 'No file was saved, because the capture did not finish. Save a file from the archive only saves what it captured.');
}

async function renderArchive(status: ContentStatus): Promise<void> {
  const conversation = status.conversation;
  resumable = null;
  if (!conversation) {
    setText('arch-summary', '');
    setHidden('arch-note', true);
    setHidden('resume-box', true);
    setHidden('capture-box', false);
    renderCapture({ record: null, conversationKey: null, idle: false });
    return;
  }
  const repo = await repository();
  // The archive entry of this chat, found as an extraction would find it.
  const resolution = await repo.resolveConversation(conversation, status.evidence ?? null);
  const record = resolution.record;
  archivedFrom = record?.oldestSortKey ?? null;
  renderArchiveNote(resolution, conversation.title);
  setText('arch-summary', historyLine(record));
  const coverage = record ? coverageStatus(record.coverage, record.newestSortKey) : 'empty';
  renderCapture({ record, conversationKey: conversation.conversationKey, idle: status.state === 'idle' });

  if (status.state === 'idle' && record) {
    await repo.markStaleSessions(Date.now(), STALE_SESSION_MS);
    resumable = await repo.findResumableSession(record.conversationKey);
  }
  const showResume = status.state === 'idle' && resumable !== null && coverage !== 'complete' && !otherCapture;
  // Resume takes the capture choices' place while it is offered.
  setHidden('resume-box', !showResume);
  setHidden('capture-box', showResume);
  if (showResume && resumable) {
    setText(
      'resume-text',
      `${runSubject(resumable.mode, resumable.captureFrom)} (started ${formatDateTime(resumable.startedAt)}) ended early: ${STOP_REASON_LABELS[resumable.stopReason ?? 'interrupted'].toLowerCase()}. ` +
        `It saw ${formatNumber(resumable.counters.uniqueSeen)} messages (${formatNumber(resumable.counters.inserted)} new)${resumable.counters.oldestSortKey ? `, back to ${formatDate(resumable.counters.oldestSortKey)}` : ''}.` +
        resumePassing(resumable, record),
    );
  }
}

/**
 * For a full-history run whose archive reaches further back than the run got: resuming starts at
 * the newest message again and passes the archived part quickly before it captures older ones.
 */
function resumePassing(session: SessionRecord, record: ConversationRecord | null): string {
  const from = record?.oldestSortKey ?? null;
  if (session.mode !== 'full' || from === null) return '';
  const reached = session.counters.oldestSortKey;
  if (typeof reached === 'number' && reached <= from) return '';
  return ` Resume passes the archived messages back to ${formatDate(from)} quickly, then captures older ones.`;
}

/**
 * Says when the chat is archived under another name, separately, or in more than one entry; for
 * the last, links to the entry in the archive, where Merge… joins them.
 */
function renderArchiveNote(resolution: ConversationResolution, teamsTitle: string | null): void {
  const { record, reason, alsoMatching } = resolution;
  const parts: Array<string | HTMLElement> = [];
  if (reason === 'separate') {
    parts.push('Another archived chat has this title. This chat will be archived separately.');
  } else if (record) {
    const label = conversationLabel(record);
    if (label !== teamsTitle && (record.displayName || reason === 'overlap' || reason === 'alias')) parts.push(`Archived as “${label}”.`);
  }
  if (alsoMatching.length > 0) {
    parts.push(`${parts.length > 0 ? ' ' : ''}Some of these messages are also in ${alsoMatching.length === 1 ? 'another archive entry' : `${alsoMatching.length} other archive entries`}. `);
    parts.push(
      record
        ? archiveLink({ view: 'conversation', key: record.conversationKey }, 'Merge them in the archive')
        : archiveLink({ view: 'home', section: 'conversations' }, 'Merge them in the archive'),
    );
  }
  const note = byId('arch-note');
  note.replaceChildren(...parts);
  note.hidden = parts.length === 0;
}

/** The address of a part of the archive page. */
function archiveUrl(route: Route | null): string {
  return chrome.runtime.getURL(`archive.html${route ? routeHash(route) : ''}`);
}

/** Opens the archive page, at a part of it when given; the popup closes, the side panel stays. */
async function openArchive(route: Route | null): Promise<void> {
  if (route) await chrome.tabs.create({ url: archiveUrl(route) });
  else await chrome.runtime.openOptionsPage();
  if (!isPanel) window.close();
}

function archiveLink(route: Route, text: string): HTMLAnchorElement {
  return el('a', {
    href: archiveUrl(route),
    onclick: (event: Event) => {
      event.preventDefault();
      void openArchive(route);
    },
  }, text);
}

/** Today in the local time zone, as a date field value. */
function todayValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function checkedValue(name: string): string | null {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;
}

function check(name: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

/** The tile chosen; for **Date range**, the period chosen under it. */
function selectedChoice(): PopupChoice {
  const tile = checkedValue('capture') ?? 'everything';
  return (tile === 'range' ? checkedValue('capture-period') ?? 'last-7d' : tile) as PopupChoice;
}

/** The capture button says what it captures, and the file it saves. */
function startLabel(choice: PopupChoice, rangeStart: number | null, save: SaveChoices | null): string {
  const capture = captureText(choice, rangeStart);
  return save ? `${capture} and save ${fileNoun(save)}` : capture;
}

function captureText(choice: PopupChoice, rangeStart: number | null): string {
  switch (choice) {
    case 'update':
      return 'Capture new messages';
    case 'last-24h':
      return 'Capture the last 24 hours';
    case 'last-7d':
      return 'Capture the last 7 days';
    case 'last-30d':
      return 'Capture the last 30 days';
    case 'from-date':
      return rangeStart === null ? 'Capture from a date' : `Capture from ${formatDate(rangeStart)}`;
    case 'everything':
      return 'Capture the full history';
  }
}

/** One sentence under the choices: what the chosen one captures. */
function captureHint(choice: PopupChoice, record: ConversationRecord | null): string {
  const passed = byId<HTMLInputElement>('opt-rescan').checked ? 'parts already archived are read again' : 'parts already archived are passed quickly';
  if (choice === 'update') {
    const since = record?.lastUpdate ? `Since the last update, ${formatAgo(record.lastUpdate.at)}.` : 'Since the newest archived message.';
    const days = settings.updateOverlapDays;
    return `${since} ${days > 0 ? `Also checks the ${days === 1 ? 'day' : `${days} days`} before again, for edits and late replies.` : 'Stops when it meets archived messages.'}`;
  }
  if (choice === 'everything') return `Back to the beginning of the chat; ${passed}.`;
  const plan = capturePlan(choice, Date.now(), byId<HTMLInputElement>('capture-from').value);
  if (!plan || plan.rangeStart === null) return 'Choose the first day to capture.';
  return `From ${formatMoment(plan.rangeStart)} to now; ${passed}.`;
}

/**
 * The messages to capture, the hint, the file to save and the button. The choice is preset once
 * per chat: new messages when something is archived, else the full history.
 */
function renderCapture(next?: { record: ConversationRecord | null; conversationKey: string | null; idle: boolean }): void {
  if (next) Object.assign(captureState, next);
  const { record, conversationKey, idle } = captureState;
  const archived = updateAnchor(record) !== null;
  if (conversationKey !== null && captureState.presetFor !== conversationKey) {
    captureState.presetFor = conversationKey;
    otherCapture = false;
    check('capture', archived ? 'update' : 'everything');
  } else if ((checkedValue('capture') === 'update' && !archived) || checkedValue('capture') === null) {
    check('capture', 'everything');
  }
  for (const input of byId('capture-box').querySelectorAll<HTMLInputElement>('input[name="capture"], input[name="capture-period"]')) {
    input.disabled = !idle || (input.value === 'update' && !archived);
  }
  const dateInput = byId<HTMLInputElement>('capture-from');
  const choice = selectedChoice();
  setHidden('capture-period-box', checkedValue('capture') !== 'range');
  setHidden('capture-from-field', choice !== 'from-date');
  dateInput.disabled = !idle;
  dateInput.max = todayValue();
  const hint = conversationKey === null ? '' : captureHint(choice, record);
  setText('capture-hint', hint);
  setHidden('capture-hint', hint === '');
  const plan = capturePlan(choice, Date.now(), dateInput.value);
  const save = savingChoice();
  byId<HTMLInputElement>('opt-save').disabled = !idle;
  saveForm?.setDisabled(!idle);
  setHidden('save-choices', save === null);
  const start = byId<HTMLButtonElement>('btn-start');
  setText('btn-start-label', startLabel(choice, plan?.rangeStart ?? null, save));
  start.disabled = !idle || busy || conversationKey === null || plan === null;
  // Saving without capturing needs archived messages of this chat.
  const archivedOnly = byId<HTMLButtonElement>('btn-save-archived');
  archivedOnly.hidden = save === null || !record || record.messageCount === 0;
  archivedOnly.disabled = !idle || plan === null;
  byId<HTMLInputElement>('opt-rescan').disabled = !idle;
}

/** The file a capture saves, or null when **Save a file** is off. */
function savingChoice(): SaveChoices | null {
  return byId<HTMLInputElement>('opt-save').checked && saveForm ? saveForm.value : null;
}

/** The checkbox and the file choices, as last used. */
async function loadSaveState(): Promise<void> {
  saveForm?.set(await loadSaveChoices());
  try {
    const stored = await chrome.storage.local.get(SAVE_AFTER_KEY);
    byId<HTMLInputElement>('opt-save').checked = stored[SAVE_AFTER_KEY] !== false;
  } catch {
    byId<HTMLInputElement>('opt-save').checked = true;
  }
  lastSave = await readLastSave();
}

/**
 * Saves a file of what is archived for this chat, without capturing: the period chosen, or
 * everything archived for the other choices. The save page does it in a tab of its own.
 */
async function saveArchived(): Promise<void> {
  const record = captureState.record;
  const save = savingChoice();
  if (!record || !save) return;
  const choice = selectedChoice();
  const plan = choice === 'update' || choice === 'everything' ? null : capturePlan(choice, Date.now(), byId<HTMLInputElement>('capture-from').value);
  const range: TimeRange = { from: plan?.rangeStart ?? null, to: null };
  await chrome.tabs.create({ url: chrome.runtime.getURL(`save.html${saveTargetHash({ kind: 'conversation', conversationKey: record.conversationKey, choices: save, range })}`) });
  if (!isPanel) window.close();
}

function startCapture(): void {
  const choice = selectedChoice();
  const save = savingChoice();
  const plan = capturePlan(choice, Date.now(), byId<HTMLInputElement>('capture-from').value);
  if (plan) void start(plan.mode, byId<HTMLInputElement>('opt-rescan').checked, null, plan.rangeStart, save);
}

async function start(mode: ScrapeMode, rescan: boolean, resumeOf: string | null, rangeStart: number | null, save: SaveChoices | null): Promise<void> {
  busy = true;
  try {
    await sendToTab({ type: 'content/start', mode, rescan, resumeOf, rangeStart, save });
  } catch (error) {
    showResult('error', [el('strong', {}, 'Could not start'), el('div', { className: 'small' }, errorText(error))]);
  } finally {
    busy = false;
    await refresh();
  }
}

async function command(type: 'content/pause' | 'content/resume' | 'content/stop'): Promise<void> {
  try {
    await sendToTab({ type });
  } finally {
    await refresh();
  }
}

function wire(): void {
  placeIcons();
  byId('btn-start').addEventListener('click', startCapture);
  saveForm = new SaveForm(byId('save-choices'), () => renderCapture());
  byId('opt-save').addEventListener('change', () => {
    void chrome.storage.local.set({ [SAVE_AFTER_KEY]: byId<HTMLInputElement>('opt-save').checked }).catch(() => undefined);
  });
  byId('btn-save-archived').addEventListener('click', () => void saveArchived());
  // The save page names the file it saved; the result shows it.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LAST_SAVE_KEY]) lastSave = parseLastSave(changes[LAST_SAVE_KEY].newValue);
  });
  wireThemeButton(byId('btn-theme'));
  for (const id of ['capture-box', 'opt-rescan']) {
    byId(id).addEventListener('change', () => renderCapture());
    byId(id).addEventListener('input', () => renderCapture());
  }
  byId('btn-other-capture').addEventListener('click', () => {
    otherCapture = true;
    setHidden('resume-box', true);
    setHidden('capture-box', false);
    byId('capture-box').querySelector<HTMLInputElement>('input[name="capture"]:checked')?.focus();
  });
  // A resumed run continues what the interrupted one was doing: the same range, the same reading, the same file.
  byId('btn-resume-session').addEventListener('click', () => {
    if (!resumable) return;
    void start(resumable.mode, resumable.rescan, resumable.sessionId, resumable.mode === 'full' ? (resumable.captureFrom ?? null) : null, resumable.save ?? null);
  });
  byId('btn-pause').addEventListener('click', () => void command('content/pause'));
  byId('btn-continue').addEventListener('click', () => void command('content/resume'));
  byId('btn-stop').addEventListener('click', () => void command('content/stop'));
  byId('btn-archive').append(icon('open'));
  byId('btn-panel').append(icon('panel'));
  byId('btn-archive').addEventListener('click', () => void openArchive(null));
  byId('btn-connect').addEventListener('click', async () => {
    if (!tab?.id) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await refresh();
    } catch (error) {
      showView('message', `Could not connect: ${errorText(error)}. Reload the Teams tab instead.`);
    }
  });
  const panelButton = byId('btn-panel');
  if (isPanel) {
    panelButton.hidden = true;
    chrome.tabs.onActivated.addListener(() => checkTab());
    chrome.tabs.onUpdated.addListener((_tabId, change) => {
      if (change.url || change.status === 'complete') checkTab();
    });
  } else {
    panelButton.addEventListener('click', async () => {
      if (tab?.windowId === undefined) return;
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    });
  }
}

/** Checks the active tab and shows what it found, or why it could not (never the loading line forever). */
function checkTab(): void {
  init().catch((error: unknown) => showView('message', `Could not check this tab: ${errorText(error)}. Close this and open it again.`));
}

wire();
checkTab();
