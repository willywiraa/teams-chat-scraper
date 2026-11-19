# Export format v1

This is the contract for moving archived Teams chats into other systems, such as a knowledge management system. The format is produced by `src/export/format.ts` and `src/export/exporters.ts`, and read back by the archive page's **Import archive…**.

| Format | File | Use |
| --- | --- | --- |
| JSON | `*.json` | Canonical and lossless. Importing it restores the archive exactly, and re-importing is idempotent. |
| NDJSON | `*.ndjson` | The same records, one JSON object per line, for streaming ingestion. |
| Markdown | `*.md` | A human-readable transcript, not meant for machine ingestion. |

**Stability promise:** within `formatVersion: 1`, fields are only ever *added*. Renaming, removing or changing the meaning of a field requires `formatVersion: 2`. Ignore fields you don't know.

## JSON structure

```jsonc
{
  "format": "teams-chat-archive",
  "formatVersion": 1,
  "exportedAt": "2024-02-01T10:20:30.456Z",
  "generator": { "name": "teams-chat-extractor", "version": "1.0.0", "extractorVersion": "1.0.0", "schemaVersion": 1 },
  "conversations": [
    {
      "conversationKey": "teams:19:abc…@thread.v2",
      "title": "Project Alpha",
      "type": "group",
      // … conversation fields (below)
      "messages": [ /* message records in timeline order (below) */ ]
    }
  ]
}
```

All timestamps are ISO-8601 strings in UTC. Numbers named `…SortKey`, `oldest` and `newest` are epoch milliseconds and can be fractional.

### Conversation fields

| Field | Type | Meaning |
| --- | --- | --- |
| `conversationKey` | string | Stable identifier of the chat in this archive: `teams:<threadId>`, or `title:<normalised title>` when no thread id was visible. |
| `threadId` | string \| null | Teams thread id, for example `19:…@thread.v2` (group), `19:…_…@unq.gbl.spaces` (1:1), `19:meeting_…@thread.v2` (meeting). |
| `title` | string \| null | Chat title as shown in Teams. |
| `type` | `one-on-one` \| `group` \| `meeting` \| `channel` \| `unknown` | Derived from the thread id. |
| `keySource` | `dom` \| `url` \| `title` | Where the identity came from. `title` is the weakest. |
| `typeSource` | `thread-id` \| `unknown` | How `type` was determined. |
| `participants` | string[] | Display names of everyone who posted a captured message, sorted. |
| `messageCount` | number | Number of message records. |
| `oldestSortKey`, `newestSortKey` | number \| null | Range of reliably dated messages. |
| `coverage` | `{ oldest, newest, reachedBeginning }[]` | Stretches of the timeline captured without gaps (see below). |
| `firstExtractedAt`, `lastExtractedAt` | string | First and most recent extraction. |
| `lastSessionId` | string \| null | Most recent extraction session. |
| `schemaVersion` | number | Archive schema version of the record. |
| `messages` | message[] | Ordered by `sortKey` ascending. |

**Coverage.** `coverage` is how a consumer can tell how complete the history is. If one range has `reachedBeginning: true` and its `newest` is at least `newestSortKey`, the archive holds the chat's complete history up to its last extraction. Several ranges mean there are stretches in between that were never captured.

