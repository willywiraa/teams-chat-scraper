/**
 * Fingerprints identify messages without a Teams message id. The page parser computes them from
 * what is rendered; merging two archive entries recomputes them under the key of the entry the
 * messages move to, so later extractions still recognise those messages.
 */
import { hashParts, normalizeForHash } from './hash';
import type { Attachment, MessageKind, StoredMessage, TimestampSource } from './types';

/** Timestamps read from the page with full precision; only these make a fingerprint strong. */
export const STRONG_TIMESTAMP_SOURCES: ReadonlySet<TimestampSource> = new Set(['datetime-attr', 'title-attr', 'aria-label']);

export interface FingerprintParts {
  kind: MessageKind;
  isSelf: boolean;
  /** ISO time of an exact timestamp, else null. */
  strongTime: string | null;
  /** Message text, normalised with normalizeForHash. */
  normalizedText: string;
  /** attachmentSignature() of the attachments. */
  attachments: string;
  replyPreview: string | null | undefined;
  /** Neighbour anchor of a message with neither an id nor an exact time (see page-parser). */
  anchor: string | null;
}

export function attachmentSignature(attachments: ReadonlyArray<Pick<Attachment, 'kind' | 'name'>>): string {
  return attachments.map((att) => `${att.kind}:${att.name ?? ''}`).join(',');
}

/** Fingerprint of a message in the conversation with key `conversationKey`. */
export function messageFingerprint(conversationKey: string, parts: FingerprintParts): string {
  return hashParts([conversationKey, parts.kind, parts.isSelf ? 'self' : 'other', parts.strongTime, parts.normalizedText, parts.attachments, parts.replyPreview, parts.anchor ?? '']);
}

/**
 * The fingerprint parts the page parser would compute today for an archived message. Null for a
 * message with neither a Teams id nor an exact time: its fingerprint depends on which neighbours
 * were rendered around it, which is not stored.
 */
export function storedFingerprintParts(message: StoredMessage): FingerprintParts | null {
  const strongTime = STRONG_TIMESTAMP_SOURCES.has(message.timestampSource) ? message.timestamp : null;
  if (!message.messageId && strongTime === null) return null;
  return {
    kind: message.kind,
    isSelf: message.sender.isSelf,
    strongTime,
    normalizedText: normalizeForHash(message.text),
    attachments: attachmentSignature(message.attachments),
    replyPreview: message.replyTo?.preview,
    anchor: null,
  };
}
