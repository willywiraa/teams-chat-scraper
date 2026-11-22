/** The Overview section: the last full backup and what the archive holds, the chats archived most recently, and recent runs. */
import { STALE_SESSION_MS } from '../../shared/protocol';
import { conversationLabel, type SessionCounters } from '../../shared/types';
import { byId, captureLabel, countOf, el, formatDateTime, formatDuration, formatNumber, STATUS_LABELS, STOP_REASON_LABELS } from '../common';
import { readLastBackup } from '../last-backup';
import { backupLine, historyLine, latestActivity, overviewTotals, routeHash } from '../view-models';
import type { AppContext } from './context';

/** Runs shown before **Show all runs**. */
const LATEST_RUNS = 5;
/** True once **Show all runs** was clicked. */
let allRuns = false;

/** "12.3 MB", or null when the browser doesn't say. */
export async function storageUsed(): Promise<{ used: string; quota: string } | null> {
  try {
    const estimate = await navigator.storage.estimate();
    const mb = (bytes: number | undefined) => `${((bytes ?? 0) / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
    return { used: mb(estimate.usage), quota: mb(estimate.quota) };
  } catch {
    return null;
  }
}

function stat(label: string, value: string): HTMLDivElement {
  return el('div', {}, el('dt', {}, label), el('dd', {}, value));
}

export function wireOverview(app: AppContext): void {
  byId('btn-all-runs').addEventListener('click', () => {
    allRuns = !allRuns;
    void renderSessions(app);
  });
}

export async function renderOverview(app: AppContext): Promise<void> {
  const repo = await app.repository();
  const records = await repo.listConversations();
  const imageCounts = await Promise.all(records.map((record) => repo.countImages(record.conversationKey)));
  const totals = overviewTotals(records, imageCounts);
  byId('backup-status').textContent = backupLine(await readLastBackup(), totals.conversations);
  byId<HTMLButtonElement>('btn-backup-now').disabled = totals.conversations === 0;
  byId('overview-stats').replaceChildren(
    stat('Conversations', formatNumber(totals.conversations)),
    stat('Messages', formatNumber(totals.messages)),
    stat('Saved images', formatNumber(totals.images)),
    stat('Complete histories', `${formatNumber(totals.complete)} of ${formatNumber(totals.conversations)}`),
  );
  const latest = latestActivity(records);
  byId('activity').replaceChildren(
    ...latest.map((record) =>
      el(
        'li',
        {},
        el('a', { className: 'conv-title', href: routeHash({ view: 'conversation', key: record.conversationKey }) }, conversationLabel(record)),
        el('span', { className: 'muted small' }, historyLine(record)),
      ),
    ),
  );
  byId('activity').hidden = latest.length === 0;
  byId('no-activity').hidden = latest.length > 0;
  await renderSessions(app);
}

/** "450 new · 0 updated · 12 already archived · 3 images saved"; runs from before version 1.1 have no image counts. */
function resultCounts(counters: Partial<SessionCounters>): string {
  const parts = [`${formatNumber(counters.inserted ?? 0)} new`, `${formatNumber(counters.updated ?? 0)} updated`, `${formatNumber(counters.unchanged ?? 0)} already archived`];
  if (counters.imagesSaved) parts.push(`${countOf(counters.imagesSaved, 'image')} saved`);
  if (counters.imagesFailed) parts.push(`${countOf(counters.imagesFailed, 'image')} not saved`);
  return parts.join(' · ');
}

export async function renderSessions(app: AppContext): Promise<void> {
  const repo = await app.repository();
  await repo.markStaleSessions(Date.now(), STALE_SESSION_MS);
  const sessions = await repo.listSessions({ limit: 50 });
  const shown = allRuns ? sessions : sessions.slice(0, LATEST_RUNS);
  byId('sessions').querySelector('tbody')!.replaceChildren(
    ...shown.map((session) => {
      const end = session.endedAt ?? session.updatedAt;
      const started = formatDateTime(session.startedAt);
      const capture = `${captureLabel(session.mode, session.captureFrom)}${session.rescan ? ' (re-read)' : ''}${session.resumeOf ? ' (resumed)' : ''}`;
      const status = STATUS_LABELS[session.status];
      const duration = formatDuration(Date.parse(end) - Date.parse(session.startedAt));
      const counts = resultCounts(session.counters);
      const reason = session.stopReason ? STOP_REASON_LABELS[session.stopReason] : '';
      const result = (where: 'narrow' | 'wide') => [
        el('div', { className: where === 'narrow' ? 'narrow-only small' : '' }, counts),
        reason ? el('div', { className: `muted small${where === 'narrow' ? ' narrow-only' : ''}` }, reason) : null,
        session.error ? el('div', { className: `error-text small${where === 'narrow' ? ' narrow-only' : ''}` }, session.error) : null,
      ];
      return el(
        'tr',
        {},
        el('td', { className: 'wide-only' }, started),
        // In a narrow window the row is a card: the chat, then the run on one line, then its result.
        el(
          'td',
          {},
          el('div', { className: 'run-title' }, session.conversationTitle ?? session.conversationKey),
          el('div', { className: 'narrow-only muted small' }, [started, capture, status, duration].join(' · ')),
          ...result('narrow'),
        ),
        el('td', { className: 'wide-only' }, capture),
        el('td', { className: 'wide-only' }, status),
        el('td', { className: 'wide-only' }, ...result('wide')),
        el('td', { className: 'wide-only' }, duration),
      );
    }),
  );
  byId('sessions').hidden = sessions.length === 0;
  byId('no-sessions').hidden = sessions.length > 0;
  const more = byId<HTMLButtonElement>('btn-all-runs');
  more.hidden = sessions.length <= LATEST_RUNS;
  more.textContent = allRuns ? `Show the latest ${LATEST_RUNS} runs` : `Show all runs (${formatNumber(sessions.length)})`;
}
