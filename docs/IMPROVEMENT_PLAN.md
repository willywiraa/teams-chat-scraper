# Audit and improvement plan

Audit of version 1.1.0 (commit `62278d6`, 21 November 2026), before any of the requested changes. Nothing in the code has been changed for this report.

## 1. Baseline

| Check | Result |
| --- | --- |
| Type check (`tsc --noEmit`, strict) | Clean |
| Tests (Vitest, jsdom, fake-indexeddb) | 179 passed in 20 files |
| Production build (esbuild) | Builds `dist/` without warnings |
| Working tree | Clean, on `main` |

**Architecture.** The content script in the Teams tab parses the DOM and runs the scroll engine. It sends each scroll step's messages to the background service worker, which is the only writer to IndexedDB. The popup, side panel and archive page read IndexedDB directly. The code is TypeScript with no runtime dependencies and no UI framework. The extraction, storage and export logic is dependency-injected and covered by unit and integration tests; the pages themselves are not (see 2.9).

**Database** (`teams-chat-archive`, version 2). It holds `conversations`, `messages` (indexed by conversation and time, by fingerprint, and by alias), `sessions`, `meta` and `images`. Images are stored per conversation by the SHA-256 of their bytes. Migrations only add things. The upgrade from version 1 to 2 is tested to keep all records.

**Exports today.**

- **JSON**: lossless and importable, with images embedded as base64.
- **ZIP "chat + pictures"**: `chat.html`, `chat.md` and `images/`. This is a readable copy and can't be imported.
- **PDF**: opens a print page.

Commit `62278d6` removed NDJSON and the separate Markdown export.

## 2. Findings

### 2.1 Data integrity (your section 8)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Existing conversations survive upgrades | Holds | `migration.test.ts`: the version 1→2 upgrade keeps conversations, messages, sessions and meta data. |
| Captured images stay accessible | Holds | Images are content-addressed per conversation. Deleting a conversation also deletes its images. Tested. |
| Importing the same file twice adds nothing | Holds | `repository.test.ts`: round trips of messages and images are idempotent, and a damaged image means nothing is imported. |
| JSON keeps message relationships | Holds | It keeps `replyTo.resolvedKey`, `attachments[].imageId` → `images[]`, aliases and coverage. |
| ZIP keeps message relationships | **Only visually** | Replies appear as quoted text and pictures appear in place. There's no machine-readable data and no import. |
| Interrupted runs can be resumed | Holds | `pipeline.test.ts` covers an interrupted session that is resumed and completed without duplicates. |
| Migrations don't destroy records | Holds | Steps are additive. A released step is never edited. |

Gaps found:

- **G1. Large exports can fail.** JSON export builds the whole archive, base64 images included, as one string (`JSON.stringify(archive, null, 2)`). Import reads the whole file back with `file.text()`.
  - A JavaScript string holds at most 536,870,888 characters. That is V8's limit, checked in Node 24, and Edge uses the same engine.
  - Base64 makes pictures a third larger. "Export all" with images therefore fails once the archive holds roughly 400 MB of pictures, or less with a lot of text. Memory can run out sooner.

  This is the main obstacle to using exports for a knowledge system and for backups.
- **G2. No record of the last successful run.** `lastExtractedAt` changes with every batch, including runs that were stopped or failed.
- **G3. Renamed chats split.** A chat identified by its title starts a new archive entry when renamed. Two chats with the same title share an entry. Entries can't be merged (see 2.2).
- **G4. An interrupted import can leave hidden messages.** Import writes messages before the conversation record. If it is interrupted in between, those messages are invisible until the file is imported again. The risk is low and the fix is easy.

### 2.2 Conversation identification (your section 7)

**How it works now** (`extractor/conversation.ts`). The extension looks for a Teams thread id (`19:…@thread.v2`, `19:…@unq.gbl.spaces`, …) in three places, in this order:

1. the attributes of the highlighted chat-list entry;
2. the URL;
3. the chat header and message-list elements.

If none has it, the key is the normalised title (`title:<chat name>`), and the popup shows the warning.

**Why it fails for you.** New Teams (`/v2/`) no longer puts the chat id in the address bar. None of the selected-entry or header attributes we scan contain it either. I can't tell from here which of these is the case:

