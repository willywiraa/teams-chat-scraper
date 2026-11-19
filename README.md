# Teams Chat Extractor

A Microsoft Edge extension that archives your Microsoft Teams chats on your own computer. It reads the conversations you open in **Teams Web** (teams.microsoft.com) and stores them in a local database you can export as JSON, NDJSON or Markdown.

- **Uses your existing sign-in.** There's no Microsoft Graph API, no Entra ID app registration and no admin consent.
- **Reads only what Teams shows you.** The extension reads the messages Teams renders in the open chat and scrolls that chat upwards like you would, so Teams loads older messages. It never reads tokens, cookies or network traffic, never calls Teams or Microsoft APIs and never changes anything in Teams. If your account can't see a message, the extension can't either.
- **Keeps everything local.** Messages are stored in the extension's IndexedDB in your browser profile. Nothing is sent anywhere.

> The Teams desktop app can't be accessed by browser extensions. Open the same chats in Teams Web in Edge instead. Your account and data are the same.

## Install (developer mode)

Requirements: Microsoft Edge 116 or newer and Node.js 20 or newer (only to build it).

```powershell
npm install
npm run build
```

1. Open `edge://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `dist` folder of this project.
3. Open or reload https://teams.microsoft.com and sign in as usual.

After rebuilding, click **Reload** on the extension card in `edge://extensions` and reload the Teams tab. If a Teams tab was already open when you installed or updated the extension, the popup offers **Connect to this tab** (reloading the tab works too).

## Archiving a chat

1. In Teams Web, open the chat (1:1, group or meeting chat).
2. Click the extension icon. The popup shows the chat it found, how many of its messages are archived, and whether the archived history is complete.
3. Choose a mode:

| Button | What it does | Ends when |
| --- | --- | --- |
| **Full history** | Scrolls back to the beginning of the chat and archives everything. It moves quickly through parts that are already archived. | The beginning of the chat is reached, or it has caught up with a complete archive. |
| **Update** | Archives messages newer than the archive. | Several already-archived messages have been seen again (8 by default). |
| **Visible only** | Archives only the messages on screen. It doesn't scroll. | Immediately. |

**Re-read archived parts at normal speed** (with Full history) reads archived stretches again carefully. Use it to pick up edits and deletions in older messages.

While a run is active, the popup shows progress and **Pause**, **Continue** and **Stop**. Everything captured so far is saved after every scroll step, so stopping or closing the tab loses nothing.

For long chats, click **Open in side panel**. The panel stays open while you work, unlike the popup.

**Keep the Teams tab visible.** Edge slows down background tabs, so the extraction pauses on its own while the tab is hidden and continues when you return. You can change this in the settings. Putting Teams in its own window works well.

### Resuming

If a run was interrupted (tab closed or reloaded, browser closed, extension updated), the popup shows **Resume extraction** the next time you open that chat. Resuming runs Full history. It skips quickly through what is already archived and continues from where the previous run stopped. Running any mode again is always safe: messages are never stored twice.

## Archive and settings page

Open it from **Open archive & settings** in the popup, or via the extension's *Extension options*.

