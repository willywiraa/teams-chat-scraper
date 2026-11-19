/** Restores (merges) an exported archive into the repository. Safe to run repeatedly. */
import { decodeImagePayload } from '../shared/images';
import type { StoredImage } from '../shared/types';
import { toStoredImage } from '../storage/images';
import type { ArchiveRepository, ImportResult } from '../storage/repository';
import { ImportValidationError, parseArchiveExport } from './format';

export interface ArchiveImportSummary extends ImportResult {
  conversations: number;
  /** Saved images added to the archive. */
  imagesInserted: number;
  /** Saved images that were already in the archive. */
  imagesUnchanged: number;
}

export async function importArchive(repository: ArchiveRepository, input: string | unknown): Promise<ArchiveImportSummary> {
  const archive = parseArchiveExport(input);
  // Decode and verify every image before writing anything, so a damaged file changes nothing.
  const imagesByConversation: StoredImage[][] = [];
  for (const [ci, conversation] of archive.conversations.entries()) {
    const records: StoredImage[] = [];
    for (const [ii, image] of (conversation.images ?? []).entries()) {
      const decoded = await decodeImagePayload(image);
      if (!decoded.ok) throw new ImportValidationError(`conversations[${ci}].images[${ii}]: ${decoded.error}`);
      records.push(
        toStoredImage(conversation.conversationKey, image, decoded.bytes, {
          sessionId: image.sessionId ?? null,
          nowIso: typeof image.firstSavedAt === 'string' ? image.firstSavedAt : archive.exportedAt,
        }),
      );
    }
    imagesByConversation.push(records);
  }

  const summary: ArchiveImportSummary = { conversations: 0, inserted: 0, updated: 0, unchanged: 0, imagesInserted: 0, imagesUnchanged: 0 };
  for (const [ci, conversation] of archive.conversations.entries()) {
    const { messages, images: _images, ...record } = conversation;
    // Images first: imported messages may refer to them.
    const statuses = await repository.putImages(record.conversationKey, imagesByConversation[ci] ?? []);
    for (const status of Object.values(statuses)) {
      if (status === 'inserted') summary.imagesInserted++;
      else summary.imagesUnchanged++;
    }
    const result = await repository.importConversation(record, messages);
    summary.conversations++;
    summary.inserted += result.inserted;
    summary.updated += result.updated;
    summary.unchanged += result.unchanged;
  }
  return summary;
}
