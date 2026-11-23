/**
 * What the save page did for the last capture that saved a file, kept in chrome.storage.local
 * (`lastSave.v1`) so the popup's result can name the file.
 */
export const LAST_SAVE_KEY = 'lastSave.v1';

export interface LastSave {
  /** The capture the file was saved for. */
  sessionId: string;
  /** The file downloaded; null for a PDF (named in the print dialog) or when nothing was saved. */
  fileName: string | null;
  /** Why nothing was saved, or null. */
  problem: string | null;
}

/** The stored record, or null when there is none or it is not readable. */
export function parseLastSave(value: unknown): LastSave | null {
  if (typeof value !== 'object' || value === null) return null;
  const { sessionId, fileName, problem } = value as Record<string, unknown>;
  if (typeof sessionId !== 'string') return null;
  return {
    sessionId,
    fileName: typeof fileName === 'string' ? fileName : null,
    problem: typeof problem === 'string' ? problem : null,
  };
}

export async function readLastSave(): Promise<LastSave | null> {
  try {
    const stored = await chrome.storage.local.get(LAST_SAVE_KEY);
    return parseLastSave(stored[LAST_SAVE_KEY]);
  } catch {
    return null;
  }
}

export async function recordLastSave(save: LastSave): Promise<void> {
  await chrome.storage.local.set({ [LAST_SAVE_KEY]: save });
}
