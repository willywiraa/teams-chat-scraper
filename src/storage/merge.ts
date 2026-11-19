/**
 * Pure merge rules applied when a message is observed again (or imported).
 *
 * Principles: never lose information, prefer better-sourced metadata, keep earlier contents
 * when an edit or deletion is detected, and ignore partially rendered (empty) observations.
 */
import {
  ARCHIVE_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  type Attachment,
  type ExtractedMessage,
  type MessageVersion,
  type ReplyReference,
  type SenderSource,
  type SortKeySource,
  type StoredMessage,
  type TimestampSource,
  type UpsertStatus,
} from '../shared/types';

export const MAX_PREVIOUS_VERSIONS = 20;

export const SENDER_RANK: Record<SenderSource, number> = { explicit: 3, self: 3, 'group-inferred': 2, unknown: 0 };
export const TIMESTAMP_RANK: Record<TimestampSource, number> = {
  'datetime-attr': 5,
  'title-attr': 4,
  'aria-label': 4,
  'message-id': 3,
  'visible-text': 2,
  none: 0,
};
export const SORT_KEY_RANK: Record<SortKeySource, number> = { 'message-id': 4, timestamp: 3, interpolated: 2, 'observed-order': 1 };

export interface MergeContext {
  sessionId: string;
  nowIso: string;
}

export interface MergeResult {
  record: StoredMessage;
  status: UpsertStatus;
}

function attachmentKey(att: Attachment): string {
  return `${att.kind}|${att.name ?? ''}|${att.url ?? ''}`;
}

export function unionAttachments(a: readonly Attachment[], b: readonly Attachment[]): Attachment[] {
  const byKey = new Map<string, Attachment>();
  for (const att of [...a, ...b]) {
    // Same file seen with and without a (temporary) URL counts once.
    const loose = `${att.kind}|${att.name ?? ''}`;
    const existing = byKey.get(loose);
    if (!existing || (!existing.url && att.url)) byKey.set(loose, { ...att });
  }
  return Array.from(byKey.values());
}

function betterReply(current: ReplyReference | null, incoming: ReplyReference | null): ReplyReference | null {
  if (!incoming) return current;
  if (!current) return { ...incoming };
  if (!current.messageId && incoming.messageId) return { ...incoming };
  return {
    messageId: current.messageId ?? incoming.messageId,
    senderName: current.senderName ?? incoming.senderName,
    timestampRaw: current.timestampRaw ?? incoming.timestampRaw,
    preview: current.preview ?? incoming.preview,
    resolvedKey: current.resolvedKey ?? incoming.resolvedKey,
    resolution: current.resolvedKey ? current.resolution : incoming.resolvedKey ? incoming.resolution : current.resolution,
  };
}

function hasContent(message: Pick<ExtractedMessage, 'text' | 'attachments' | 'isDeleted'>): boolean {
  return message.text.trim().length > 0 || message.attachments.length > 0 || message.isDeleted;
}

/** Adds keys to an alias list, never listing the record's own key; null when nothing changed. */
function withAliases(record: Pick<StoredMessage, 'key' | 'aliases'>, keys: readonly string[] | undefined): string[] | null {
  const additions = (keys ?? []).filter((key) => key !== record.key && !record.aliases.includes(key));
  return additions.length > 0 ? Array.from(new Set([...record.aliases, ...additions])) : null;
}

export function createStoredMessage(observation: ExtractedMessage, ctx: MergeContext): StoredMessage {
  const { sortKey, sortKeySource, alternateKeys, ...rest } = observation;
  return {
    ...structuredClone(rest),
    sortKey: sortKey ?? Date.parse(ctx.nowIso),
    sortKeySource: sortKeySource ?? 'observed-order',
    firstSeenAt: ctx.nowIso,
    lastSeenAt: ctx.nowIso,
    firstSessionId: ctx.sessionId,
    lastSessionId: ctx.sessionId,
    observationCount: 1,
    previousVersions: [],
    aliases: withAliases({ key: observation.key, aliases: [] }, alternateKeys) ?? [],
    extractorVersion: EXTRACTOR_VERSION,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
  };
}

function pushVersion(versions: MessageVersion[], version: MessageVersion): MessageVersion[] {
  if (versions.some((existing) => existing.contentHash === version.contentHash)) return versions;
  return [...versions, version].slice(-MAX_PREVIOUS_VERSIONS);
}

