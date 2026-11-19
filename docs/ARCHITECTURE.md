# Architecture

## Overview

```
 Teams Web tab (teams.microsoft.com)                 Extension origin
┌─────────────────────────────────────────┐        ┌──────────────────────────────────────────┐
│ content script (content/)               │ batch  │ background service worker (background/)  │
│  ContentController                      │ ─────▶ │  router ──▶ ArchiveRepository (storage/) │
│   ├─ extractor/  DOM → messages         │ ◀───── │                    │                     │
│   └─ scraper/    scroll, wait, repeat   │ status │                    ▼                     │
└───────────────────▲─────────────────────┘        │        IndexedDB "teams-chat-archive"    │
                    │ start / pause / stop /       │                    ▲                     │
                    │ status / diagnostics         │  popup, side panel, archive page (ui/)   │
                    └──────────────────────────────┤  read the database directly             │
                                                   └──────────────────────────────────────────┘
```

The content script runs inside the Teams page, so it can't open the extension's own IndexedDB. It sends every captured batch to the background service worker, which owns all writes. The popup, side panel and archive page belong to the extension origin and read the database directly. They control a running extraction by sending commands to the content script.

Only `background/service-worker.ts`, `content/content-script.ts` and `ui/` touch `chrome.*` APIs. Everything else (extractor, engine, storage, export, router and controller) receives its dependencies as parameters. That is why the complete pipeline runs in the test suite under jsdom and fake-indexeddb.

```
shared ◀── extractor ◀── scraper ◀── content
shared ◀── storage   ◀── background, export, ui
```

## One extraction pass

1. **Identify the chat** (`extractor/conversation.ts`). The Teams thread id comes from the highlighted chat-list entry, then the URL, then other page hints. It becomes the archive key `teams:<threadId>`. Without a thread id the normalised title is used (`title:<title>`), and the UI warns about it. The thread id also gives the chat type (`@unq.gbl.spaces` → 1:1, `@thread.v2` → group, `19:meeting_` → meeting, `@thread.tacv2` → channel).
2. **Collect the rendered items** (`extractor/page-parser.ts`). Message containers, date dividers and system messages, in document order.
3. **Parse each item** (`extractor/message-parser.ts`):
   - the Teams message id (`data-mid`, `content-<id>`, `timestamp-<id>`, …);
   - the author and the self-message marker;
   - the timestamp (`<time datetime>`, then `title`, then `aria-label`, then the visible label combined with the nearest date divider);
   - the body (`content-serializer.ts`: paragraphs, lists, line breaks, mentions, links, emoji, sanitised HTML);
   - the quoted reply, attachments, the edited marker and deleted messages.

   All selectors come from a [selector profile](../src/extractor/selectors.ts) that you can override from the settings.
4. **Complete the metadata** for the whole window:
   - Senders of grouped messages are inferred from the message above them. Teams shows the author only on the first message of a run.
   - Teams message ids are millisecond epoch timestamps, so they provide exact times when no time element is rendered.
   - De-duplication keys and fingerprints are computed (see below).
   - *Group links* are recorded: message B is shown without an author directly below message A.
5. **Engine** (`scraper/engine.ts`):
   - Assign a timeline position to messages that have neither an id nor a time (`sort-keys.ts`).
   - Check that this window overlaps the previous one.
   - Pass sender names down group links captured in earlier windows. A run from one person can be longer than the rendered window.
   - Send new or changed messages to storage.
   - Scroll up, wait until the page has settled (`settle.ts`: no DOM mutations for a quiet period and no loading spinner), and repeat.

## Keys and duplicate prevention

| Message has | Archive key | Notes |
| --- | --- | --- |
| Teams id | `<conversationKey>#<messageId>` | Normal case in Teams Web. |
| Exact timestamp, no id | `<conversationKey>#fp:<hash>` | The *strong* fingerprint covers sender side, kind, timestamp, text, attachment names and quoted preview. |
| Neither | `<conversationKey>#fp:<hash>` | The *weak* fingerprint adds the position relative to the nearest rendered message with an id (`n:<id>:<distance>`, or `p:<id>:<distance>`). |

Repeated observations are caught at three levels:

1. **Within a session**, the engine remembers a signature per key and sends a message again only when something about it changed.
2. **Across sessions**, records are keyed as above, so observing a message again merges into the same record (`storage/merge.ts`).
3. **Across identities**:
   - When a message first stored under a strong fingerprint later shows its id, the fingerprint record is folded into the id record. The old key is kept in `aliases`.
   - A weak fingerprint depends on which neighbours were rendered. When both the newer and the older anchor are visible, the parser reports the alternative key (`alternateKeys`), and storage finds earlier records under it through the multi-entry `byAlias` index.

Merge rules never lose information:

- Better-sourced metadata wins: an explicit author beats a group inference, which beats unknown, and `datetime` beats `title`/`aria-label`, which beat id-derived times, which beat parsed visible labels.
- Changed content pushes the previous text into `previousVersions` and sets `isEdited`. A change caused by an extractor upgrade alone doesn't set `isEdited`.
- An empty observation (a message only partly rendered) is ignored.
- Each batch is written in one IndexedDB transaction, so a failed batch leaves nothing half-written.

