/**
 * Popup / side panel: remote control for the content script in the active Teams tab,
 * plus a summary of what is already archived for the open conversation.
 */
import type { DiagnosticsReport } from '../extractor/diagnostics';
import {
  STALE_SESSION_MS,
  TEAMS_URL_PATTERN,
  type ContentCommand,
  type ContentStatus,
  type FinishedSessionInfo,
  type Response,
} from '../shared/protocol';
import type { ScrapeMode, SessionCounters, SessionRecord } from '../shared/types';
import { coverageStatus } from '../storage/coverage';
import { ArchiveRepository } from '../storage/repository';
import {
  byId,
  el,
  errorText,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  MODE_LABELS,
  setHidden,
  setText,
  STOP_REASON_LABELS,
  TYPE_LABELS,
} from './common';

const isPanel = document.body.dataset.mode === 'panel';
let tab: chrome.tabs.Tab | null = null;
let repositoryPromise: Promise<ArchiveRepository> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let resumable: SessionRecord | null = null;
let busy = false;
let diagnosticsText = '';

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
      ? `${TYPE_LABELS[conversation.type]}${conversation.threadId ? '' : ' · identified by title'}`
      : status.conversationError ?? 'Open a 1:1 or group chat in Teams.',
  );
  const warning = conversation && !conversation.threadId
    ? 'The Teams chat id was not found, so this chat is archived under its title. Renaming the chat starts a new archive entry.'
    : '';
  setText('conv-warning', warning);
  setHidden('conv-warning', !warning);
  setText('visible-count', status.visibleMessages === null ? '–' : formatNumber(status.visibleMessages));

  const idle = status.state === 'idle';
  for (const id of ['btn-full', 'btn-update', 'btn-visible', 'btn-resume-session']) {
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
    status.session ? `${MODE_LABELS[status.session.mode]} · ${formatDuration(Date.now() - Date.parse(status.session.startedAt))}` : '',
  );
  setText('run-seen', formatNumber(counters?.uniqueSeen ?? 0));
  setText('run-new', formatNumber(counters?.inserted ?? 0));
  setText('run-updated', formatNumber(counters?.updated ?? 0));
  setText('run-unchanged', formatNumber(counters?.unchanged ?? 0));
  setText('run-images', formatNumber(counters?.imagesSaved ?? 0));
  const detail = [
    progress?.oldestReached ? `Reached back to ${formatDateTime(progress.oldestReached)}` : '',
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
  const title = result.status === 'completed' ? 'Done' : result.status === 'failed' ? 'Failed' : 'Stopped';
  panel.className = `card ${result.status === 'failed' ? 'error' : result.status === 'completed' ? 'success' : 'notice'}`;
  const children: Array<HTMLElement | null> = [
    el('strong', {}, `${title}: ${STOP_REASON_LABELS[result.stopReason]}`),
    el(
      'div',
      { className: 'small' },
      `${formatNumber(counters.inserted)} new · ${formatNumber(counters.updated)} updated · ${formatNumber(counters.unchanged)} already archived${imageSummary(counters)}`,
    ),
    result.error ? el('div', { className: 'small' }, result.error) : null,
    result.status !== 'completed' && result.mode === 'full'
      ? el('div', { className: 'muted small' }, 'Start “Full history” again to continue; archived parts are skipped quickly.')
      : null,
    ...result.warnings.slice(0, 3).map((warning) => el('div', { className: 'warning small' }, warning)),
  ];
  panel.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
}

