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
                    │ status                       │  popup, side panel, archive page and     │
                    └──────────────────────────────┤  save page (ui/) read it directly        │
                                                   └──────────────────────────────────────────┘
```

The content script runs inside the Teams page, so it can't open the extension's own IndexedDB. It sends every captured batch, and the images displayed in it, to the background service worker, which owns all writes. The popup, side panel, archive page and save page belong to the extension origin and read the database directly. They control a running extraction by sending commands to the content script.

Only `background/service-worker.ts`, `content/content-script.ts` and `ui/` touch `chrome.*` APIs. Everything else (extractor, engine, storage, export, router and controller) receives its dependencies as parameters. That is why the complete pipeline runs in the test suite under jsdom and fake-indexeddb.

```
shared ◀── extractor ◀── scraper ◀── content
shared ◀── storage   ◀── background, export, ui
```

## One extraction pass

1. **Identify the chat** (`extractor/conversation.ts`). The Teams thread id comes from the highlighted chat-list entry, then the URL, then other page hints (`threadIdHints`). Teams Web shows it in the id of the chat header (`chat-header-<threadId>`) and in the value of the header's Chat tab; its chat list marks no entry as selected, and its URL holds no id. It becomes the archive key `teams:<threadId>`. Without a thread id the normalised title is used (`title:<title>`). When a run begins, this detected key is resolved to an archive entry, which can have another key (see [Finding a chat's archive entry](#finding-a-chats-archive-entry)). The thread id also gives the chat type (`@unq.gbl.spaces` → 1:1, `@thread.v2` → group, `19:meeting_` → meeting, `@thread.tacv2` → channel).
2. **Collect the rendered items** (`extractor/page-parser.ts`). Message containers, date dividers and system messages, in document order.
3. **Parse each item** (`extractor/message-parser.ts`):
   - the Teams message id (`data-mid`, `content-<id>`, `timestamp-<id>`, …);
   - the author and the self-message marker;
   - the timestamp (`<time datetime>`, then `title`, then `aria-label`, then the visible label combined with the nearest date divider);
   - the body (`content-serializer.ts`: paragraphs, lists, line breaks, mentions, links, emoji, sanitised HTML);
   - the quoted reply (`parseReply`): its sender, time and words. Teams Web shows the sender as the text just before the quoted time, without a test id of its own. When a reply quotes several messages, the first is kept; every quote is left out of the reply's text;
   - attachments, the edited marker and deleted messages;
   - reactions (`parseReactions`): each pill's emoji (from a picture's alt text, the text, or a name in its accessible name such as "Like reaction"), its count and whether it is pressed (yours). Pills inside a quoted reply are skipped, an emoji is kept once, and reaction pills are never taken for attachments. The selectors (`reaction` in the profile) were checked against Teams Web in November 2026: the emoji is a picture's alt text, the count is in the pill's text, and `aria-pressed` marks yours.

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
   - Save the images displayed in the window that weren't saved yet (see [Images](#images)) and link them from their attachments.
   - Send new or changed messages to storage.
   - Scroll up (animated over `scrollAnimationMs` so the list glides; `scroll-driver.ts` applies it frame by frame as relative moves, so Teams' own position corrections survive), wait until the page has settled (`settle.ts`: no DOM mutations for a quiet period and no loading spinner), and repeat.

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
- Reactions are not part of `contentHash` or the fingerprint, so a new reaction is never an edit. An observation that shows reactions replaces the stored list; one that shows none leaves it, because a message can be drawn before its reactions. So a list emptied in Teams stays as last seen. Folding a duplicate or importing keeps the surviving (newer) record's reactions, or the other record's when it has none, and `normalizeStoredMessage` repairs reactions read from a file (`shared/reactions.ts`). Reactions are part of the engine's message signature, so a message whose reactions appear later in a run is sent again.
- Each batch is written in one IndexedDB transaction, so a failed batch leaves nothing half-written.

## Finding a chat's archive entry

A title is a weak identity: Teams chats can be renamed, and two chats can have the same title (two people with the same name, or a recurring "Weekly sync"). So when a run begins, the tab sends the detected identity together with *evidence*: the ids and content hashes of up to 60 of the newest messages on screen that have a Teams id (`identityEvidence` in `extractor/page-parser.ts`). `ArchiveRepository.resolveConversation` looks up three kinds of candidates:

- the entry under the detected key, or the entry it was merged into (`mergedInto`);
- entries that list the detected key in their `aliases` (multi-entry index `conversations.byAlias`);
- entries that hold the messages shown (index `messages.byMessageId`). Such an *overlap* is strong when the entry holds at least two of the ids, or one with the same content.

`decideConversation` (`storage/conversation-identity.ts`) then picks one:

| Detected | Result |
| --- | --- |
| Thread id | The entry under `teams:<threadId>`, else an entry with that thread id that lists the key as alias, else the entry with the strongest overlap that has no other thread id, else the most recently extracted entry under the chat's title key, or listing it as alias, that has no thread id and doesn't contradict the evidence (reason `title`: a chat archived by its title before its id was read), else a new entry. An entry with another thread id is never used. |
| Title only | The entry with the strongest overlap (a renamed chat). Else the entry under the title key, unless it *contradicts* the evidence. Else the most recently extracted entry that lists the key as alias and doesn't contradict it. Else a new entry: under the title key if no entry uses it, otherwise under `local:<uuid>`, so that another chat with this title doesn't mix with the archived one. |

An entry contradicts the evidence when it holds at least two messages with ids from the time span shown and none of them is shown: Teams shows every message of that span, so the entry belongs to another chat. Only ids are compared, because short messages such as "ok" have the same content in many chats. Messages newer than everything archived contradict nothing, since they may be new messages of the archived chat. With no messages with ids on screen, the title decides, as before version 1.2.

The run then writes under the resolved key. The session remembers the detected key (`detectedKey`) when it differs, and each batch adds it to the entry's `aliases`, so the next run finds the entry under that key directly. Every title an entry was archived under is kept in `titleHistory` (first and last seen, the 50 most recent titles). A name given on the archive page (**Rename**) is stored as `displayName`; the archive and the exports show it instead of the title.

The popup resolves the open chat the same way. It shows which entry a run will write to, and mentions other entries that hold the same messages, so they can be merged.

## Merging entries

Before version 1.2 one chat could end up in two entries, for example before and after Teams renamed it, and a renamed chat that shows no archived messages still gets a new entry. The archive page merges two entries (`ArchiveRepository.mergeConversations(source, target)`). A large chat doesn't fit one transaction, so a merge runs in steps and keeps a journal (`merge:<sourceKey>` in the `meta` store):

1. One transaction checks the merge, sets the source's `mergedInto`, adds the source key and its aliases to the target's `aliases`, and writes the journal. From then on, runs for the chat go to the target.
2. Messages move in transactions of 200 (`rekeyMessage`). A message with a Teams id becomes `<target>#<messageId>`. A strong fingerprint is computed again under the target key and keeps its occurrence suffix (`~N`), so a later run of the target produces the same key. A weak fingerprint can't be computed again and keeps its hash under the target prefix. The old key goes into the message's `aliases`. A message the target already holds is merged like a repeated observation, so it is kept once.
3. Images move in transactions of 20, then sessions. A moved session keeps the source key in `detectedKey`.
4. A last transaction combines the two conversation records (titles, aliases, coverage, participants, dates), recounts the messages, and deletes the source and the journal. Quoted replies are then linked again.