- (a) our selector doesn't match the highlighted entry in your Teams build;
- (b) Teams doesn't expose the id in the DOM at all.

That needs evidence from your tenant (Phase 0).

**What another exporter does.** The open-source [gediz/teams-web-chat-exporter](https://github.com/gediz/teams-web-chat-exporter) (MIT) does **not** take the chat id from the DOM. It reads the id from Teams' own session storage (navigation history), finds your user id in the sign-in library's local storage, and fetches messages from Teams' internal chat service with your token. Your constraints rule out all three. Its page selectors do give two leads we don't check yet: header elements with `id^="chat-header-"` and 1:1 people with `id^="chat-topic-person-"`. Their ids may embed the thread id or the person's id. These leads are unverified.

**Options evaluated.**

| Identifier | Stable across rename | Reliable | Notes |
| --- | --- | --- | --- |
| Thread id in the DOM (new hint selectors) | Yes | Best | Only if Teams renders it. Phase 0 checks this. |
| Other person's id (`8:orgid:<guid>`) for 1:1 chats | Yes | Good | From the header, author or avatar attributes, if present. A person has exactly one 1:1 chat with you. |
| Message overlap: rendered message ids found in an existing archive entry | Yes | Good | Works while the newest archived messages are still among those Teams shows when the chat opens. After a long gap in a busy chat they aren't, so it can't be the only method. |
| Title plus title history | No | Weak | Unnamed group chats are titled with their member list, which changes. Names can repeat. |
| Teams' internal storage or API | Yes | n/a | **Rejected**: undocumented, and it touches authentication. |
| Manual merge and rename in the archive | Yes | Always available | The last resort when automation can't decide. |

**Recommended design.**

- **Archive keys never change.** Existing `title:` and `teams:` keys keep working and no messages are rewritten.
- **Records gain aliases.** Each conversation gains `aliases` (other identities it is known by) and `titleHistory`.
- **Order of resolution:**
  1. thread id;
  2. person id (1:1);
  3. a known alias;
  4. message overlap;
  5. the title, only if exactly one entry matches and nothing contradicts it;
  6. otherwise a new local key.
- **Ambiguous matches go to you.** The popup asks which archived chat this is.
- **Manual merge.** It moves the messages, images and sessions of one entry into another in chunks, with a journal in `meta` so an interrupted merge continues on the next start. It folds duplicates with the existing merge rules and keeps the old key as an alias.

### 2.3 Export and import (your section 1)

Limitations:

- **E1. Few choices.** There's no CSV, plain text or standalone HTML, no date range, and no content options apart from "Include images". You can export only one chat or all of them.
- **E2. Scale (G1).** Images are embedded as base64 in one string.
- **E3. The ZIP isn't machine-readable.** It holds no JSON, its pictures are named by number and time, and it can't be imported. A knowledge system can't upsert from it reliably.
- **E4. Import is limited.** It accepts JSON only and reads the whole file into memory.
- **E5. Some reference options have no data behind them.** Reactions and avatars are never captured, so the "Reactions" and "Avatars" options from your reference can't be offered until capture exists. Files are recorded as name and link only. Downloading SharePoint or OneDrive files would need new host permissions, and I recommend against it.

Proposed design:

- **One export screen** with five independent choices:
  - Conversations: one, several or all.
  - Format.
  - Date range: no limit, last 24 hours, last 7 days, last 30 days, or custom (From inclusive, To exclusive, by message time).
  - Content: images, file attachments (names and links), reply context, system messages, edit history.
  - Packaging: single file, or ZIP when pictures go with a format that can't embed them.
- **Formats:**
  - HTML: readable, pictures embedded, one file.
  - PDF: print.
  - Text.
  - CSV: one row per message, UTF-8 with BOM for Excel, and protected against spreadsheet formula injection.
  - JSON: the lossless v1 contract.
- **Knowledge package (ZIP)**, the preset for your knowledge system:
  - `manifest.json`;
  - per conversation, `messages.jsonl` and `conversation.json` (the same record schemas as v1);
  - `images/<sha256>.<ext>` referenced by `imageId`;
  - a Markdown transcript for apps that read Markdown.

  The package is also importable, which makes it the scalable backup format. Everything is written in parts, never as one giant string.
- **Default format.** Remember your last choice. On first use, default to HTML, not JSON. The **Knowledge system** preset selects the knowledge package with images, attachments, reply context and edit history, and leaves system messages out.
- **Compatibility.** JSON export format v1 stays importable and unchanged; fields are only added. The package is a separate, documented container that reuses the v1 record schemas.

### 2.4 Capture: date range, updates, pause and resume (your section 10)

How it works now:

- **Full history** scrolls to the beginning, passing quickly through archived parts.
- **Update** stops after re-seeing 8 archived messages in a connected window.
- **Visible only** captures the screen.
- **Re-read archived parts** reads archived parts again at normal speed.
- **Every scroll step is saved** in one transaction with its coverage, which is a checkpoint every 10 to 30 messages, finer than the 20 to 50 you asked for. The session record is updated with each step and with a heartbeat every 15 s.
- **Interruption.** A session whose heartbeat is older than 90 s becomes **Interrupted**. **Resume extraction** starts a Full-history run linked to it, which skips archived parts quickly.
- **Pause** holds the run in its tab. If the laptop shuts down, the session becomes Interrupted and is resumed the same way.

Gaps:

- **C1. No date range.** Full history always goes back to the beginning.
- **C2. Update overlap is a count.** It is a number of messages, not a time window. There is no "since last successful run" and no "re-check the last N days" for late replies and edits.
- **C3. Resume can't jump.** Teams Web loads history only from the newest message backwards. Resuming deep into a long chat therefore passes through everything newer again. That is fast, but limited by how quickly Teams loads older pages, which can take many minutes over years of history. No DOM-only method avoids this. It can be made faster: larger steps through archived parts, and no re-reading of images (C4).
- **C4. Images are read again in every new run** for messages that are already archived. The cache lasts only for one session.
- **C5. Edits to older messages are missed.** Update's small overlap catches only edits near the newest messages. Other edits need Re-read.

Proposed changes:

- **Capture range.** Offer Since last update, Last 24 hours, Last 7 days, Last 30 days, From a date, or Everything. The engine stops once a connected window reaches older than the start date, plus a margin.
  - Recommendation for **To**: keep saving the newer messages passed on the way. Scrolling past them costs nothing, and skipping them would leave holes that a later Update would believe are archived. "To" stays an export filter. *(Decision 3)*
- **Per-conversation `lastSuccessfulRun`.** Only completed runs set it, recording when the run ended and the newest message reached.
- **Update new messages.** Go back to the newest archived message minus an overlap window (default 2 days, configurable 0 to 30 days, and at least *N* messages), then stop once connected. Edits and deletions inside the window are recorded with the existing version history.
- **Resume.** Keep the current mechanism. Skip archived images and seek with larger steps. Show Paused, Interrupted, Completed and Failed consistently in the popup and the Overview. Offer Resume when you open that chat again; the extension can't continue while the browser is closed.

### 2.5 Popup (your section 3)

| Element | Assessment | Proposal |
| --- | --- | --- |
| Conversation name and type | Essential | Keep. Show a warning only when you can act on it, with a link to fix or merge. |
| Archived count and history status | Essential, but two tiles | One line: "1,234 messages · complete back to 3 Jan 2023 · updated 3 days ago". |
| On screen | Developer-oriented | Move to Troubleshooting. |
| Full history | Primary | Primary button, with "Resume" taking its place when a run was interrupted. |
| Update | Frequent | Secondary: "Update new messages", showing the time of the last update. |
| Visible only | Rare | Under "More". |
| Re-read archived parts | Technical | Advanced settings, plus a per-run option under "More". |
| Diagnostics | Troubleshooting | Settings › Troubleshooting. The popup links to it only when nothing is found. |
| Open archive / side panel | Two footer links | Two icon buttons in the header. |

### 2.6 Settings (your section 4)

The archive page shows these in one grid (Image 1): 13 number fields, a text field, a drop-down, two checkboxes and a JSON box.

- **General:**
  - Save images.
  - Pause while the Teams tab is hidden.
  - Scrolling speed: Gentle, Normal or Fast. Each preset sets the intervals, step, animation and render waits. It shows *Custom* when advanced values differ.
  - Maximum run duration.
  - Update overlap (days).
- **Advanced** (collapsed):
  - scroll intervals, step, animation, render quiet period, maximum render wait, wait for older history, attempts at the top, steps without new messages, maximum steps;
  - maximum image size, display name, date order;
  - re-read by default, selector overrides, reset.
- **Troubleshooting:** Diagnostics and copy report.
- **Storage:** usage, backup and import.
- **Existing preferences are kept.** The stored keys stay the same. The speed preset is derived from the stored values, and the existing `SETTINGS_REVISION` mechanism handles changed defaults. The current safety limits stay: at least 250 ms between steps, a maximum duration of 24 h, and step and stall caps.

### 2.7 Visual identity and UI (your sections 2, 5 and 6)

- **The accent colour is Microsoft Teams' own brand purple (`#5b5fc7`).** The icon is a purple tile with a speech bubble and a down arrow. Both suggest a Microsoft product, so they should change before any store listing. The name "Teams Chat Extractor" also leads with a Microsoft trademark. Stores usually accept a descriptor such as "… for Microsoft Teams" with a "not affiliated with Microsoft" note, but not a name that reads as official. *(Decision 1)*
- **What exists:**
  - light and dark themes follow the system;
  - six font sizes from 11 to 16 px;
  - the archive page is one long page with wide tables;
  - the side panel is a copy of the popup.
- **Proposal:**
  - **Design tokens:** spacing 4/8/12/16/24, radius 6/8, type scale 12/13/14/16/20, one restrained blue accent, neutral greys, and explicit hover, selected, disabled and focus states. Light, dark and system themes.
  - **App page** with Overview · Conversations · Export · Settings, using hash routing in plain TypeScript (no framework needed).
  - **Conversations:** search, type filter, and a message view with day separators, reply quotes, inline pictures, attachments, and Merge, Rename and Delete.
  - **Overview:** totals, storage used, recent runs with their status, and the latest activity.
- **Logo:** a speech bubble combined with an archive box. One geometry description produces the SVG master and the PNGs (16, 32, 48 and 128 px) through the existing dependency-free generator, with a simplified 16 px variant. Image 3 is used for layout patterns only (format tiles, grouped options), never its code, text or assets.

### 2.8 Selector coverage (data quality)

Compared with the selectors of the reference exporter (all unverified against your tenant):

- **Replies.** Quoted replies in new Teams can render as `[data-tid="referencePreview"]` or as a `role="group"` labelled "Begin Reference…". Neither is in our reply selectors, so **reply context may be missing**. The Diagnostics `reply.container` count would show it.
- **Also not covered:**
  - author elements `id^="author-"`;
  - rich file previews `img[data-tid="rich-file-preview-image"]`;
  - reaction pills `[data-tid="diverse-reaction-pill-button"]`. Reactions aren't captured at all.

### 2.9 Technical debt and regression risks

- `ui/archive.ts` (451 lines) mixes tables, export, import, settings and the image viewer. `ui/popup.ts` is 318 lines. Splitting them by section comes with the redesign.
- No UI tests. The logic is tested, the pages are not. The redesign should move the logic into tested view models.
- The selectors are not verified against live Teams. Diagnostics and overrides mitigate this, and Phase 0 gathers evidence first.
- Removing NDJSON in `62278d6` broke any consumer that used it. The knowledge package replaces it.
- Store readiness still needs:
  - a privacy policy (data stays on the device);
  - a justification for each permission;
  - distinct branding;
  - listing images;
  - optionally a build without source maps.
- **Policy.** Your organisation's data rules may limit copying work chats into a personal system. Check before archiving at scale. A public listing should say the same.

## 3. Necessary, cosmetic or risky

| Change | Class | Why |
| --- | --- | --- |
| Conversation identity (aliases, resolver, merge) | Necessary | Your 1:1 chat is identified by title. Renames and duplicate titles split or mix archives. |
| Scalable export and import (knowledge package) | Necessary | Your knowledge-system goal, and backups with images. |
| Update since last successful run, with a time overlap | Necessary | Your weekly workflow. |
| Capture date range | Necessary (moderate) | Saves time on first runs that don't need everything. |
| Reply selectors for new Teams | Necessary *if* Diagnostics confirms the gap | Reply relationships are a requirement. |
| New brand colour, icon and name | Necessary before a store listing | Avoids implying Microsoft affiliation. |
| Skip archived images, faster resume | Efficiency | Resume and update speed. |
| Popup and settings simplification | Usability | No data impact. |
| App navigation and conversation viewer | Usability | No data impact, the largest UI effort. |
| Themes and design tokens | Cosmetic | The theme mechanism already exists. |

**Main regression risks, and how to avoid them:**

- **Changing keys.** Use aliases instead; keys never change.
- **Changing JSON v1.** Only add fields; the package is a separate container.
- **Engine stop conditions** (date range, time overlap). Write chat-simulator tests first, including coverage checks.
- **Manual merge** (the only rewrite of records). Use a journal, chunks, a crash test, and a prompt to back up first.
- **A UI rewrite.** Keep the controller, protocol and storage APIs as they are, and move one screen at a time.

## 4. Phases

Each phase works test-first, ends with `npm run check` and a short manual checklist in Edge, and is committed and pushed to `main`.

**Status (21 November 2026):** Phase 0 is built. Diagnostics now includes the identifier probe. The next step is the two reports from your Teams: one from a 1:1 chat and one from a group chat.

| Phase | Content | Size |
| --- | --- | --- |
| **0. Evidence** | Diagnostics gets an identifier probe: which elements and attributes contain thread-id or person-id shaped values (attribute names and counts only, values redacted). It also probes replies, reactions and images. You run it in a 1:1 chat that shows the warning and in a group chat, and send both reports. | S |
| **1. Conversation identity** | Database version 3, additive only: conversation `aliases` and `titleHistory`, and a message index by Teams id. The resolver (2.2), the ambiguity prompt and manual merge with a journal. Selector fixes confirmed in Phase 0. Tests: a version 2→3 upgrade keeps everything, title-keyed chats stay reachable, a rename resolves to the same entry, duplicate titles never merge silently, and an interrupted merge completes. | L |
| **2. Capture workflow** | `lastSuccessfulRun`, Update new messages with a time overlap, capture date range, faster resume (larger steps, no re-reading of archived images), consistent statuses. Simulator tests: stop at a date, overlap window, edits inside the window, resume after interruption, no duplicates. | M |
| **3. Export and import** | The export model (conversations × format × range × content), HTML, PDF, Text, CSV and JSON, the knowledge package with its preset, and import of JSON and the package without loading everything at once. Tests: golden files per format, package round trip, duplicate-free re-import, ranges and options, CSV formula safety. Docs: EXPORT_FORMAT additions and a package specification. | L |
| **4. Visual identity** | Logo SVG master, PNGs from the same geometry, the new accent colour, listing tile. Independent of the other phases, so it can run in parallel. | S |
| **5. Interface** | Design tokens and themes, the simplified popup and side panel, and the app page: Overview, Conversations with the message view, Export, and Settings (General, Advanced, Storage, Troubleshooting). Accessibility (keyboard, focus, contrast) and responsive layouts. View-model tests and a manual checklist. | L |
| **6. Later / optional** | Reaction capture, store packaging (name, privacy policy, listing, permission justifications). | M |

Order: identity before export, because exports and updates depend on stable conversation keys. Capture before export, because exports use `lastSuccessfulRun`. The interface comes last, because it uses everything else. The logo can be done at any time.

## 5. Decisions needed

1. **Name.** Keep "Teams Chat Extractor", or choose a distinct name with "for Microsoft Teams" as a descriptor (recommended for a store listing)?
2. **Knowledge system.** Which one will you use (Obsidian, Notion, a custom database, something else)? It decides the package layout of the preset, for example Markdown with an images folder versus JSONL.
3. **Capture "To".** Should a capture with a range also save the newer messages it passes (recommended), or save only the range?
4. **Diagnostics.** Run the Phase 0 report in a 1:1 chat and a group chat once it is built.
5. **File attachments.** Keep names and links only (recommended), or download files? That needs extra SharePoint and OneDrive permissions.