### Message fields

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | **Stable unique identifier.** Use it as the idempotency key: `<conversationKey>#<messageId>`, or `<conversationKey>#fp:<fingerprint>` when Teams showed no message id. |
| `conversationKey` | string | Owning conversation. |
| `messageId` | string \| null | Teams message id. In Teams this is the message's arrival time in epoch milliseconds. |
| `idSource` | `dom` \| `fingerprint` | Whether `key` is based on the Teams id or on a content fingerprint. |
| `aliases` | string[] | Other keys this message has been known by (see [Identity changes](#identity-changes)). |
| `kind` | `message` \| `system` | `system` covers events such as "X added Y to the chat". |
| `sender` | `{ name, id, isSelf, source }` | `name`: display name, or null if unknown. `id`: Teams user id (MRI) when visible. `isSelf`: sent by the archiving user. `source`: `explicit` (shown in Teams), `self`, `group-inferred` (carried from the first message of a run by the same person) or `unknown`. |
| `timestamp` | string \| null | When the message was sent (UTC). |
| `timestampSource` | `datetime-attr` \| `title-attr` \| `aria-label` \| `message-id` \| `visible-text` \| `none` | Precision, best first. `visible-text` may be accurate only to the minute. |
| `timestampRaw` | string \| null | The time label as Teams displayed it, if read. |
| `sortKey` | number | Position in the timeline (epoch ms). Sort by it. |
| `sortKeySource` | `message-id` \| `timestamp` \| `interpolated` \| `observed-order` | The first two are exact. `interpolated` places a message between its neighbours. |
| `text` | string | Plain text. Paragraphs are separated by a blank line, list items start with `- ` or `1. `, and line breaks are preserved. |
| `html` | string | Sanitised HTML of the message body (safe tags and attributes only, `http(s)`/`mailto`/`tel` links). It may be empty. |
| `mentions` | `{ name, id }[]` | People mentioned. |
| `links` | `{ href, text }[]` | Links in the message. |
| `attachments` | `{ kind, name, url }[]` | `kind`: `file`, `image`, `link-preview`, `card` or `other`. Files aren't downloaded. `url` usually points to SharePoint/OneDrive and requires sign-in. |
| `replyTo` | object \| null | Quoted reply: `messageId`, `senderName`, `timestampRaw` and `preview` (the quoted text as shown), plus `resolvedKey` (the `key` of the quoted message when known) and `resolution` (`message-id`, `content-match` or `unresolved`). |
| `isEdited` | boolean | Teams showed the message as edited, or a content change was observed. |
| `isDeleted` | boolean | Teams showed the message as deleted. |
| `previousVersions` | `{ text, html, contentHash, replacedAt }[]` | Earlier contents observed before an edit or deletion, oldest first (at most 20). |
| `contentHash` | string | Hash of the visible content. It changes whenever the text, attachments or deleted state change. |
| `fingerprint`, `fingerprintStrong` | string, boolean | Internal de-duplication data. |
| `firstSeenAt`, `lastSeenAt` | string | First and most recent time the extractor saw the message. |
| `firstSessionId`, `lastSessionId` | string | Sessions that first and last saw it. |
| `observationCount` | number | How many times it was captured. |
| `extractorVersion`, `schemaVersion` | string, number | Versions that last wrote the record. |

### Identity changes

Messages that Teams rendered *without* an id are rare and are keyed by fingerprint. When the same message is later matched to its id record, the fingerprint record is merged into it, and the old key is listed in the surviving record's `aliases`. A consumer that already ingested the old key should delete its copy when it sees that key in another record's `aliases`.

## NDJSON structure

One JSON object per line, discriminated by `record`. A conversation's message lines always follow its conversation line.

```
{"record":"header","format":"teams-chat-archive","formatVersion":1,"exportedAt":"…","generator":{…}}
{"record":"conversation","conversationKey":"teams:19:…","title":"Project Alpha","type":"group",…}
{"record":"message","key":"teams:19:…#1705314600000","sender":{…},"text":"…",…}
{"record":"message",…}
{"record":"conversation",…}
…
```

The conversation line holds all conversation fields except `messages`. Message lines hold all message fields. (The discriminator is called `record` because conversations already have a `type` field.)

## Recommended ingestion

1. Upsert messages by `key`, and conversations by `conversationKey`.
2. Treat a changed `contentHash` for a known `key` as an edit. `previousVersions` holds what was replaced.
3. Remove records whose key appears in another record's `aliases`.
4. To fetch only new data, export again later. Exports always contain the full archive, so any export can be re-ingested with this upsert logic.
5. Use `coverage` (or the conversation's `lastExtractedAt`) to show how current and complete each chat is.