If the page closes midway, the journal remains, and the archive page finishes the merge the next time it opens (`resumePendingMerges`). Until then the source is listed as being merged and can't be renamed, merged or deleted. A merge is refused into the entry itself, for an entry that is missing or already part of another merge, for entries with different thread ids, and while a run of the source has reported in the last 90 seconds.

The merge dialog lists first the entries that share messages with the source (`entriesSharingMessages`, which compares the 100 oldest and the 100 newest messages of the source by Teams id), then those with a similar name. The user always chooses the target; nothing is merged automatically.

A message with neither a Teams id nor an exact time has a weak fingerprint made under the key of the entry it was first archived in. The page parser also computes it under the keys of the entries merged into the open chat's entry (`ConversationIdentity.mergedKeys`), so a later run recognises such a message after a merge. If both entries had archived the same message of this kind, the merge keeps both copies, because nothing tells them apart from two equal messages.

## Images

The page parser reports every image a message displays (`PageParseResult.images`: the message key, the index of its attachment and the `<img>` element). Emoji images are text and are excluded. `scraper/images.ts` (`ImageCapture`) then does the rest for each pass:

1. **Once per address.** It keeps a per-session cache by the address the image is shown from (`currentSrc`). An address already saved only gets its `imageId` set again. One that failed isn't retried in the same session.
   Before that, unless the run re-reads archived parts, the engine asks the background once per message (`session/archived-images`, answered by `ArchiveRepository.archivedImages`) which archived messages already have saved images. A message shown with the same `contentHash` and the same number of attachments takes those `imageId`s, and its images aren't read again. An edited message, or one archived before its images were saved, is read as usual. If the lookup fails, the images are simply read.