/** Merges one observation into an existing record (or creates the record). */
export function mergeObservation(existing: StoredMessage | undefined, observation: ExtractedMessage, ctx: MergeContext): MergeResult {
  if (!existing) return { record: createStoredMessage(observation, ctx), status: 'inserted' };

  const next: StoredMessage = structuredClone(existing);
  let changed = false;

  if (observation.messageId && !next.messageId) {
    next.messageId = observation.messageId;
    next.idSource = 'dom';
    changed = true;
  }

  const incomingSenderRank = SENDER_RANK[observation.sender.source];
  const currentSenderRank = SENDER_RANK[next.sender.source];
  if (
    incomingSenderRank > currentSenderRank ||
    (incomingSenderRank === currentSenderRank && observation.sender.source === 'explicit' && observation.sender.name && observation.sender.name !== next.sender.name)
  ) {
    next.sender = { ...observation.sender, id: observation.sender.id ?? next.sender.id };
    changed = true;
  } else {
    if (!next.sender.id && observation.sender.id) {
      next.sender.id = observation.sender.id;
      changed = true;
    }
    if (!next.sender.name && observation.sender.name && observation.sender.isSelf === next.sender.isSelf) {
      next.sender.name = observation.sender.name;
      changed = true;
    }
  }

  if (TIMESTAMP_RANK[observation.timestampSource] > TIMESTAMP_RANK[next.timestampSource] && observation.timestamp) {
    next.timestamp = observation.timestamp;
    next.timestampSource = observation.timestampSource;
    next.timestampRaw = observation.timestampRaw ?? next.timestampRaw;
    changed = true;
  } else if (!next.timestampRaw && observation.timestampRaw) {
    next.timestampRaw = observation.timestampRaw;
    changed = true;
  }

  if (
    observation.sortKey !== null &&
    observation.sortKeySource !== null &&
    SORT_KEY_RANK[observation.sortKeySource] > SORT_KEY_RANK[next.sortKeySource]
  ) {
    next.sortKey = observation.sortKey;
    next.sortKeySource = observation.sortKeySource;
    changed = true;
  }

  if (observation.contentHash !== next.contentHash && hasContent(observation)) {
    if (hasContent(next)) {
      next.previousVersions = pushVersion(next.previousVersions, {
        text: next.text,
        html: next.html,
        contentHash: next.contentHash,
        replacedAt: ctx.nowIso,
      });
      // A parser upgrade can change normalisation without the message being edited.
      if (!observation.isDeleted && existing.extractorVersion === EXTRACTOR_VERSION) next.isEdited = true;
    }
    next.text = observation.text;
    next.html = observation.html;
    next.contentHash = observation.contentHash;
    next.mentions = structuredClone(observation.mentions);
    next.links = structuredClone(observation.links);
    next.fingerprint = observation.fingerprint;
    next.fingerprintStrong = observation.fingerprintStrong;
    next.isDeleted = observation.isDeleted;
    changed = true;
  } else if (!next.html && observation.html && observation.contentHash === next.contentHash) {
    next.html = observation.html;
    changed = true;
  }

  const attachments = unionAttachments(next.attachments, observation.attachments);
  if (attachments.length !== next.attachments.length || attachments.some((att, i) => attachmentKey(att) !== attachmentKey(next.attachments[i] as Attachment))) {
    next.attachments = attachments;
    changed = true;
  }

  const reply = betterReply(next.replyTo, observation.replyTo);
  if (JSON.stringify(reply) !== JSON.stringify(next.replyTo)) {
    next.replyTo = reply;
    changed = true;
  }

  if (observation.isEdited && !next.isEdited) {
    next.isEdited = true;
    changed = true;
  }
  if (observation.kind !== next.kind && observation.kind === 'message' && hasContent(observation)) {
    next.kind = observation.kind;
    changed = true;
  }
  const aliases = withAliases(next, [observation.key, ...(observation.alternateKeys ?? [])]);
  if (aliases) {
    next.aliases = aliases;
    changed = true;
  }

  next.lastSeenAt = ctx.nowIso;
  next.lastSessionId = ctx.sessionId;
  next.observationCount = existing.observationCount + 1;
  next.extractorVersion = EXTRACTOR_VERSION;
  return { record: next, status: changed ? 'updated' : 'unchanged' };
}

