/**
 * Popup / side panel: remote control for the content script in the active Teams tab,
 * plus a summary of what is already archived for the open conversation.
 */
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
  el,
  errorText,
  formatAgo,
  formatDate,
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
import { icon } from './icons';
import { historyLine, routeHash, type Route } from './view-models';

const isPanel = document.body.dataset.mode === 'panel';
let tab: chrome.tabs.Tab | null = null;
let repositoryPromise: Promise<ArchiveRepository> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let resumable: SessionRecord | null = null;
let busy = false;
let settings: ScrapeSettings = { ...DEFAULT_SETTINGS };
/** The re-read option is preset from the settings once; after that it is the user's choice. */
let rescanPreset = false;
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
  setText(
    'conv-meta',
    conversation
      ? `${TYPE_LABELS[conversation.type]}${conversation.threadId ? '' : ' · recognised by its title and messages'}`
      : status.conversationError ?? 'Open a 1:1 or group chat in Teams.',
  );
  // Without a chat id, the messages on screen tell renamed chats and chats with the same title apart.
  const warning = conversation && !conversation.threadId && status.state === 'idle' && status.evidence && status.evidence.messages.length === 0
    ? 'Teams shows no chat id and no message ids here, so this chat is recognised by its title only. Scroll to some messages first.'
    : '';
  setText('conv-warning', warning);
  setHidden('conv-warning', !warning);
  setText(
    'visible-count',
    status.visibleMessages === null ? 'Messages on screen: unknown' : `${formatNumber(status.visibleMessages)} ${status.visibleMessages === 1 ? 'message' : 'messages'} on screen`,
  );

  const idle = status.state === 'idle';
  // Troubleshooting is offered up front only when the extension finds nothing to archive.
  const result = status.lastResult?.counters;
  const runFoundNothing = result !== undefined && result.uniqueSeen + result.inserted + result.updated + result.unchanged === 0;
  const foundNothing = !conversation || (idle && (status.visibleMessages === 0 || runFoundNothing));
  setHidden('troubleshoot-hint', !foundNothing);
  for (const id of ['btn-visible', 'btn-resume-session']) {
    (byId<HTMLButtonElement>(id)).disabled = !idle || !conversation || busy;
  }
  byId<HTMLInputElement>('opt-rescan').disabled = !idle;

  setHidden('run-panel', idle);
  if (!idle) renderProgress(status);
  setHidden('result-panel', !idle || !status.lastResult);
  if (idle && status.lastResult) renderResult(status.lastResult);
}

function renderProgress(status: ContentStatus): void {
  const progress = status.progress;
  const counters = progress?.counters;
  let phase = 'Starting…';
  if (status.state === 'stopping') phase = 'Stopping…';
  else if (status.state === 'paused' || progress?.phase === 'paused') phase = 'Paused';
  else if (progress?.phase === 'waiting-visible') phase = 'Waiting: Teams tab is hidden';
  else if (progress?.phase === 'running') phase = progress.inCoveredRange ? 'Passing archived messages…' : 'Extracting…';
  setText('run-phase', phase);
  setText(
    'run-elapsed',
    status.session ? `${captureLabel(status.session.mode, status.session.captureFrom)} · ${formatDuration(Date.now() - Date.parse(status.session.startedAt))}` : '',
  );
  setText('run-seen', formatNumber(counters?.uniqueSeen ?? 0));
  setText('run-new', formatNumber(counters?.inserted ?? 0));
  setText('run-updated', formatNumber(counters?.updated ?? 0));
  setText('run-unchanged', formatNumber(counters?.unchanged ?? 0));
  setText('run-images', formatNumber(counters?.imagesSaved ?? 0));
  const captureFrom = status.session?.captureFrom;
  const detail = [
    progress?.oldestReached ? `Reached back to ${formatDateTime(progress.oldestReached)}` : '',
    typeof captureFrom === 'number' ? `going back to ${formatMoment(captureFrom)}` : '',
    counters ? `${formatNumber(counters.passes)} scroll steps` : '',
    counters?.gapsDetected ? `${counters.gapsDetected} gap checks` : '',
    counters?.imagesFailed ? `${formatNumber(counters.imagesFailed)} images not saved` : '',
  ].filter(Boolean);
  setText('run-detail', detail.join(' · '));
  const warnings = byId('run-warnings');
  warnings.replaceChildren(...(progress?.warnings ?? []).slice(0, 3).map((w) => el('li', {}, w)));
  warnings.hidden = (progress?.warnings.length ?? 0) === 0;
  const paused = status.state === 'paused';
  setHidden('btn-pause', paused);
  setHidden('btn-continue', !paused);
  byId<HTMLButtonElement>('btn-pause').disabled = status.state !== 'running';
  byId<HTMLButtonElement>('btn-stop').disabled = status.state === 'stopping';
}