2. **Read.** It reads the bytes through an injected `ImageReader`, so the engine never touches `chrome.*` and tests use a fake one. The real reader (`content/image-reader.ts`) waits for the image to finish loading. It then fetches the address with `cache: 'force-cache'`: `blob:` and `data:` addresses are the page's own copy, and a web address normally comes from the browser cache. For other sites it tries with, then without, cookies. If the address can't be fetched, or doesn't return an image, it draws the displayed picture on a canvas and encodes it as PNG. A canvas "tainted" by an image from another site can't be read, so such an image fails.
3. **Limits.** Images above `maxImageMB` fail as *too large*. Images still loading are tried again in the next passes (3 attempts) and count as failed if they never load, including when the session ends.
4. **Name.** `imageId` is the SHA-256 (hex) of the bytes, from `crypto.subtle`. The same picture under two addresses is stored once.
5. **Store first.** New images go to the background (`session/images`) *before* the batch whose messages refer to them, so a stored attachment never points at a missing image. Only images the background confirms are linked (`attachment.imageId`) and counted in `imagesSaved`. Failures are counted in `imagesFailed` and reported once as a warning.

`imageId` is part of the engine's message signature, so a message seen before its image loaded is sent again once the image is saved. It isn't part of `contentHash` or the fingerprint: saving an image isn't an edit. When merging, attachments keep an existing `imageId` and take one from the other copy when they have none. Images are matched by name *and* position among the images of that name, because Teams names most pasted pictures `image` (`storage/merge.ts`).

**Messaging.** Extension messages are JSON (at most 64 MiB), so bytes travel as base64 (`CapturedImage.dataBase64`). The controller groups images into `session/images` requests of up to 16 MiB of base64 (`IMAGE_REQUEST_CHARS`). An image larger than that is sent as `session/image-part` requests in order. The router keeps the parts in memory (`ImageUploads`) until the last one arrives. If the worker restarted in between, it answers `restart` and the tab sends the image again from the first part. For every image the router checks that the session exists for this conversation, the type is `image/*`, the size is within the limit, the base64 decodes to `byteLength` bytes and their SHA-256 equals `imageId` (`shared/images.ts`, `storage/images.ts`). It reports refused images per id instead of failing the request, so one bad image can't stop a run.

## Timeline order

`sortKey` is epoch milliseconds. Its sources are ranked: the Teams id, then an exact timestamp, then interpolation between rendered neighbours, then the order of observation. Only the first two are *reliable*, which means they're comparable across sessions. Coverage, conversation date ranges and incremental logic use reliable keys only.

## Coverage, updates and resuming

Each conversation stores *coverage*: ranges of the timeline (in sort-key space) that were captured without gaps. `reachedBeginning` marks the range that goes back to the start of the chat. When ranges are merged, the merged range keeps the mark only if the range that goes furthest back had it, and only the oldest range of a conversation keeps it: a message older than a marked beginning shows the mark was wrong. The history is *complete* when the oldest range has the mark and reaches the newest archived message; when it has the mark but newer ranges follow, the popup and the archive say *Has gaps* and name the gap.

- **Contiguity.** Every window must contain the oldest message of the previous window (the *anchor*), or span its timestamp. If a scroll step jumped past unseen messages, the engine scrolls back part of the way and halves the step. The step grows again after ten clean passes. If a gap can't be closed after four tries, coverage is split there and a warning is recorded.
- **Holes.** A full run (the full history or a period) that would finish while the ranges of the archive and of the run still have a hole between them (`holeToFill`: newer than the oldest message the run reached, and than `since`) first goes back for it (`fillHole`). It closes its current stretch (marked as reaching the beginning when it finishes at the top), scrolls down without storing until a message at or after the hole's newer edge is shown (waiting at the end of the list for Teams to add newer messages, as it does after a jump to a search result), and walks up from there with fresh contiguity. It finishes as it was about to once the walk joins the stretch below the hole, and drops the split warning. At most `MAX_FILL_SWEEPS` (3) times; if Teams shows no newer messages, it finishes with the hole and a warning. Holes typically come from the view jumping during a run (a search result, a quoted message), or from a run started while the chat showed an older part.
- **Persistence.** Each batch carries the session's segments so far, and they are merged into coverage in the same transaction as the messages. After a failure, only segments that were actually stored are reported.
- **Seeking.** A window that lies entirely inside a covered range is passed at the faster *seek* interval and with a short animation (`counters.seekPasses`). A full run without rescan also takes steps of `SEEK_STEP_RATIO` (2) viewport heights there, which skips messages. A window below the anchor that doesn't overlap it is then still *connected* when its newest exact message and the anchor lie in one covered range: the archive already holds what lies between them (`bridgedByArchive`). A step that goes past the end of the covered range makes a real gap, which is closed as above; it halves only the seek step. Updates never skip: they read every message of their window.