async function renderArchive(status: ContentStatus): Promise<void> {
  const conversation = status.conversation;
  resumable = null;
  if (!conversation) {
    setText('arch-count', '–');
    setText('arch-coverage', '–');
    setText('arch-range', '');
    setHidden('resume-box', true);
    return;
  }
  const repo = await repository();
  const record = await repo.getConversation(conversation.conversationKey);
  setText('arch-count', formatNumber(record?.messageCount ?? 0));
  const coverage = record ? coverageStatus(record.coverage, record.newestSortKey) : 'empty';
  setText('arch-coverage', coverage === 'complete' ? 'Complete' : coverage === 'partial' ? 'Partial' : 'Not archived');
  setText(
    'arch-range',
    record && record.oldestSortKey !== null
      ? `Archived ${formatDate(record.oldestSortKey)} – ${formatDate(record.newestSortKey)} · last run ${formatDateTime(record.lastExtractedAt)}`
      : '',
  );

  if (status.state === 'idle') {
    await repo.markStaleSessions(Date.now(), STALE_SESSION_MS);
    resumable = await repo.findResumableSession(conversation.conversationKey);
  }
  const showResume = status.state === 'idle' && resumable !== null && coverage !== 'complete';
  setHidden('resume-box', !showResume);
  if (showResume && resumable) {
    setText(
      'resume-text',
      `The last ${MODE_LABELS[resumable.mode].toLowerCase()} run (${formatDateTime(resumable.startedAt)}) ended early: ${STOP_REASON_LABELS[resumable.stopReason ?? 'interrupted'].toLowerCase()}. ` +
        `It captured ${formatNumber(resumable.counters.uniqueSeen)} messages${resumable.counters.oldestSortKey ? `, back to ${formatDate(resumable.counters.oldestSortKey)}` : ''}.`,
    );
  }
}

async function start(mode: ScrapeMode, rescan: boolean, resumeOf: string | null): Promise<void> {
  busy = true;
  try {
    await sendToTab({ type: 'content/start', mode, rescan, resumeOf });
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

function summarizeDiagnostics(report: DiagnosticsReport): string {
  const p = report.parse;
  const parts = [
    report.messageList.found ? 'message list found' : 'message list NOT found',
    report.conversation.detected ? `chat detected (${report.conversation.hasThreadId ? 'by id' : 'by title'})` : 'chat NOT detected',
    `${p.messages} messages parsed (${p.withMessageId} with id, ${p.senderExplicit + p.senderSelf + p.senderInferred} with sender)`,
  ];
  return parts.join(' · ');
}

async function runDiagnosticsClick(): Promise<void> {
  const output = byId('diag-output');
  try {
    const report = await sendToTab<DiagnosticsReport>({ type: 'content/diagnostics' });
    diagnosticsText = JSON.stringify(report, null, 2);
    setText('diag-summary', summarizeDiagnostics(report) + (report.warnings.length ? ` · ${report.warnings.join(' ')}` : ''));
    output.textContent = diagnosticsText;
  } catch (error) {
    diagnosticsText = '';
    setText('diag-summary', `Diagnostics failed: ${errorText(error)}`);
    output.textContent = '';
  }
  setHidden('diag-summary', false);
  output.hidden = diagnosticsText === '';
  setHidden('btn-diag-copy', diagnosticsText === '');
}

function wire(): void {
  byId('btn-full').addEventListener('click', () => void start('full', byId<HTMLInputElement>('opt-rescan').checked, null));
  byId('btn-update').addEventListener('click', () => void start('incremental', false, null));
  byId('btn-visible').addEventListener('click', () => void start('visible', false, null));
  byId('btn-resume-session').addEventListener('click', () => void start('full', false, resumable?.sessionId ?? null));
  byId('btn-pause').addEventListener('click', () => void command('content/pause'));
  byId('btn-continue').addEventListener('click', () => void command('content/resume'));
  byId('btn-stop').addEventListener('click', () => void command('content/stop'));
  byId('btn-diag').addEventListener('click', () => void runDiagnosticsClick());
  byId('btn-diag-copy').addEventListener('click', () => void navigator.clipboard.writeText(diagnosticsText));
  byId('btn-archive').addEventListener('click', () => void chrome.runtime.openOptionsPage());
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
    chrome.tabs.onActivated.addListener(() => void init());
    chrome.tabs.onUpdated.addListener((_tabId, change) => {
      if (change.url || change.status === 'complete') void init();
    });
  } else {
    panelButton.addEventListener('click', async () => {
      if (tab?.windowId === undefined) return;
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    });
  }
}

wire();
void init();
