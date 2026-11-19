/** Factories for extracted messages and session records used by storage-level tests. */
import { hashParts, normalizeForHash } from '../../src/shared/hash';
import { EXTRACTOR_VERSION, emptyCounters, type ConversationIdentity, type ExtractedMessage, type SessionRecord } from '../../src/shared/types';

export const CONVERSATION: ConversationIdentity = {
  conversationKey: 'teams:19:abcdef0123456789@thread.v2',
  threadId: '19:abcdef0123456789@thread.v2',
  title: 'Project Alpha',
  type: 'group',
  keySource: 'dom',
  typeSource: 'thread-id',
};
export const CK = CONVERSATION.conversationKey;

export type MessageOverrides = Partial<ExtractedMessage> & {
  /** Teams message id (epoch ms string); null for a message without id. Default 1705314600000. */
  id?: string | null;
};

/** An observation as the page parser would produce it (Teams id doubles as timestamp). */
export function message(overrides: MessageOverrides = {}): ExtractedMessage {
  const { id: idOverride, ...fields } = overrides;
  const id = idOverride === undefined ? '1705314600000' : idOverride;
  const conversationKey = fields.conversationKey ?? CK;
  const text = fields.text ?? `Message ${id ?? 'without id'}`;
  const attachments = fields.attachments ?? [];
  const isDeleted = fields.isDeleted ?? false;
  const ms = id ? Number(id) : null;
  const attachmentSig = attachments.map((att) => `${att.kind}:${att.name ?? ''}`).join(',');
  const fingerprint =
    fields.fingerprint ?? hashParts([conversationKey, 'message', 'other', ms === null ? null : new Date(ms).toISOString(), normalizeForHash(text), attachmentSig, undefined, '']);
  return {
    key: id ? `${conversationKey}#${id}` : `${conversationKey}#fp:${fingerprint}`,
    conversationKey,
    messageId: id,
    idSource: id ? 'dom' : 'fingerprint',
    kind: 'message',
    sender: { name: 'Alice Andersen', id: null, isSelf: false, source: 'explicit' },
    timestamp: ms === null ? null : new Date(ms).toISOString(),
    timestampSource: ms === null ? 'none' : 'datetime-attr',
    timestampRaw: null,
    sortKey: ms,
    sortKeySource: ms === null ? null : 'message-id',
    text,
    html: text ? `<p>${text}</p>` : '',
    mentions: [],
    links: [],
    attachments,
    replyTo: null,
    isEdited: false,
    isDeleted,
    contentHash: hashParts([normalizeForHash(text), attachmentSig, isDeleted ? 'deleted' : '']),
    fingerprint,
    fingerprintStrong: ms !== null,
    alternateKeys: [],
    ...fields,
  };
}

export function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const startedAt = overrides.startedAt ?? '2024-01-15T10:00:00.000Z';
  return {
    sessionId: 'session-1',
    conversationKey: CK,
    conversationTitle: 'Project Alpha',
    mode: 'full',
    rescan: false,
    status: 'running',
    stopReason: null,
    error: null,
    resumeOf: null,
    tabId: 7,
    startedAt,
    updatedAt: startedAt,
    endedAt: null,
    counters: emptyCounters(),
    warnings: [],
    extractorVersion: EXTRACTOR_VERSION,
    ...overrides,
  };
}