### Capture ranges and updates

A run can be given `since` (`EngineOptions.since`, the session's `captureFrom`): the oldest message time it has to reach. The popup's choices map to runs in `shared/capture.ts`:

| Choice | Mode | `since` |
| --- | --- | --- |
| New messages | `incremental` | The last update's newest message (else the newest archived message) minus `updateOverlapDays`, computed by the router at `session/begin`. |
| Date range: 24 hours / 7 days / 30 days | `full` | Now minus that period. |
| Date range: from a date | `full` | Midnight local time of that day. |
| Full history | `full` | none |
| (no longer offered by the popup since 1.11) | `visible` | none: the messages on screen, without scrolling. The engine keeps the mode, and runs of it archived earlier still show as *On screen*. |

How runs end:

- **Full** with `since` (a period) stops when its connected window reaches back to `since` (`range-reached`), or as soon as it has re-seen enough messages (`incrementalOverlap`) from a covered range that reaches back to `since` (`history-complete`). Otherwise, and always without `since` (the full history), it continues to the top (`reached-top`): a range marked `reachedBeginning` may have been marked too early, when Teams was too slow to load, so the full history passes it and checks the beginning again. Newer messages passed on the way are always saved: a period has no end date, so it can't leave a hole between itself and the present.
- **Update** stops after re-seeing *N* archived messages in a connected window *and* reaching back to `since` (`overlap-reached`). The overlap window re-reads the days before the last update, so edits, deletions and late replies there are recorded with the usual version history. Without `since` (nothing archived) it runs like Full history.

**Last update.** `ConversationRecord.lastUpdate` (`{ sessionId, mode, at, newestSortKey }`) is the most recent run that brought the archive up to date. At `session/begin` the router notes where the archive was up to date (`SessionRecord.continuesFrom`: the last update's newest message, else the newest archived message, else null). At `session/end` (`ArchiveRepository.recordRunEnd`) the run becomes the last update when the coverage range holding the newest message it reached also holds `continuesFrom` or reaches the beginning (`coverage.ts` `caughtUp`; with `continuesFrom` null any range counts). Visible-only runs never count. Stopped and failed runs count when they got that far, because coverage only records what was stored. A run that leaves a gap doesn't count, so the next update still goes back to the previous one. Merging and importing keep the last update that reached the newer message (`laterUpdate`).

**Resume** starts a run like the interrupted one (same mode, `rescan` and `captureFrom`) with `resumeOf` pointing at it. Thanks to coverage and seeking it passes quickly to where the previous run ended. Teams Web loads history only from the newest message backwards, so a resumed run can't jump: it passes everything newer, at the speed Teams loads it.

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

**Saving a file when a run ends.** A run begun with **Save a file** ticked carries the choices (`SessionRecord.save`: a format and what to include). When the tab reports the end (`session/end`), the router opens the save page (`save.html#session=<id>`) in a new tab next to the Teams tab, if the run completed or stopped on its own (`savesFileAfter`: not after **Stop**, a failure or an interruption) and the session had not ended before, so a retried end report opens no second page. The page is opened by the background, not by the popup, so the file is saved also when the popup was closed during the run. The end report's answer says whether a page was opened (`savingFile`), and the popup says so in its result.

## Loop guards

A run always ends. The engine stops when any of these happens:

- the step limit (`maxSteps`) or the time limit (`maxDurationMinutes`) is reached. The time limit counts working time: time paused or waiting for the tab to be shown is left out, and so is any gap longer than `MAX_COUNTED_GAP_MS` (5 minutes) between two looks at the clock, which is the computer asleep or hibernating, so a run that wakes up does not stop at once and save its file;
- `maxStallPasses` passes in a row bring no new message;
- the open chat changes (checked before and after every pass);
- the message list disappears.

"Reached the beginning" requires three things in a row, `maxNoProgressPasses` times: scrolling up didn't move, the list still is at its top, and nothing new arrived after waiting up to `topLoadTimeoutMs` for older history. The engine nudges the list down and back up to trigger Teams' history loader, a little further each time (a quarter, three quarters, then one and a half viewport heights). On top of the attempts, it must have waited at the top for a time of work of at least `maxNoProgressPasses` × `topLoadTimeoutMs` (a change elsewhere on the page can end one attempt's wait early) and three times the slowest load of older messages so far in the run, but at most `MAX_TOP_WAIT_MS` (10 minutes). An attempt while Teams shows its loading indicator doesn't count, until that maximum. Passes at the top don't count as stalls. After 5 seconds at the top the progress says so (`waitingForOlder`), and the popup shows *Waiting for Teams to load older messages…*. A list that refuses to scroll is reported as "no progress", never as a complete history.

## Database

IndexedDB database `teams-chat-archive` (`storage/schema.ts`), version 3:

| Store | Key | Indexes |
| --- | --- | --- |
| `conversations` | `conversationKey` | `byAlias` aliases (multi-entry) |
| `messages` | `key` | `byConversationSort` [conversationKey, sortKey]; `byConversationFingerprint` [conversationKey, fingerprint]; `byAlias` aliases (multi-entry); `byMessageId` messageId |
| `sessions` | `sessionId` | `byConversationStarted` [conversationKey, startedAt]; `byStatus` status |
| `meta` | `key` | none. Holds the journals of unfinished merges (`merge:<sourceKey>`). |
| `images` | `key` (`<conversationKey>#img:<imageId>`) | `byConversationImage` [conversationKey, imageId] (unique) |

History:

- Version 1 (extension 1.0): `conversations`, `messages`, `sessions` and `meta`.
- Version 2 (extension 1.1): adds the `images` store. The upgrade only creates the new store, so all existing records stay as they are. Messages stored before it simply have no `imageId` on their attachments.
- Version 3 (extension 1.2): adds the indexes `conversations.byAlias` and `messages.byMessageId`. The upgrade only creates indexes, so all records stay as they are. The new conversation fields (`aliases`, `mergedFrom`, `mergedInto`, `titleHistory` and `displayName`) are optional: a record written before simply lacks them, which reads as empty, and gets them the next time a run writes it. Messages without a Teams id aren't in `byMessageId`.
- Extension 1.3 adds optional fields without a database upgrade: `lastUpdate` on conversations, and `captureFrom` and `continuesFrom` on sessions. Records written before lack them: a conversation without `lastUpdate` continues from its newest archived message, and a session begun before 1.3 never becomes a last update.
- Extension 1.4 (exports and streaming import) changes nothing in the database.
- Extension 1.7 adds the optional `reactions` field to messages, without a database upgrade. A message written before lacks it, which reads as no reactions, and gets it the next time a capture sees its reactions. `EXTRACTOR_VERSION` is 1.2.0 from this release.
- Extension 1.8.1 reads the thread id from the chat header, without a database upgrade. A chat archived before under its title key is found under that key (reason `title`); the first batch of the run gives the entry the thread id and the type, and adds `teams:<threadId>` to its aliases, so the next run finds it by alias. The entry keeps its key. `EXTRACTOR_VERSION` is 1.3.0 from this release, because quoted senders are now read.
- Extension 1.9 adds the optional `save` field to sessions (the file to save when the run ends), without a database upgrade. A session begun before lacks it, which reads as no file.

`tests/integration/migration.test.ts` opens a version 1 and a version 2 database with data, and checks that everything survives the upgrade.

Images are written idempotently: an image that already exists under its key is left unchanged. Deleting a conversation deletes its images too.

Versioning:

- To change the stored shape, add a migration step to `upgradeArchiveDb`, bump `DB_VERSION` and `ARCHIVE_SCHEMA_VERSION`, and never edit a released step.
- Bump `EXTRACTOR_VERSION` when parsing changes could alter extracted values. Records carry the version that last wrote them, so a re-parse after an upgrade isn't mistaken for an edit.

## Export and import

Everything in `export/` works on an `ExportReader` (`pipeline.ts`), which `ArchiveRepository` provides and tests replace with an in-memory one. No export holds a whole conversation in memory:

- `ArchiveRepository.messagePages(key, range)` reads a conversation's messages in timeline order, 500 at a time, limited to a period (`sortKey` from included, to excluded) through the `byConversationSort` index. `imageCatalog(key)` lists a conversation's images without their bytes, and `getImage` reads one when it is written.
- `runExport` reads each conversation twice. A first pass counts the messages it will write, finds their reliable oldest and newest times, the pictures they show (in order of appearance) and the messages that replies point to without quoting them. The second pass writes, page by page.
- Text goes to a `BlobSink` (`sink.ts`), which turns it into a `Blob` every 4 MB, so the browser can keep a large export on disk instead of in one string. ZIPs are written by `ZipWriter` (`zip.ts`): files are stored, written in parts (several at once), and placed in the archive when closed; the central directory comes last.
- The renderers (`render.ts`) turn a conversation header, a day heading and a message into HTML (for the page that is printed as a PDF), Markdown (the package's transcript) or text. Pictures come from a `PictureSource`: written once as files into a ZIP, embedded as `data:` addresses, or shown from object URLs for printing.
- `options.ts` holds the model of a file: the four formats offered (`SAVE_FORMATS`: PDF, text, JSON, ZIP package) on top of the formats the pipeline writes (`FORMATS`), the packaging a choice gives (`packagingOf`: text with pictures is a ZIP), what the records always keep (`fixedContent`: attachments and replies, which are part of `contentHash`), the period of a capture's file (`sessionSaveRange`), and the save page's address (`saveTargetHash`, `parseSaveTarget`). Records leave out what was not chosen (`exportedMessage`): earlier versions without edit history, `reactions` without reactions. Records of a part of a conversation (`exportedRecord`) count what they hold and limit `coverage` to the period (`clipCoverage`), so importing them never claims history they lack.
- The choices are kept in `chrome.storage.local` (`exportChoices.v1`, the key earlier versions used for the Export section) and repaired when read (`normalizeSaveChoices`): a format no longer offered becomes PDF. The popup and the archive page draw them with one form (`ui/save-form.ts`).

**The save page** (`ui/save.html`, `save.ts`) writes every file, in a tab of its own, so a large file is not cut off when the popup closes. Its address names what to save: `#session=<id>` (the file of a run, with `sessionSaveRange`), `#chat=<key>&format=…&include=…&from=…&to=…` (one chat, from the popup's **Save a file from the archive only** or a chat's **Save a file…**), or `#all=1&format=…&include=…` (every chat, from **Back up now**). It shows what it saves and the progress, then:

- for PDF, writes the printable page into a frame on the page, waits for its pictures and opens the print dialog; **Print again** opens it once more;
- for the other formats, runs `runExport` and downloads the file. When the file is a full backup (`isFullBackup`: an importable format, every archived conversation, the whole period and all content), it records the time and totals in `lastBackup.v1` (`ui/last-backup.ts`), which Backup and import shows.

Nothing is saved when the period holds no messages. For a run's file it records the file's name, or the problem, in `lastSave.v1` (`ui/last-save.ts`), which the popup reads to name the file in its result.

**Import** (`import.ts`) tells a ZIP from JSON by its first bytes and reads both in parts:

- JSON goes through `ArchiveJsonScanner` (`json-scanner.ts`), a streaming reader for the export's layout. It reports the header, each conversation's fields, each message and each image as they complete, keeping only the current value's text, so a file of any size is read in pieces of the file's chunks.
- A ZIP package goes through the ZIP reader (`zip-reader.ts`), which reads the central directory and then one file at a time, stored or deflated (`DecompressionStream`), checking each file's CRC-32 and size. `messages.jsonl` is read line by line.
- Both are read twice. The first pass checks everything (every record, and every image's bytes against its size and SHA-256), so a damaged file is refused before anything is written. The second pass writes conversation by conversation through `ConversationImport`: it finds the archive entry of the chat (as described in [Finding a chat's archive entry](#finding-a-chats-archive-entry)), rekeys the records if needed, and writes messages in batches of 500 and images through the repository.

**An interrupted import** (the tab closed, the browser stopped) leaves no hidden messages. `ArchiveRepository.beginImport` first writes the conversation's entry, with its identity but no coverage or last update; `importMessages` writes each batch in one transaction with the entry's message count; `finishImport` merges coverage and the last update and recounts. A conversation cut off in the middle is therefore listed, with the messages written so far, as partial, and importing the file again completes it without duplicates. `archivedImages` reports a message's images as saved only when they are stored, so a run after an import that stopped between messages and images reads those images again.

## Release

`npm run package` (`scripts/package.mjs`) builds `dist/` with `scripts/build.mjs --release` (no source maps), checks that the manifest version equals `package.json`'s, that no source map is left and that the required files are there, and writes `release/teams-chat-scraper-<version>.zip` with the same ZIP writer the exports use (`export/zip.ts`, bundled by esbuild for Node). `release/` is not committed. What to enter in the store is in [STORE_LISTING.md](STORE_LISTING.md), and the privacy policy is [PRIVACY.md](PRIVACY.md).

## User interface

The popup and the side panel are one page (`ui/popup.html`, `popup.ts`; the build writes `sidepanel.html` from it with `data-mode="panel"`). It polls the content script of the active Teams tab once a second and resolves the open chat's archive entry as a run would. The capture choices are three tiles (**Messages to capture**, the radio group `capture`: new messages, a date range, the full history); **Date range** shows the **Period** segments under them (`capture-period`), and **From a date** a date field. `selectedChoice()` turns the two into the `PopupChoice` of `shared/capture.ts`, so a run starts as before. Under them, **Save a file** (remembered in `saveAfterCapture.v1`) shows the save form: the format, a line saying what it makes, and what to include. The button in the bar at the bottom (`position: sticky`, just above the status bar) names what it will capture and save (`startLabel`), and sends the choices with `content/start`; **Save a file from the archive only**, under the include list, opens the save page for the chat without capturing. The status bar (`renderStatusBar`) says whether the popup reaches the tab and how many messages it shows, or during a run the phase, the time so far and the messages seen; its dot repeats the words. An interrupted run puts **Resume extraction** in the button's place until **Start another capture instead** is clicked; resuming saves the file the interrupted run would have. During a run the progress and **Stop** take the place of the capture and file cards (`#actions`); for a capture with a start date, a bar shows the share of the way back the run has reached (`reachShare` in `view-models.ts`, from the session's `captureFrom` and the progress's `oldestReached`). The result says which file was saved (from `lastSave.v1`, which it follows through `chrome.storage.onChanged`) and links to the chat. The header's theme button (`ui/theme-button.ts`, shared with the archive page) steps through Same as Windows, Light and Dark (`nextTheme`).

The archive page (`ui/archive.html`) shows either the page, with its parts one under the other, or one chat. The address chooses which, and the part to bring into view:

| Address | Shows | Code |
| --- | --- | --- |
| `#conversations` (and anything unknown) | The list: search, type filter, sorting | `archive/conversations.ts` |
| `#backup` | Backup and import: the last full backup, **Back up now**, **Import archive…**, the totals | `archive/backup.ts` |
| `#settings`, `#settings/advanced` (Advanced open) | Settings | `archive/settings-view.ts` |
| `#conversation/<key>` | One chat's messages and its actions | `archive/conversation-view.ts`, `archive/conversations.ts` |

Addresses of earlier versions lead to their new place (`parseRoute`): `#overview` and `#export` to Backup and import, `#export/<key>` to that chat, and every `#settings/…` to Settings.

- `archive.ts` is the router. It shows the page or the chat, sets the document title, brings the part named into view, moves the focus to its heading, and keeps one status line (`notify`; a message sent with `carry` survives the navigation it causes). While a section is drawn it is marked `aria-busy`, and "Reading the archive…" shows if that takes more than 200 ms (and when the page opens). Button actions go through `guarded()`, which shows an error in the status line and ignores a click while the same action is still running. The parts share an `AppContext` (`archive/context.ts`): the repository, `notify`, `go(route)` and `refresh()`.
- What the screens show is worked out in `ui/view-models.ts` without the page: routes (`parseRoute`, `routeHash`), search and filters, the one-line summary (`historyLine`), the archive's totals (`archiveTotals`), the backup line, and the message view (`messageView`, `timeline`, `earlierPage`). The section modules only draw it, through `el()` and text nodes; nothing is parsed as HTML.
- The message view holds only a chat's message keys (`ArchiveRepository.messageKeys`, from the `byConversationSort` index) and reads the messages of each page of 200 by key (`getMessagesByKey`). Pictures are read per page and shown from object URLs, which are revoked when the view closes. Each picture is drawn in a 240 × 160 box until its record is read, then at its recorded size scaled to fit 420 × 320 (`pictureBox`), set before its address so the list does not move when it loads. The view opens at the newest message, with **Back to the top** below it. Messages from one sender less than five minutes apart show the name once (`timeline` marks them `continued`; the name stays for screen readers).
- A chat's **Save a file…** asks in a `<dialog>` with the save form, then opens the save page for that chat. **Back up now** opens it for every chat as a ZIP package with all content.
- The formats, the capture tiles and the period are segments: radio groups, read as a whole on every change.
- Settings keep their stored keys. The scrolling speed (`SPEED_PRESETS`, `speedOf`, `withSpeed` in `shared/settings.ts`) is not stored: it is worked out from the six scrolling and waiting values, and is *Custom* when they match no preset.

**Themes.** `ui/ui.css` defines the design tokens (spacing, radii, type sizes, colours) as CSS variables. The dark colours are written twice: for *System* when the operating system is dark (`@media (prefers-color-scheme: dark)` on `:root:not([data-theme='light'])`) and for an explicit *Dark* (`:root[data-theme='dark']`); `tests/unit/logo.test.ts` checks that both say the same, that every text colour has a contrast of at least 4.5:1, and that `--control-border` (the outline of buttons, selects and fields; `--border` is for structure) has at least 3:1 against card and page. The choice is a display preference kept in the extension's `localStorage` (`ui.theme`), so `theme.js` (`ui/theme-boot.ts`) can read it synchronously in each page's `<head>` and set `data-theme` before anything is drawn. Open pages follow a change through the `storage` event. Every page sets it with the theme button in its header; *System* is labelled *Same as Windows*.

**Type and icons.** The pages use the system's Segoe UI, and Consolas for conversation keys and the selector overrides (`--font-sans`, `--font-mono`); no font is bundled. `tests/unit/interface-markup.test.ts` checks that no page or stylesheet loads anything over http(s) or declares a font file, that only `.mono` and `textarea` use the monospace font, and that the stylesheet uses the weights 400 and 600 only (Segoe UI has no medium). The build copies `ui/licenses/` (Lucide's ISC licence) into `dist/licenses/`. Icons are SVG elements built by `ui/icons.ts` (`icon()`, never parsed markup); the pages ask for one with `data-icon="<name>"`, which `placeIcons()` fills when the page starts, and the same test checks that every name asked for exists. `ui.css` draws every line 1.5 px wide whatever the icon's grid and size (`vector-effect: non-scaling-stroke`).

**Accessibility.** Every page has a skip link, visible focus (`:focus-visible`), visible labels on every field and icon buttons with names; the status line, run progress and results are live regions. Controls, segments and tiles included, are at least 32 px tall, and 44 px under `(pointer: coarse)`; segments and tiles are native radio groups, so the arrow keys move between options; enabled controls show the hand cursor, disabled ones *not allowed*, a pressed button a heavier bottom edge, and a chosen segment or tile a ring two lines wide. Links that act as targets (a chat's name, **All conversations**, **Open this chat in the archive**) follow the same 32 / 44 px rule. Below 760 px each table row becomes a short card (`table.cards`): its first cell sums the row up in a line or two (`.narrow-only`), and the cells that repeat it are hidden (`td.wide-only`), so nothing scrolls sideways; the popup and side panel fit from 300 px. Rename, Delete and **Save a file…** ask in `<dialog>` elements, not `prompt()` or `confirm()`; Delete opens with the focus on Cancel.

## Security

- Host permissions and content scripts are limited to `teams.microsoft.com`, `teams.cloud.microsoft` and `teams.live.com`.
- `power` and `alarms` only keep the computer awake during a capture: the router calls `syncKeepAwake` when a session begins, sends a heartbeat or ends, and the service worker requests `chrome.power.requestKeepAwake('display')` while a session is running (not paused) with a recent heartbeat, and releases it otherwise. While it is held, a one-minute alarm marks sessions that went quiet (a reloaded tab) as interrupted and releases it when none is left.
- The extractor only reads the DOM of the open chat. The only page interaction is scrolling the message list. Reading an image waits for its `load` event but changes nothing on the page.
- The background accepts requests only from Teams tabs and the extension's own pages. The content script accepts commands only from this extension.
- Message HTML is re-serialised through a tag and attribute allow-list, and only `http(s)`, `mailto` and `tel` links are kept. The UI writes text through `textContent` only.
- There is no remote code and no `eval`. The only network access is re-reading images that the open chat displays, normally from the page's own copy or the browser cache (see [Images](#images)). It is off when **Keep the pictures shown in messages** is off.
- Saved images are shown on the archive page (the message view and the image dialog) only as `<img>` elements from `blob:` addresses, so image content (an SVG, for example) can't run scripts there.
- The page that becomes a PDF is the escaped HTML transcript, without scripts, written into a frame on the save page.

## Integrating with a knowledge management system

The scraper doesn't need to change for this.

- **Files**: use the ZIP package or the JSON file ([EXPORT_FORMAT.md](EXPORT_FORMAT.md)). The package holds the records as JSON Lines, the pictures as files named by their SHA-256 and a Markdown transcript per chat, so it serves both systems that ingest records and systems that index documents. Ingest by `key`, which is stable and unique, and compare `contentHash` to detect changes. Files can be saved again at any time, also of a period (a capture of the last 7 days, for example) to fetch what is new. A merge of two entries gives the moved messages new keys and lists the old ones in their `aliases` (see the format's [identity changes](EXPORT_FORMAT.md#identity-changes)).
- **In-extension sync**: a future module in `background/` can read the archive through `ArchiveRepository` (`listConversations`, `messagePages`, or `runExport` with a period) and use `lastUpdate`, `lastExtractedAt` or `lastSeenAt` to find what changed. The natural trigger point is `session/end` in `background/router.ts`.
- **New file formats**: add a renderer in `export/render.ts` and an entry in `RENDERERS` (`export/pipeline.ts`) for a transcript, or a writer next to `writeJson` and `writePackage` for records; add the format to `FORMATS` in `export/options.ts`, and to `SAVE_FORMATS` and the save form (`ui/save-form.ts`) to offer it.