## Timeline order

`sortKey` is epoch milliseconds. Its sources are ranked: the Teams id, then an exact timestamp, then interpolation between rendered neighbours, then the order of observation. Only the first two are *reliable*, which means they're comparable across sessions. Coverage, conversation date ranges and incremental logic use reliable keys only.

## Coverage, updates and resuming

Each conversation stores *coverage*: ranges of the timeline (in sort-key space) that were captured without gaps. `reachedBeginning` marks the range that goes back to the start of the chat.

- **Contiguity.** Every window must contain the oldest message of the previous window (the *anchor*), or span its timestamp. If a scroll step jumped past unseen messages, the engine scrolls back part of the way and halves the step. The step grows again after ten clean passes. If a gap can't be closed after four tries, coverage is split there and a warning is recorded.
- **Persistence.** Each batch carries the session's segments so far, and they are merged into coverage in the same transaction as the messages. After a failure, only segments that were actually stored are reported.
- **Full history** without rescan stops as soon as it has re-seen enough messages from a range that reaches the beginning (`history-complete`). Otherwise it continues to the top (`reached-top`), moving through covered ranges at the faster *seek* interval.
- **Update** stops after re-seeing *N* archived messages (`incrementalOverlap`) in a connected window.
- **Resume** is a Full-history run with `resumeOf` pointing at the interrupted session. Thanks to coverage it skips quickly to where the previous run ended.

## Sessions

```
begin ─▶ running ⇄ paused ─▶ completed | stopped | failed      (reported by the tab)
            │                       ▲
            └──▶ interrupted ───────┘ (revived by a later batch or heartbeat from the same, still running tab)
```

- The tab sends a heartbeat every 15 s while a run is active.
- The background marks running or paused sessions as `interrupted` when their heartbeat is older than 90 s (checked at browser start-up, on install and update, and whenever a session begins), or immediately when their tab closes.
- `completed`, `stopped` and `failed` are final. A heartbeat or batch that arrives late doesn't reopen a session.
- The controller stops heartbeats before it reports the end of a session.
- Batches and the end report are retried with back-off (0.25 s, 0.75 s, 2 s, 4 s). Errors such as an invalidated extension context aren't retried.

## Loop guards

A run always ends. The engine stops when any of these happens:

- the step limit (`maxSteps`) or the time limit (`maxDurationMinutes`) is reached;
- `maxStallPasses` passes in a row bring no new message;
- the open chat changes (checked before and after every pass);
- the message list disappears.

"Reached the beginning" requires three things in a row, `maxNoProgressPasses` times: scrolling up didn't move, the list really is at its top, and nothing new arrived after waiting up to `topLoadTimeoutMs` for older history. The engine also nudges the list down and back up to trigger Teams' history loader. A list that refuses to scroll is reported as "no progress", never as a complete history.

## Database

IndexedDB database `teams-chat-archive` (`storage/schema.ts`), version 1:

| Store | Key | Indexes |
| --- | --- | --- |
| `conversations` | `conversationKey` | none |
| `messages` | `key` | `byConversationSort` [conversationKey, sortKey]; `byConversationFingerprint` [conversationKey, fingerprint]; `byAlias` aliases (multi-entry) |
| `sessions` | `sessionId` | `byConversationStarted` [conversationKey, startedAt]; `byStatus` status |
| `meta` | `key` | none (reserved) |

Versioning:

- To change the stored shape, add a migration step to `upgradeArchiveDb`, bump `DB_VERSION` and `ARCHIVE_SCHEMA_VERSION`, and never edit a released step.
- Bump `EXTRACTOR_VERSION` when parsing changes could alter extracted values. Records carry the version that last wrote them, so a re-parse after an upgrade isn't mistaken for an edit.

## Security

- Host permissions and content scripts are limited to `teams.microsoft.com`, `teams.cloud.microsoft` and `teams.live.com`.
- The extractor only reads the DOM of the open chat. The only page interaction is scrolling the message list.
- The background accepts requests only from Teams tabs and the extension's own pages. The content script accepts commands only from this extension.
- Message HTML is re-serialised through a tag and attribute allow-list, and only `http(s)`, `mailto` and `tel` links are kept. The UI writes text through `textContent` only.
- There is no remote code, no `eval` and no network access.
- Diagnostics reports hold counts and a redacted page skeleton. They contain no text, names, message ids or thread ids.

## Integrating with a knowledge management system

The scraper doesn't need to change for this.

- **Files**: use the export format ([EXPORT_FORMAT.md](EXPORT_FORMAT.md)). Ingest by `key`, which is stable and unique, and compare `contentHash` to detect changes. Exports can be repeated at any time.
- **In-extension sync**: a future module in `background/` can read the archive through `ArchiveRepository` (`listConversations`, `getMessages`, or the streaming `forEachMessage`) and use `lastExtractedAt` / `lastSeenAt` to find what changed. The natural trigger point is `session/end` in `background/router.ts`.
- **New file formats**: add a serialiser next to `toJson` / `toNdjson` / `toMarkdown` in `export/exporters.ts`.
