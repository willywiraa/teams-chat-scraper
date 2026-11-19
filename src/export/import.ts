/** Restores (merges) an exported archive into the repository. Safe to run repeatedly. */
import type { ArchiveRepository, ImportResult } from '../storage/repository';
import { parseArchiveExport } from './format';

export interface ArchiveImportSummary extends ImportResult {
  conversations: number;
}

export async function importArchive(repository: ArchiveRepository, input: string | unknown): Promise<ArchiveImportSummary> {
  const archive = parseArchiveExport(input);
  const summary: ArchiveImportSummary = { conversations: 0, inserted: 0, updated: 0, unchanged: 0 };
  for (const conversation of archive.conversations) {
    const { messages, ...record } = conversation;
    const result = await repository.importConversation(record, messages);
    summary.conversations++;
    summary.inserted += result.inserted;
    summary.updated += result.updated;
    summary.unchanged += result.unchanged;
  }
  return summary;
}
