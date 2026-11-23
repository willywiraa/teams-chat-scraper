/**
 * Backup and import: when the last full backup was made, **Back up now** (a ZIP package of every
 * chat with everything, saved by the save page in a new tab), **Import archive…** and the
 * archive's totals.
 */
import { FULL_CONTENT, saveTargetHash } from '../../export/options';
import { byId, el, formatNumber } from '../common';
import { readLastBackup } from '../last-backup';
import { archiveTotals, backupLine } from '../view-models';
import type { AppContext } from './context';

/** "12.3 MB", or null when the browser doesn't say. */
async function storageUsed(): Promise<string | null> {
  try {
    const estimate = await navigator.storage.estimate();
    return `${((estimate.usage ?? 0) / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  } catch {
    return null;
  }
}

function stat(label: string, value: string): HTMLDivElement {
  return el('div', {}, el('dt', {}, label), el('dd', {}, value));
}

export function wireBackup(app: AppContext): void {
  byId('btn-backup-now').addEventListener('click', () => {
    const url = chrome.runtime.getURL(`save.html${saveTargetHash({ kind: 'all', choices: { format: 'package', content: { ...FULL_CONTENT } } })}`);
    chrome.tabs.create({ url }).catch((error: unknown) => app.notify(error instanceof Error ? error.message : String(error), 'error'));
  });
}

export async function renderBackup(app: AppContext): Promise<void> {
  const repo = await app.repository();
  const records = await repo.listConversations();
  const imageCounts = await Promise.all(records.map((record) => repo.countImages(record.conversationKey)));
  const totals = archiveTotals(records, imageCounts);
  byId('backup-status').textContent = backupLine(await readLastBackup(), totals.conversations);
  byId<HTMLButtonElement>('btn-backup-now').disabled = totals.messages === 0;
  const used = await storageUsed();
  byId('archive-stats').replaceChildren(
    stat('Conversations', formatNumber(totals.conversations)),
    stat('Messages', formatNumber(totals.messages)),
    stat('Saved images', formatNumber(totals.images)),
    stat('Complete histories', `${formatNumber(totals.complete)} of ${formatNumber(totals.conversations)}`),
    stat('Space used', used ?? '–'),
  );
}
