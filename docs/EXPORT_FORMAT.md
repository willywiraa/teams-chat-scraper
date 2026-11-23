# Export format v1

This is the contract for moving archived Teams chats into other systems, such as a knowledge management system. Files are written by `src/export/pipeline.ts` (records in `src/export/format.ts`, transcripts in `src/export/render.ts`), and read back by the archive page's **Import archive…** (`src/export/import.ts`).

A file is saved from the popup, when a capture ends or with **Save a file from the archive only**; from a chat's page on the archive page, with **Save a file…**; and by **Back up now**, which saves a ZIP package of every chat with everything in it. The popup and the archive page share the choices, a format and what to include, and remember them; the first time the format is PDF.

| Format | File | Importable | Use |
| --- | --- | --- | --- |
| PDF | a printable page in a new tab | no | Choose **Save as PDF** as the printer. See [Transcripts](#transcripts). |
| Text | `.txt` file, or a ZIP when pictures are included | no | Anything that reads text. |
| JSON | one `.json` file | **yes** | Canonical records. See [JSON structure](#json-structure). |
| ZIP package | ZIP | **yes** | Records as JSON Lines, a Markdown transcript and the pictures as files. See [ZIP package](#zip-package). |

Versions before 1.9 also offered an HTML page, Markdown and CSV; a choice remembered from them becomes PDF. Files saved in those formats are not affected; Import archive… never read them.

**Stability promise:** within `formatVersion: 1`, fields are only ever *added*. Renaming, removing or changing the meaning of a field requires `formatVersion: 2`. Ignore fields you don't know. The same holds for the package's own `formatVersion`.

## What a file holds

**Period.** A file saved when a capture ends holds the period captured: for **Last 24 hours**, **Last 7 days** or **Last 30 days** the messages from that moment on, for **From a date…** those from midnight of that day (in the computer's time zone), and for **On screen** the messages captured, from the oldest to the newest. After **New messages** or **Full history**, and from the archive page, it holds every archived message of the chat. **Save a file from the archive only** takes the period chosen in the popup, or every archived message. A message is in the period when its `sortKey` is; a period always reaches up to the newest message, except for **On screen**.

**Content.**

| Choice | Off means |
| --- | --- |
| Pictures | No saved pictures. Text is then one file; with pictures it is a ZIP. |
| File attachments | Transcripts don't list attachments. Records always keep them, because they are part of the message (its `contentHash`). |
| Reply context | Transcripts don't show what a reply quotes. Records always keep `replyTo`. |
| Reactions | Transcripts don't show reactions, and records have no `reactions`. Importing such a file keeps the reactions already archived. |
| System messages | Messages with `kind: "system"` are left out, of records too. |
| Edit history | Earlier versions are left out: records have `previousVersions: []`. |

**Records of a part of a conversation.** When a period is set or system messages are left out, a conversation record (JSON and package) describes what the export holds rather than the whole archive entry:

- `messageCount`, `oldestSortKey` and `newestSortKey` count and span the exported messages;
- `coverage` is limited to the period; a range keeps `reachedBeginning: true` only if the period starts before it;
- `lastUpdate` is kept only when the period has no end (it reaches the newest messages), else it is null.

So importing a period adds its messages and says truthfully which stretch of the chat they cover; importing the whole archive later completes it without duplicates.

**Images in records.** Without a period, a record export holds every saved image of the conversation, also those no message shows any more (for example after an edit). With a period it holds the images the exported messages show.

## JSON structure

```jsonc
{
  "format": "teams-chat-archive",
  "formatVersion": 1,
  "exportedAt": "2024-02-01T10:20:30.456Z",
  "generator": { "name": "teams-chat-extractor", "version": "1.4.0", "extractorVersion": "1.1.0", "schemaVersion": 3 },
  "selection": { "from": null, "to": null, "images": true, "reactions": true, "systemMessages": true, "editHistory": true },
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

All timestamps are ISO-8601 strings in UTC. Numbers named `…SortKey`, `oldest` and `newest` are epoch milliseconds and can be fractional. The file is written one message per line, so it can be read in parts.

### Selection

`selection` (added in 1.4, optional) says what the export was made with:

| Field | Type | Meaning |
| --- | --- | --- |
| `from` | string \| null | Start of the period (included), or null for no start. |
| `to` | string \| null | End of the period (not included), or null for no end. |
| `images` | boolean | Whether saved images were included. |
| `reactions` | boolean | Whether reactions were included. Added in 1.7; an older export holds the reactions it has (none before 1.7). |
| `systemMessages` | boolean | Whether system messages were included. |
| `editHistory` | boolean | Whether earlier versions of edited messages were included. |

An export without `selection` (made before 1.4) holds the whole archive.

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
| `messageCount` | number | Number of message records (in the export, for a [part of a conversation](#what-a-file-holds)). |
| `oldestSortKey`, `newestSortKey` | number \| null | Range of reliably dated messages. |
| `coverage` | `{ oldest, newest, reachedBeginning }[]` | Stretches of the timeline captured without gaps (see below). |
| `firstExtractedAt`, `lastExtractedAt` | string | First and most recent extraction. |
| `lastUpdate` | `{ sessionId, mode, at, newestSortKey }` \| null (optional) | The most recent run after which the archive held every message, without a gap, from the previous update (or the beginning) up to `newestSortKey`. `at` is when that run ended, `mode` is `full` or `incremental`. Unlike `lastExtractedAt`, stopped runs that left a gap don't change it. Import keeps the one with the newer `newestSortKey`. Added in 1.3. |
| `lastSessionId` | string \| null | Most recent extraction session. |
| `schemaVersion` | number | Archive schema version of the record. |
| `messages` | message[] | Ordered by `sortKey` ascending. |
| `images` | image[] (optional) | Saved images of the conversation, ordered by `firstSavedAt` (see [Image fields](#image-fields)). Added in 1.1. It is absent in older exports and in exports made without pictures. |

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
| `reactions` | `{ emoji, count, mine }[]`, optional | Added in 1.7. The reactions under the message as Teams last showed them, in its order: `emoji` is the character (or a name such as `Like` when Teams shows only a picture with a name), `count` how many people chose it (at least 1), `mine` whether the archiving user did. Who reacted is not recorded. Absent when no reactions were seen. Not part of `contentHash`. A capture that shows no reactions leaves the archived ones, so a reaction removed in Teams can remain until another reaction is seen. |
| `isEdited` | boolean | Teams showed the message as edited, or a content change was observed. |
| `isDeleted` | boolean | Teams showed the message as deleted. |
| `previousVersions` | `{ text, html, contentHash, replacedAt }[]` | Earlier contents observed before an edit or deletion, oldest first (at most 20). Empty in exports made without edit history. |
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
| `dataBase64` | string | The image bytes, standard base64 with padding. (In the ZIP package the bytes are a file instead.) |

The saved copy is the picture as Teams displayed it, which may be a preview size rather than the original upload. An import checks that the bytes are `byteLength` long and that their SHA-256 is `imageId`, and rejects the whole file otherwise.

### Identity changes

Messages that Teams rendered *without* an id are rare and are keyed by fingerprint. When the same message is later matched to its id record, the fingerprint record is merged into it, and the old key is listed in the surviving record's `aliases`. A consumer that already ingested the old key should delete its copy when it sees that key in another record's `aliases`.

**Merged conversations** (1.2). Two archive entries of one chat, for example from before and after Teams renamed it, can be merged on the archive page. The merged entry disappears from later exports. Its key is listed in the surviving conversation's `mergedFrom` and `aliases`, and its messages have keys under the surviving conversation (`<conversationKey>#<messageId>`) with their old keys in `aliases`. A consumer that ingested the merged entry should delete or move what it stored under that conversation key when the key appears in another conversation's `mergedFrom`.

**Import.** An imported conversation joins the archive entry of the same chat, found the way a run finds it: by key, by `aliases`, or by holding messages with the same Teams ids. It then takes that entry's key, and its own key becomes an alias. A conversation whose title key belongs to an archived chat with other messages is imported under a new `local:` key instead, so two chats are never mixed.

## ZIP package

Called the knowledge package before 1.9.

A ZIP (files stored uncompressed, UTF-8 names) with the same records as the JSON export, one file per kind, so a system can read it line by line and pick up the pictures as files. Added in 1.4.

```text
manifest.json
conversations/
  Project-Alpha-120d474f/
    conversation.json
    messages.jsonl
    images.jsonl
    images/<imageId>.<ext>
    transcript.md
```

| File | Content |
| --- | --- |
| `manifest.json` | What the package holds (below). Written last. |
| `conversations/<name>-<hash>/` | One folder per conversation: its name (letters and digits, others as `-`) and the first 8 hex characters of the SHA-256 of its `conversationKey`. Use the manifest's `folder` rather than building the name. |
| `conversation.json` | The [conversation record](#conversation-fields) without `messages` and `images`. |
| `messages.jsonl` | One [message record](#message-fields) per line, in timeline order. Lines end with `\n`. |
| `images.jsonl` | One [image record](#image-fields) per line without `dataBase64`, plus `file`: the picture's path from the conversation folder (`images/<imageId>.<ext>`). Empty without pictures. |
| `images/<imageId>.<ext>` | The picture bytes. The name is the SHA-256 of the bytes, so a picture is one file however many messages show it, and a system can check it. |
| `transcript.md` | The conversation as [Markdown](#transcripts), the pictures shown in place from `images/`. For people, and for systems that index Markdown. |

`manifest.json`:

```jsonc
{
  "format": "teams-chat-archive-package",
  "formatVersion": 1,
  "exportedAt": "2024-02-01T10:20:30.456Z",
  "generator": { "name": "teams-chat-extractor", "version": "1.4.0", "extractorVersion": "1.1.0", "schemaVersion": 3 },
  "records": { "format": "teams-chat-archive", "formatVersion": 1 },   // the record format of the .json and .jsonl files
  "selection": { "from": null, "to": null, "images": true, "reactions": true, "systemMessages": false, "editHistory": true },
  "timeZone": "Europe/Berlin",                                            // of the times in the transcripts
  "conversations": [
    { "conversationKey": "teams:19:abc…@thread.v2", "name": "Project Alpha", "folder": "conversations/Project-Alpha-120d474f", "messages": 4, "images": 3 }
  ]
}
```

A package can be zipped again, for example inside a folder and compressed by Windows: import finds `manifest.json` at the top or in one folder, and reads stored and deflated files.

## Transcripts

PDF, text and the ZIP package's Markdown transcript are for reading. They show each conversation's name, type, participants, message count, how much history the archive holds, the period and the time zone, then the messages day by day: sender, time, text, reply context, attachments, pictures, reactions (`Reactions: 👍 2 · ❤️ 1 (yours: 👍)`), *(edited)* and *(deleted)* marks and, when chosen, earlier versions. Text is escaped for each format; only `http` and `https` links are kept.

| Text | File |
| --- | --- |
| One file | Without pictures. Its name is the conversation's (or `teams-archive`) and the time it was saved: `Project-Alpha-2024-02-01T10-20-30.txt`. |
| ZIP | With pictures: `chat.txt` and `images/` at the top of the ZIP, or, with several conversations, in a folder for each (named after it). |

- **PDF**: the printed page is HTML, self-contained: styles inline, no scripts, no remote content, the pictures in their messages. The save page writes it into a frame and opens the print dialog; **Print again** opens it once more.
- **Markdown** (the ZIP package's `transcript.md`): pictures as `![name](images/<file>)`. Markdown characters in messages are escaped, so a message's text reads as it did in Teams.
- **Plain text**: each message as a `time sender` line followed by its text, indented.
- **Pictures in a text file's ZIP**: `images/<n>_<date>_<time>.<ext>`, numbered in the order the messages show them; date and time are those of the first message showing the picture, in the file's time zone (`001_2026-11-02_1001.png`). A picture shown in several messages is one file. Saved pictures no message shows any more are left out; the records formats keep them.

## Import

**Import archive…** reads a JSON file (any version 1 file) or a ZIP package; it tells them apart by their first bytes. Both are read in parts, so large files don't have to fit in memory as text.

1. **Checking**: the whole file is read and every conversation, message and image checked (an image's bytes against its `byteLength` and SHA-256). A damaged or cut-off file is refused before anything is written.
2. **Importing**: conversation by conversation, its messages in batches of 500 and its pictures. Messages are merged by `key` (an import never removes anything), and records are joined to the archive entry of the same chat (see [Identity changes](#identity-changes)).

Re-importing a file changes nothing. If an import is interrupted, for example because the tab was closed, the conversation it was writing is in the archive with the messages written so far and without coverage, so it shows as partial; importing the file again completes it.

## Recommended ingestion

1. Upsert messages by `key`, and conversations by `conversationKey`.
2. Treat a changed `contentHash` for a known `key` as an edit. `previousVersions` holds what was replaced.
3. Remove message records whose key appears in another record's `aliases`, and conversations whose key appears in another conversation's `mergedFrom`.
4. Store images by `key` (or by `imageId` per conversation). An image never changes, so one already ingested can be skipped. Resolve an attachment's `imageId` within its conversation's images.
5. To fetch only new data, capture the last days (for example **Last 7 days**) with JSON or the ZIP package chosen, and upsert its records: the period's records say which stretch they cover. A file of all archived messages can always be re-ingested with the same upsert logic.
6. Use `coverage` and `lastUpdate` to show how complete and how current each chat is.
7. Systems that index documents rather than records can take each conversation's `transcript.md` from the ZIP package.
