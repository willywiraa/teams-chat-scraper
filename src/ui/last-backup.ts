/**
 * When the last full backup was made from this browser profile, kept in chrome.storage.local
 * (`lastBackup.v1`) so Overview can say whether the archive is safe. Written by the Export
 * section when an export that `isFullBackup` accepts has been downloaded.
 */
import type { LastBackup } from './view-models';

export const LAST_BACKUP_KEY = 'lastBackup.v1';

/** The stored record, or null when there is none or it is not readable. */
export function parseLastBackup(value: unknown): LastBackup | null {
  if (typeof value !== 'object' || value === null) return null;
  const { at, conversations, messages } = value as Record<string, unknown>;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  const count = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null);
  const c = count(conversations);
  const m = count(messages);
  return c === null || m === null ? null : { at, conversations: c, messages: m };
}

export async function readLastBackup(): Promise<LastBackup | null> {
  try {
    const stored = await chrome.storage.local.get(LAST_BACKUP_KEY);
    return parseLastBackup(stored[LAST_BACKUP_KEY]);
  } catch {
    return null;
  }
}

export async function recordBackup(backup: LastBackup): Promise<void> {
  await chrome.storage.local.set({ [LAST_BACKUP_KEY]: backup });
}