/** "· 3 images saved (1 not saved)", or nothing when the run met no images. */
function imageSummary(counters: SessionCounters): string {
  const saved = counters.imagesSaved ?? 0;
  const failed = counters.imagesFailed ?? 0;
  if (saved === 0 && failed === 0) return '';
  return ` · ${formatNumber(saved)} images saved${failed > 0 ? ` (${formatNumber(failed)} not saved)` : ''}`;
}

function renderResult(result: FinishedSessionInfo): void {
  const panel = byId('result-panel');
  const counters = result.counters;
  panel.className = `card ${result.status === 'failed' ? 'error' : result.status === 'completed' ? 'success' : 'notice'}`;
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
  ];
  panel.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
}

async function renderArchive(status: ContentStatus): Promise<void> {
  const conversation = status.conversation;
  resumable = null;
  if (!conversation) {
    setText('arch-summary', '');
    setHidden('arch-note', true);
    setHidden('resume-box', true);
    byId('btn-start').classList.add('primary');
    renderCapture({ record: null, conversationKey: null, idle: false });
    return;
  }
  const repo = await repository();
  // The archive entry of this chat, found as an extraction would find it.
  const resolution = await repo.resolveConversation(conversation, status.evidence ?? null);
  const record = resolution.record;
  renderArchiveNote(resolution, conversation.title);
  setText('arch-summary', historyLine(record));
  const coverage = record ? coverageStatus(record.coverage, record.newestSortKey) : 'empty';
  renderCapture({ record, conversationKey: conversation.conversationKey, idle: status.state === 'idle' });

  if (status.state === 'idle' && record) {
    await repo.markStaleSessions(Date.now(), STALE_SESSION_MS);
    resumable = await repo.findResumableSession(record.conversationKey);
  }
  const showResume = status.state === 'idle' && resumable !== null && coverage !== 'complete';
  setHidden('resume-box', !showResume);
  // Resume takes the primary place while it is offered.
  byId('btn-start').classList.toggle('primary', !showResume);
  if (showResume && resumable) {
    setText(
      'resume-text',
      `${runSubject(resumable.mode, resumable.captureFrom)} (started ${formatDateTime(resumable.startedAt)}) ended early: ${STOP_REASON_LABELS[resumable.stopReason ?? 'interrupted'].toLowerCase()}. ` +
        `It captured ${formatNumber(resumable.counters.uniqueSeen)} messages${resumable.counters.oldestSortKey ? `, back to ${formatDate(resumable.counters.oldestSortKey)}` : ''}.`,
    );
  }
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
        : archiveLink({ view: 'conversations' }, 'Merge them in the archive'),
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

function troubleshootingRoute(): Route {
  return { view: 'settings', section: 'troubleshooting', tabId: tab?.id ?? null };
}

/** Today in the local time zone, as a date field value. */
function todayValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function selectedChoice(): CaptureChoice {
  return byId<HTMLSelectElement>('capture-choice').value as CaptureChoice;
}

function captureHint(choice: CaptureChoice, record: ConversationRecord | null): string {
  const passed = byId<HTMLInputElement>('opt-rescan').checked ? 'Parts already archived are read again.' : 'Parts already archived are passed quickly.';
  if (choice === 'update') {
    const days = settings.updateOverlapDays;
    const since = record?.lastUpdate ? `since the last update (${formatDateTime(record.lastUpdate.at)})` : 'newer than the archive';
    const recheck = days > 0 ? `, and checks the ${days === 1 ? 'day' : `${days} days`} before again for edits and late replies` : ', until it meets archived messages';
    return `Captures the messages ${since}${recheck}.`;
  }
  if (choice === 'everything') return `Captures the whole history, back to the beginning of the chat. ${passed}`;
  const plan = capturePlan(choice, Date.now(), byId<HTMLInputElement>('capture-from').value);
  if (!plan || plan.rangeStart === null) return 'Choose the first day to capture.';
  return `Captures the messages from ${formatMoment(plan.rangeStart)} to now. ${passed}`;
}

/**
 * The capture choice, its hint and the Start button. The choice is preset once per chat: new
 * messages when something is archived, else the full history.
 */
function renderCapture(next?: { record: ConversationRecord | null; conversationKey: string | null; idle: boolean }): void {
  if (next) Object.assign(captureState, next);
  const { record, conversationKey, idle } = captureState;
  const select = byId<HTMLSelectElement>('capture-choice');
  const updateOption = select.querySelector<HTMLOptionElement>('option[value="update"]');
  const archived = updateAnchor(record) !== null;
  if (updateOption) {
    updateOption.disabled = !archived;
    updateOption.textContent = record?.lastUpdate ? `New messages since the last update (${formatAgo(record.lastUpdate.at)})` : 'New messages since the newest archived one';
  }
  if (conversationKey !== null && captureState.presetFor !== conversationKey) {
    captureState.presetFor = conversationKey;
    select.value = archived ? 'update' : 'everything';
  } else if (select.value === 'update' && !archived) {
    select.value = 'everything';
  }
  select.disabled = !idle;
  const dateInput = byId<HTMLInputElement>('capture-from');
  setHidden('capture-from-field', select.value !== 'from-date');
  dateInput.disabled = !idle;
  dateInput.max = todayValue();
  const choice = selectedChoice();
  setText('capture-hint', conversationKey === null ? '' : captureHint(choice, record));
  const plan = capturePlan(choice, Date.now(), dateInput.value);
  byId<HTMLButtonElement>('btn-start').disabled = !idle || busy || conversationKey === null || plan === null;
}

function startCapture(): void {
  const plan = capturePlan(selectedChoice(), Date.now(), byId<HTMLInputElement>('capture-from').value);
  if (plan) void start(plan.mode, byId<HTMLInputElement>('opt-rescan').checked, null, plan.rangeStart);
}

async function start(mode: ScrapeMode, rescan: boolean, resumeOf: string | null, rangeStart: number | null = null): Promise<void> {
  busy = true;
  try {
    await sendToTab({ type: 'content/start', mode, rescan, resumeOf, rangeStart });
  } catch (error) {
    const panel = byId('result-panel');
    panel.hidden = false;
    panel.className = 'card error';
    panel.replaceChildren(el('strong', {}, 'Could not start'), el('div', { className: 'small' }, errorText(error)));
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
  byId('btn-start').addEventListener('click', startCapture);
  byId('btn-visible').addEventListener('click', () => void start('visible', false, null));
  for (const id of ['capture-choice', 'capture-from', 'opt-rescan']) {
    byId(id).addEventListener('change', () => renderCapture());
    byId(id).addEventListener('input', () => renderCapture());
  }
  // A resumed run continues what the interrupted one was doing: the same range, the same reading.
  byId('btn-resume-session').addEventListener('click', () => {
    if (!resumable) return;
    void start(resumable.mode, resumable.rescan, resumable.sessionId, resumable.mode === 'full' ? (resumable.captureFrom ?? null) : null);
  });
  byId('btn-pause').addEventListener('click', () => void command('content/pause'));
  byId('btn-continue').addEventListener('click', () => void command('content/resume'));
  byId('btn-stop').addEventListener('click', () => void command('content/stop'));
  byId('btn-archive').append(icon('open'));
  byId('btn-panel').append(icon('panel'));
  byId('btn-archive').addEventListener('click', () => void openArchive(null));
  // Diagnostics lives in the archive's Settings, for the Teams tab this popup was opened on.
  for (const id of ['link-troubleshoot', 'link-troubleshoot-hint']) {
    byId(id).addEventListener('click', (event) => {
      event.preventDefault();
      void openArchive(troubleshootingRoute());
    });
  }
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
