# Export format v1

This is the contract for moving archived Teams chats into other systems, such as a knowledge management system. The format is produced by `src/export/format.ts` and `src/export/exporters.ts`, and read back by the archive page's **Import archive…**.

| Format | File | Use |
| --- | --- | --- |
| JSON | `*.json` | Canonical and lossless. Importing it restores the archive exactly, and re-importing is idempotent. |
| ZIP: chat + pictures | `*.zip` | For people: `chat.html` and `chat.md` with the pictures shown in place, and the pictures as files. Not importable. See [ZIP transcripts](#zip-transcripts). |

**Stability promise:** within `formatVersion: 1`, fields are only ever *added*. Renaming, removing or changing the meaning of a field requires `formatVersion: 2`. Ignore fields you don't know.

## JSON structure

```jsonc
{
  "format": "teams-chat-archive",
  "formatVersion": 1,
  "exportedAt": "2024-02-01T10:20:30.456Z",
  "generator": { "name": "teams-chat-extractor", "version": "1.3.0", "extractorVersion": "1.1.0", "schemaVersion": 3 },
  "conversations": [
    {
      "conversationKey": "teams:19:abc…@thread.v2",
      "title": "Project Alpha",
      "type": "group",
      // … conversation fields (below)
      "messages": [ /* message records in timeline order (below) */ ],
      "images": [ /* saved images (below); absent in exports made before 1.1 or without images */ ]
    }
  ]
}
```

All timestamps are ISO-8601 strings in UTC. Numbers named `…SortKey`, `oldest` and `newest` are epoch milliseconds and can be fractional.

### Conversation fields

| Field | Type | Meaning |
| --- | --- | --- |
| `conversationKey` | string | Stable identifier of the chat in this archive: `teams:<threadId>`, or `title:<normalised title>` when no thread id was visible. Since 1.2 also `local:<random id>`, for a chat that has the title of another archived chat. |
| `threadId` | string \| null | Teams thread id, for example `19:…@thread.v2` (group), `19:…_…@unq.gbl.spaces` (1:1), `19:meeting_…@thread.v2` (meeting). |
| `title` | string \| null | Chat title as shown in Teams at the last extraction. |
| `displayName` | string \| null (optional) | Name given to the chat in the archive (**Rename**). Show it instead of `title` when it is set. Added in 1.2. |
| `titleHistory` | `{ title, firstSeenAt, lastSeenAt }[]` (optional) | Titles the chat was archived under, oldest first (at most 50). Added in 1.2. |
| `aliases` | string[] (optional) | Other conversation keys of this chat: keys it was detected under in Teams, and the keys of entries merged into it. Added in 1.2. |
| `mergedFrom` | string[] (optional) | Keys of the entries that were merged into this one (see [Identity changes](#identity-changes)). Added in 1.2. |
| `mergedInto` | string \| null (optional) | Set only on an entry exported while it was being merged: the key of the entry it is going into. Import ignores it. Added in 1.2. |
| `type` | `one-on-one` \| `group` \| `meeting` \| `channel` \| `unknown` | Derived from the thread id. |
| `keySource` | `dom` \| `url` \| `title` | Where the identity came from. `title` is the weakest. |
| `typeSource` | `thread-id` \| `unknown` | How `type` was determined. |
| `participants` | string[] | Display names of everyone who posted a captured message, sorted. |
| `messageCount` | number | Number of message records. |
| `oldestSortKey`, `newestSortKey` | number \| null | Range of reliably dated messages. |
| `coverage` | `{ oldest, newest, reachedBeginning }[]` | Stretches of the timeline captured without gaps (see below). |
| `firstExtractedAt`, `lastExtractedAt` | string | First and most recent extraction. |
| `lastUpdate` | `{ sessionId, mode, at, newestSortKey }` | null (optional) | The most recent run after which the archive held every message, without a gap, from the previous update (or the beginning) up to `newestSortKey`. `at` is when that run ended, `mode` is `full` or `incremental`. Unlike `lastExtractedAt`, stopped runs that left a gap don't change it. Import keeps the one with the newer `newestSortKey`. Added in 1.3. |
| `lastSessionId` | string \| null | Most recent extraction session. |
| `schemaVersion` | number | Archive schema version of the record. |
| `messages` | message[] | Ordered by `sortKey` ascending. |
| `images` | image[] (optional) | Saved images of the conversation, ordered by `firstSavedAt` (see [Image fields](#image-fields)). Added in 1.1. It is absent in older exports and in exports made with **Include images** off. |

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
| `attachments` | `{ kind, name, url, imageId? }[]` | `kind`: `file`, `image`, `link-preview`, `card` or `other`. Files aren't downloaded. `url` usually points to SharePoint/OneDrive and requires sign-in; it is null for images Teams shows from a temporary `blob:` address. `imageId` (images only, added in 1.1) is the `imageId` of the saved copy in the conversation's `images`; it is absent when the image wasn't saved. Teams names most pasted pictures just `image`, so several attachments can share a name. |
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

### Image fields

Images are content-addressed: `imageId` is the SHA-256 of the bytes, so an image never changes and the same picture is stored once per conversation.

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | `<conversationKey>#img:<imageId>`. Stable unique identifier. |
| `conversationKey` | string | Owning conversation. |
| `imageId` | string | SHA-256 of the image bytes, as 64 lower-case hex characters. Attachments refer to it. |
| `mimeType` | string | `image/png`, `image/jpeg`, `image/gif`, `image/webp` and so on. |
| `byteLength` | number | Size of the image in bytes. |
| `width`, `height` | number \| null | Pixel size, when known. |
| `method` | `fetch` \| `canvas` | `fetch`: the bytes Teams displayed (from the page's copy, the browser cache or the image address). `canvas`: the displayed picture re-encoded as PNG, used when the bytes couldn't be read. |
| `firstSavedAt` | string | When the image was first saved. |
| `sessionId` | string \| null | Session that saved it. |
| `schemaVersion` | number | Archive schema version of the record. |
| `dataBase64` | string | The image bytes, standard base64 with padding. |

The saved copy is the picture as Teams displayed it, which may be a preview size rather than the original upload. An import checks that `dataBase64` has `byteLength` bytes whose SHA-256 is `imageId`, and rejects the whole file otherwise.

### Identity changes

Messages that Teams rendered *without* an id are rare and are keyed by fingerprint. When the same message is later matched to its id record, the fingerprint record is merged into it, and the old key is listed in the surviving record's `aliases`. A consumer that already ingested the old key should delete its copy when it sees that key in another record's `aliases`.

**Merged conversations** (1.2). Two archive entries of one chat, for example from before and after Teams renamed it, can be merged on the archive page. The merged entry disappears from later exports. Its key is listed in the surviving conversation's `mergedFrom` and `aliases`, and its messages have keys under the surviving conversation (`<conversationKey>#<messageId>`) with their old keys in `aliases`. A consumer that ingested the merged entry should delete or move what it stored under that conversation key when the key appears in another conversation's `mergedFrom`.

**Import.** An imported conversation joins the archive entry of the same chat, found the way a run finds it: by key, by `aliases`, or by holding messages with the same Teams ids. It then takes that entry's key, and its own key becomes an alias. A conversation whose title key belongs to an archived chat with other messages is imported under a new `local:` key instead, so two chats are never mixed.

## ZIP transcripts

Made by `src/export/transcript.ts` (files stored uncompressed, UTF-8 names). With one conversation the files are at the top of the ZIP; with several, each conversation has its own folder (named after its title) and `index.html` links them.

| File | Content |
| --- | --- |
| `chat.html` | The conversation message by message, each saved picture in its message. Self-contained: styles inline, no scripts, no remote content. Text comes from the `text` field and is escaped; only `http`/`https` links are kept. The archive page's **PDF (print)** prints this same page. |
| `chat.md` | The Markdown transcript, with saved pictures as `![name](images/<file>)`. |
| `images/<n>_<date>_<time>.<ext>` | The saved pictures, numbered in the order the messages show them; date and time are those of the first message showing the picture, in the exporting computer's time zone (`001_2026-11-02_1001.png`). A picture shown in several messages is one file. Saved pictures no message shows any more (for example after an edit) are left out; JSON exports keep them. |

The ZIP is for reading, not for import: use a JSON export as the backup.

## Recommended ingestion

1. Upsert messages by `key`, and conversations by `conversationKey`.
2. Treat a changed `contentHash` for a known `key` as an edit. `previousVersions` holds what was replaced.
3. Remove message records whose key appears in another record's `aliases`, and conversations whose key appears in another conversation's `mergedFrom`.
4. Store images by `key` (or by `imageId` per conversation). An image never changes, so one already ingested can be skipped. Resolve an attachment's `imageId` within its conversation's images.
5. To fetch only new data, export again later. Exports always contain the full archive, so any export can be re-ingested with this upsert logic.
6. Use `coverage` and `lastUpdate` to show how complete and how current each chat is.