- **Conversations**: each archived chat with its message count, archived period, completeness and last run. You can **export** one chat (JSON, NDJSON or Markdown), **export all**, or **delete** a chat from the archive.
- **Import archive…** merges a JSON export back in. Use it to restore a backup or combine archives from two browser profiles. Importing the same file twice changes nothing.
- **Recent sessions**: every run with its result, counters and warnings.
- **Settings** (see below) and the storage used.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Scroll interval while capturing | 1200 ms | Minimum time between scroll steps when reading new history. Raise it if Teams loads slowly. |
| Scroll interval through archived parts | 300 ms | Same, while passing through already-archived stretches. |
| Scroll step | 0.8 | Step size as a fraction of the visible height. It is reduced automatically if a step skips messages. |
| Render quiet period | 350 ms | The page must stop changing for this long before a step counts as rendered. |
| Maximum render wait per step | 6000 ms | Upper limit for that wait. |
| Wait for older history at the top | 8000 ms | How long to wait for Teams to load older messages at the top of the list. |
| Attempts at the top before finishing | 3 | Attempts without new messages before the beginning is considered reached. |
| Steps without new messages before stopping | 25 | Guard against a list that has stopped responding. |
| Maximum scroll steps per run / Maximum run duration | 50,000 / 360 min | Hard limits, so a run can never loop forever. |
| Archived messages to re-see before an update stops | 8 | Overlap required by **Update**. |
| Pause while the Teams tab is hidden | on | See above. |
| Your display name | (empty) | Teams doesn't show your own name next to your messages. Enter it to record it as their sender. Your messages are marked as yours either way. |
| Date order used by Teams | auto | Order of numeric dates shown by Teams (for example 1/2/2024). It is used only when no exact timestamp is available. |
| Selector overrides | (empty) | See [When nothing is found](#when-nothing-is-found). |

## When nothing is found

The extension recognises Teams' page structure through a list of CSS selectors. Microsoft changes Teams Web from time to time, so a selector can stop matching.

1. Open the chat, open the popup and click **Diagnostics → Run diagnostics**. The report contains counts and the page's structure only, never message text or names. **Copy report** puts it on the clipboard.
2. Look at which selectors match nothing (for example `author` or `timestamp`).
3. Under **Settings → Selector overrides**, enter a JSON object that replaces just those lists, for example:

```json
{
  "author": ["[data-tid=\"message-author-name\"]", ".my-new-author-class"],
  "reply": { "container": ["[data-tid=\"quoted-reply-card\"]"] }
}
```

**Insert default selectors** shows the complete default profile to start from. Each field you override replaces that default list. Fields you leave out keep their defaults.

## What is captured

For every message:

- Sender, with your own messages flagged. Teams shows the name only on the first message of a run from one person, and the extractor carries it to the following messages.
- Exact timestamp (UTC) and the Teams message id.
- Text with paragraphs, lists and line breaks preserved, plus sanitised HTML.
- Mentions, links, attachments (file names and links; files aren't downloaded), quoted replies linked to the message they quote, and edited and deleted flags with earlier versions kept.
- System messages, such as someone being added to the chat.

Per chat, the extension also records the participants, the title, the chat type (1:1, group, meeting, channel), the archived period, and whether the archive reaches back to the beginning.

## Data and privacy

- The archive lives in the extension's IndexedDB in your Edge profile, which the extension's own pages read directly. Content scripts run only on the Teams domains listed in the manifest. The extension makes no network requests of its own.
- **Removing the extension deletes its archive.** Export a JSON backup first (Archive page → **Export all**). Back up regularly anyway.
- Exports contain your messages in plain text. Store them accordingly.

## Limitations

- It works through Teams Web's page structure, not an official API. Teams updates can require selector overrides, or an extractor update, before extraction works again.
- It's designed for chats. Channel posts may be read partially, but reply threads under channel posts aren't expanded.
- Reactions, read receipts, and the contents of attached files and images aren't captured.
- A chat is identified by its Teams thread id. If that id can't be found on the page, the chat title is used instead, and two chats with the same title would then share an archive entry. The popup warns when this happens.
- The beginning of a chat is detected when Teams stops loading older messages. If Teams failed to load (for example because the network dropped), a run can finish too early. Run **Full history** with **Re-read archived parts** to try again.
- Messages that show neither a Teams id nor a timestamp (rare) are matched by their content and position. Two identical messages of that kind next to each other may be stored as one.

## Development

```powershell
npm run typecheck
```

```powershell
npm test
```

```powershell
npm run build
```

```powershell
npm run check
```

`npm run check` runs all three. `npm run watch` rebuilds on every change, and `npm run icons` regenerates the PNG icons.

```
src/
  manifest.json
  shared/      types, settings, messaging protocol, hashing, time parsing
  extractor/   reads the Teams DOM: selectors, conversation detection, message parsing, diagnostics
  scraper/     the scroll-and-capture engine: pause/resume/stop, render detection, ordering
  storage/     IndexedDB archive: schema, merge rules, coverage, reply resolution
  export/      export format v1, JSON / NDJSON / Markdown, import
  background/  service worker: routes captured batches into the archive
  content/     content script: runs the engine in the Teams tab
  ui/          popup / side panel and the archive & settings page
tests/
  unit/         parsing, dates, ordering, coverage, merge rules, controls, exports, diagnostics
  integration/  engine on a simulated virtualised Teams chat, archive repository, end-to-end pipeline
  helpers/      Teams-like DOM fixtures and the chat simulator
```

The integration tests run the real engine against a simulated Teams message list. The simulator renders only the messages near the viewport, loads older history with a delay when you scroll to the top, groups consecutive messages from one sender, and can drop ids, timestamps or authors. The tests cover 1:1 and group chats, multi-paragraph messages, attachments, replies, missing metadata, a 2,000-message history, interrupted and resumed sessions, pause/resume/stop, incremental updates, edits and duplicate prevention.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works, and [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md) for the export format you can build an import into another system on.
