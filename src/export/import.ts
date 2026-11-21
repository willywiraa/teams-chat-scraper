/** Restores (merges) an exported archive into the repository. Safe to run repeatedly. */
import { identityEvidence } from '../extractor/page-parser';
import { newId as randomId } from '../shared/ids';
import { decodeImagePayload } from '../shared/images';
import type { ConversationIdentity, ConversationRecord, StoredImage, StoredMessage } from '../shared/types';
import { rekeyImage, rekeyMessage, withConversationAliases } from '../storage/conversation-identity';
import { toStoredImage } from '../storage/images';
import { normalizeStoredMessage } from '../storage/merge';
import type { ArchiveRepository, ImportResult } from '../storage/repository';
import { ImportValidationError, parseArchiveExport } from './format';

export interface ArchiveImportSummary extends ImportResult {
  conversations: number;
  /** Saved images added to the archive. */
  imagesInserted: number;
  /** Saved images that were already in the archive. */
  imagesUnchanged: number;
  /**
   * Imported conversations added to an archive entry with another key: the chat was renamed, or
   * its entry was merged into another one (for example in a backup made before the merge).
   */
  joinedExisting: number;
  /** Imported conversations given an entry of their own: the entry with their key holds another chat. */
  keptSeparate: number;
}

export interface ImportOptions {
  /** Makes the key of an entry of its own (`local:<id>`). */
  newId?: () => string;
}

/** The chat an exported entry was archived from, as the resolver sees an open chat. */
function identityOf(record: ConversationRecord): ConversationIdentity {
  return {
    conversationKey: record.conversationKey,
    threadId: record.threadId ?? null,
    title: record.title ?? null,
    type: record.type ?? 'unknown',
    keySource: record.keySource ?? 'title',
    typeSource: record.typeSource ?? 'unknown',
  };
}

export async function importArchive(repository: ArchiveRepository, input: string | unknown, options: ImportOptions = {}): Promise<ArchiveImportSummary> {
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

  const summary: ArchiveImportSummary = { conversations: 0, inserted: 0, updated: 0, unchanged: 0, imagesInserted: 0, imagesUnchanged: 0, joinedExisting: 0, keptSeparate: 0 };
  for (const [ci, conversation] of archive.conversations.entries()) {
    const { messages, images: _images, ...record } = conversation;
    let images = imagesByConversation[ci] ?? [];
    let entry: ConversationRecord = record;
    let entryMessages: StoredMessage[] = messages;

    // The entry goes where the same chat is archived here, found the way an open chat is found.
    const incomingKey = record.conversationKey;
    const resolution = await repository.resolveConversation(identityOf(record), identityEvidence(messages));
    const key = resolution.conversationKey ?? `local:${(options.newId ?? randomId)()}`;
    if (key !== incomingKey) {
      entry = { ...record, conversationKey: key, aliases: withConversationAliases({ conversationKey: key, aliases: record.aliases }, [incomingKey]) };
      entryMessages = messages.map((message) => rekeyMessage(normalizeStoredMessage(message), incomingKey, key));
      images = images.map((image) => rekeyImage(image, key));
      if (resolution.conversationKey) summary.joinedExisting++;
      else summary.keptSeparate++;
    }

    // Images first: imported messages may refer to them.
    const statuses = await repository.putImages(key, images);
    for (const status of Object.values(statuses)) {
      if (status === 'inserted') summary.imagesInserted++;
      else summary.imagesUnchanged++;
    }
    const result = await repository.importConversation(entry, entryMessages);
    summary.conversations++;
    summary.inserted += result.inserted;
    summary.updated += result.updated;
    summary.unchanged += result.unchanged;
  }
  return summary;
}
