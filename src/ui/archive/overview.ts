/** The Overview section: totals, storage used, the last full backup, the chats archived most recently, and recent runs. */
import { STALE_SESSION_MS } from '../../shared/protocol';
import { conversationLabel, type SessionCounters } from '../../shared/types';
import { byId, captureLabel, el, formatDateTime, formatDuration, formatNumber, STATUS_LABELS, STOP_REASON_LABELS } from '../common';
import { readLastBackup } from '../last-backup';
import { backupLine, historyLine, latestActivity, overviewTotals, routeHash } from '../view-models';
import type { AppContext } from './context';

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

export async function renderOverview(app: AppContext): Promise<void> {
  const repo = await app.repository();
  const records = await repo.listConversations();
  const imageCounts = await Promise.all(records.map((record) => repo.countImages(record.conversationKey)));
  const totals = overviewTotals(records, imageCounts);
  const storage = await storageUsed();
  byId('overview-stats').replaceChildren(
    stat('Conversations', formatNumber(totals.conversations)),
    stat('Messages', formatNumber(totals.messages)),
    stat('Saved images', formatNumber(totals.images)),
    stat('Complete histories', `${formatNumber(totals.complete)} of ${formatNumber(totals.conversations)}`),
    stat('Storage used', storage?.used ?? '–'),
  );
  byId('backup-status').textContent = backupLine(await readLastBackup(), totals.conversations);
  byId<HTMLButtonElement>('btn-backup-now').disabled = totals.conversations === 0;
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

export async function renderSessions(app: AppContext): Promise<void> {
  const repo = await app.repository();
  await repo.markStaleSessions(Date.now(), STALE_SESSION_MS);
  const sessions = await repo.listSessions({ limit: 50 });
  byId('sessions').querySelector('tbody')!.replaceChildren(
    ...sessions.map((session) => {
      const end = session.endedAt ?? session.updatedAt;
      return el(
        'tr',
        {},
        el('td', { 'data-label': 'Started' }, formatDateTime(session.startedAt)),
        el('td', { 'data-label': 'Conversation' }, session.conversationTitle ?? session.conversationKey),
        el('td', { 'data-label': 'Mode' }, `${captureLabel(session.mode, session.captureFrom)}${session.rescan ? ' (re-read)' : ''}${session.resumeOf ? ' (resumed)' : ''}`),
        el('td', { 'data-label': 'Status' }, STATUS_LABELS[session.status]),
        el(
          'td',
          { className: 'small', 'data-label': 'Result' },
          el('div', {}, session.stopReason ? STOP_REASON_LABELS[session.stopReason] : '', session.error ? el('div', { className: 'error-text' }, session.error) : null),
        ),
        el('td', { className: 'num', 'data-label': 'New' }, formatNumber(session.counters.inserted)),
        el('td', { className: 'num', 'data-label': 'Updated' }, formatNumber(session.counters.updated)),
        el('td', { className: 'num', 'data-label': 'Already archived' }, formatNumber(session.counters.unchanged)),
        el('td', { className: 'num', 'data-label': 'Images' }, imagesCell(session.counters)),
        el('td', { 'data-label': 'Duration' }, formatDuration(Date.parse(end) - Date.parse(session.startedAt))),
      );
    }),
  );
  byId('sessions').hidden = sessions.length === 0;
  byId('no-sessions').hidden = sessions.length > 0;
}

/** Saved images, plus failures; sessions recorded before version 1.1 have no image counters. */
function imagesCell(counters: Partial<SessionCounters>): string {
  if (counters.imagesSaved === undefined) return '–';
  const failed = counters.imagesFailed ?? 0;
  return failed > 0 ? `${formatNumber(counters.imagesSaved)} (${formatNumber(failed)} not saved)` : formatNumber(counters.imagesSaved);
}