/** Folds a duplicate record (e.g. an earlier fingerprint-keyed copy) into the surviving record. */
export function absorbDuplicate(target: StoredMessage, duplicate: StoredMessage): StoredMessage {
  const next = structuredClone(target);
  next.aliases = Array.from(new Set([...next.aliases, duplicate.key, ...duplicate.aliases])).filter((key) => key !== next.key);
  if (duplicate.firstSeenAt < next.firstSeenAt) {
    next.firstSeenAt = duplicate.firstSeenAt;
    next.firstSessionId = duplicate.firstSessionId;
  }
  next.observationCount = target.observationCount + duplicate.observationCount;
  next.attachments = unionAttachments(next.attachments, duplicate.attachments);
  next.replyTo = betterReply(next.replyTo, duplicate.replyTo);
  for (const version of duplicate.previousVersions) next.previousVersions = pushVersion(next.previousVersions, version);
  if (SENDER_RANK[duplicate.sender.source] > SENDER_RANK[next.sender.source]) next.sender = { ...duplicate.sender };
  if (TIMESTAMP_RANK[duplicate.timestampSource] > TIMESTAMP_RANK[next.timestampSource]) {
    next.timestamp = duplicate.timestamp;
    next.timestampSource = duplicate.timestampSource;
    next.timestampRaw = duplicate.timestampRaw ?? next.timestampRaw;
  }
  next.isEdited = next.isEdited || duplicate.isEdited;
  return next;
}

/** Merges a record from an imported archive into an existing one. */
export function mergeImported(existing: StoredMessage | undefined, incoming: StoredMessage): MergeResult {
  const normalized = normalizeStoredMessage(incoming);
  if (!existing) return { record: normalized, status: 'inserted' };
  const newer = normalized.lastSeenAt > existing.lastSeenAt ? normalized : existing;
  const older = newer === normalized ? existing : normalized;
  let merged = absorbDuplicate(newer, { ...older, key: newer.key, aliases: older.aliases });
  merged.aliases = Array.from(new Set([...newer.aliases, ...older.aliases])).filter((key) => key !== merged.key);
  merged.observationCount = Math.max(existing.observationCount, normalized.observationCount);
  if (SORT_KEY_RANK[older.sortKeySource] > SORT_KEY_RANK[merged.sortKeySource]) {
    merged = { ...merged, sortKey: older.sortKey, sortKeySource: older.sortKeySource };
  }
  if (older.contentHash !== merged.contentHash && hasContent(older)) {
    merged.previousVersions = pushVersion(merged.previousVersions, {
      text: older.text,
      html: older.html,
      contentHash: older.contentHash,
      replacedAt: newer.lastSeenAt,
    });
  }
  merged.previousVersions = merged.previousVersions.filter((version) => version.contentHash !== merged.contentHash);
  const status: UpsertStatus = JSON.stringify(merged) === JSON.stringify(existing) ? 'unchanged' : 'updated';
  return { record: merged, status };
}

/** Fills defaults for records coming from older exports or hand-edited files. */
export function normalizeStoredMessage(message: StoredMessage): StoredMessage {
  return {
    ...message,
    messageId: message.messageId ?? null,
    idSource: message.idSource ?? (message.messageId ? 'dom' : 'fingerprint'),
    kind: message.kind ?? 'message',
    sender: {
      name: message.sender?.name ?? null,
      id: message.sender?.id ?? null,
      isSelf: Boolean(message.sender?.isSelf),
      source: message.sender?.source ?? 'unknown',
    },
    timestamp: message.timestamp ?? null,
    timestampSource: message.timestampSource ?? 'none',
    timestampRaw: message.timestampRaw ?? null,
    text: message.text ?? '',
    html: message.html ?? '',
    mentions: message.mentions ?? [],
    links: message.links ?? [],
    attachments: message.attachments ?? [],
    replyTo: message.replyTo ?? null,
    isEdited: Boolean(message.isEdited),
    isDeleted: Boolean(message.isDeleted),
    fingerprintStrong: Boolean(message.fingerprintStrong),
    sortKeySource: message.sortKeySource ?? 'observed-order',
    observationCount: message.observationCount ?? 1,
    previousVersions: message.previousVersions ?? [],
    aliases: message.aliases ?? [],
    extractorVersion: message.extractorVersion ?? EXTRACTOR_VERSION,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
  };
}
