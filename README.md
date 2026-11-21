# Teams Chat Extractor

A Microsoft Edge extension that archives your Microsoft Teams chats on your own computer. It reads the conversations you open in **Teams Web** (teams.microsoft.com) and stores them in a local database you can export as a readable chat (HTML, PDF, Markdown, text or CSV), as JSON, or as a knowledge package for other systems.

- **Uses your existing sign-in.** There's no Microsoft Graph API, no Entra ID app registration and no admin consent.
- **Reads only what Teams shows you.** The extension reads the messages Teams renders in the open chat and scrolls that chat upwards like you would, so Teams loads older messages. It never reads tokens, cookies or network traffic, never calls Teams or Microsoft APIs and never changes anything in Teams. If your account can't see a message, the extension can't either. Images are copied from what the open chat displays (see [Images](#images)).
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
2. Click the extension icon. The popup shows the chat it found, how many of its messages are archived, whether the archived history is complete, and when the chat was last brought up to date.
3. Under **Capture**, choose what to archive, then click **Start**:

| Choice | What it does | Ends when |
| --- | --- | --- |
| **New messages since the last update** | Archives the messages that arrived since the last update, and reads the 2 days before it again (setting) to pick up edits, deletions and late replies. Preselected once the chat has something archived. | It has re-read back to the last update minus those days, and seen at least 8 archived messages again. |
| **Last 24 hours**, **Last 7 days**, **Last 30 days** | Archives the messages of that period. | The start of the period is reached, or it joins archived messages that already reach back that far. |
| **From a date…** | The same, from midnight of the chosen day. | As above. |
| **Full history** | Scrolls back to the beginning of the chat and archives everything. Preselected for a chat with nothing archived. | The beginning of the chat is reached, or it has caught up with a complete archive. |

Every choice keeps the newer messages it passes on the way, so there is no "to" date: the archive never gets a hole between the period and now.

**Visible only** archives the messages on screen without scrolling.

**Re-read archived parts at normal speed** reads archived stretches again, with their images, instead of passing them quickly. Use it to pick up edits and deletions in older messages.

**The last update** is the most recent run after which the archive held every message, without a gap, from the previous update up to the newest message. Any capture can be one: an update, a period or the full history, also one that was stopped once it got that far. A run that leaves a gap (for example *Last 24 hours* a week after the last update) is not, so the next **New messages since the last update** still goes back to the last update and closes the gap. The archive page shows the time of each chat's last update.

While a run is active, the popup shows progress and **Pause**, **Continue** and **Stop**. Everything captured so far is saved after every scroll step, so stopping or closing the tab loses nothing.

For long chats, click **Open in side panel**. The panel stays open while you work, unlike the popup.

**Keep the Teams tab visible.** Edge slows down background tabs, so the extraction pauses on its own while the tab is hidden and continues when you return. You can change this in the settings. Putting Teams in its own window works well.

### Resuming

If a run was interrupted, stopped or failed (tab closed or reloaded, browser closed, extension updated), the popup shows **Resume extraction** the next time you open that chat. Resuming repeats the same capture (the same period, the same reading) and continues where the previous run stopped:

- Through archived parts it takes steps of two screen heights instead of one, and doesn't read their images again. A skipped stretch counts as covered because the archive already holds it without a gap. If a step goes past the end of the archived part, the run steps back and continues normally.
- Teams loads older history only from the newest message backwards, so a resumed run still has to pass everything newer than where it stopped. That is quick but depends on how fast Teams loads older messages.
- Nothing runs while the browser or computer is off. Open the chat again and resume.

Running any capture again is always safe: messages are never stored twice.

## Archive and settings page

Open it from **Open archive & settings** in the popup, or via the extension's *Extension options*.

- **Conversations**: each archived chat with its message count, number of saved images, archived period, completeness, last update and last run. Click the image count to see the chat's images, with who sent each one and when, and to download them. You can **export** a chat (**Export…** in its row), several or all chats (**Export…** at the top), or **delete** a chat (with its images) from the archive.
- **Export…** opens one dialog for every export. Choose:
  - the **conversations**: one, several or all;
  - the **format**:
    - **HTML page**: read the chat message by message in the browser, each picture where it was sent;
    - **PDF (print)**: opens the same page in a new tab with the print dialog; choose **Save as PDF** as the printer. Allow pop-ups for the archive page if Edge blocks the tab;
    - **Markdown** and **Plain text**;
    - **CSV**: one row per message, for Excel and other spreadsheets;
    - **JSON**: the complete records, which **Import archive…** reads back;
    - **Knowledge package**: a ZIP with the records as JSON Lines, a Markdown transcript per chat and the pictures as files, for knowledge management systems. **Import archive…** reads it back too;
  - the **packaging**: one file, or a ZIP with the pictures as files, named by number and message time (`001_2026-11-02_1001.png`). Markdown, text and CSV are always a ZIP when they include pictures; HTML can embed them in the one file;
  - the **messages**: all archived messages, the last 24 hours, the last 7 days, the last 30 days, or a custom period (From included, Before not);
  - what to **include**: pictures, file attachments, reply context, system messages and edit history.

  **Knowledge system** sets the knowledge package with pictures, attachments, replies and edit history, without system messages; **Full backup** sets it with everything. The dialog remembers your last choices; the first time it suggests an HTML page. [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md) describes every format.
- **Rename** gives a chat its own name in the archive and in exports. The title Teams shows stays visible below it, with earlier titles. Leave the name empty to show the Teams title again.
- **Merge…** combines two archive entries of the same chat, for example a chat archived under its old and its new title. The dialog lists first the entries that hold some of the same messages or have a similar name, and you choose the one to merge into. Every message is kept once, with its pictures and runs. A merge can't be undone, so export a backup first if in doubt. If the page closes during a merge, the merge finishes the next time the archive page opens.
- **Import archive…** merges a JSON export or a knowledge package (`.zip`) back in. Use it to restore a backup or combine archives from two browser profiles. The whole file is checked before anything is written, so a damaged file changes nothing, and importing the same file twice changes nothing. An imported chat joins the entry of the same chat, also when that entry has another title. If the page closes during an import, the chat being imported shows as partial; import the file again to complete it.
- **Recent sessions**: every run with what it captured (*Update*, *Since 14 Nov 2026*, *Full history*, *Visible only*), its status (*Running*, *Paused*, *Completed*, *Stopped*, *Interrupted*, *Failed*), result, counters (including images saved and not saved) and warnings.
- **Settings** (see below) and the storage used.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Scroll interval while capturing | 600 ms | Minimum time between scroll steps when reading new history. Raise it if Teams loads slowly. |
| Scroll interval through archived parts | 300 ms | Same, while passing through already-archived stretches. |
| Scroll step | 0.8 | Step size as a fraction of the visible height. It is reduced automatically if a step skips messages. |
| Smooth scrolling: animation per step | 250 ms | Each step glides instead of jumping (at most 120 ms through archived parts). 0 turns it off. A hidden tab always jumps. |
| Render quiet period | 350 ms | The page must stop changing for this long before a step counts as rendered. |
| Maximum render wait per step | 6000 ms | Upper limit for that wait. |
| Wait for older history at the top | 8000 ms | How long to wait for Teams to load older messages at the top of the list. |
| Attempts at the top before finishing | 3 | Attempts without new messages before the beginning is considered reached. |
| Steps without new messages before stopping | 25 | Guard against a list that has stopped responding. |
| Maximum scroll steps per run / Maximum run duration | 50,000 / 360 min | Hard limits, so a run can never loop forever. |
| Update: days before the last update to check again | 2 | **New messages since the last update** reads this many days before the last update again, for edits, deletions and late replies. 0 to 30; 0 stops at the first archived messages. |
| Update: archived messages to see again before stopping | 8 | The update also sees at least this many archived messages again. |
| Pause while the Teams tab is hidden | on | See above. |
| Save the images shown in messages | on | Saves the pictures displayed in messages into the archive. See [Images](#images). |
| Largest image to save | 10 MB | Larger images aren't saved; their name and link still are. 1 to 50 MB. |
| Your display name | (empty) | Teams doesn't show your own name next to your messages. Enter it to record it as their sender. Your messages are marked as yours either way. |
| Date order used by Teams | auto | Order of numeric dates shown by Teams (for example 1/2/2024). It is used only when no exact timestamp is available. |
| Selector overrides | (empty) | See [When nothing is found](#when-nothing-is-found). |

## When nothing is found

The extension recognises Teams' page structure through a list of CSS selectors. Microsoft changes Teams Web from time to time, so a selector can stop matching.

1. Open the chat, open the popup and click **Diagnostics → Run diagnostics**. The report contains counts and the page's structure only, never message text, names or ids. **Copy report** puts it on the clipboard.
   - The report also shows where chat and person ids appear on the page, for example in the chat header or the chat list.
   - Each id is replaced by its kind (such as `thread:v2` or `person:orgid`) and a label (`T1`, `P1`, …). The same label in two places means the same id.
   - This shows whether Teams puts the chat id on the page when the popup says the chat is "identified by title".
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
- Images shown in messages (pasted pictures, image attachments), saved as displayed. See [Images](#images).
- System messages, such as someone being added to the chat.

Per chat, the extension also records the participants, the title (and earlier titles), the chat type (1:1, group, meeting, channel), the archived period, and whether the archive reaches back to the beginning.

### Images

When **Save the images shown in messages** is on (the default), every picture that a run sees in a message is saved once into the archive and linked from the message's attachment.

- The extension copies the picture Teams already displays. It first reads the page's own copy (Teams usually shows images from a `blob:` address) or the browser cache. Only if neither is available does it request the same image address again, as the page did. If that isn't possible either, it copies the displayed picture through a canvas, which is saved as PNG.
- An image is named by the SHA-256 hash of its bytes. The same picture shown twice is stored once.
- Teams usually displays a preview size, so the saved copy may be smaller than the original upload.
- Images the browser doesn't allow the extension to read (shown from another site without permission), images that never finish loading, and images above **Largest image to save** aren't saved. Their name and link are kept, the run counts them as *not saved*, and a warning explains why.
- Emoji are kept as text, not as images.
- A picture is read once per run. Pictures of archived messages that are shown unchanged are taken from the archive instead of being read again; **Re-read archived parts** reads them again.
- Saved images are included in JSON exports (as base64) and knowledge packages (as files), and restored by **Import archive…**. HTML, PDF, Markdown and text exports show each picture in its message.
- Profile pictures (for example of the original sender in a forwarded message) aren't message content and aren't saved.

## Data and privacy

- The archive lives in the extension's IndexedDB in your Edge profile, which the extension's own pages read directly. Content scripts run only on the Teams domains listed in the manifest. The extension sends nothing anywhere. Its only requests re-read images the open chat is displaying, normally from the page's own copy or the browser cache (see [Images](#images)); turn off **Save the images shown in messages** to avoid them.
- **Removing the extension deletes its archive.** Export a backup first (Archive page → **Export…** → **Full backup**). Back up regularly anyway.
- Exports contain your messages in plain text, and your saved images unless **Pictures** is off. Store them accordingly.

## Limitations

- It works through Teams Web's page structure, not an official API. Teams updates can require selector overrides, or an extractor update, before extraction works again.
- It's designed for chats. Channel posts may be read partially, but reply threads under channel posts aren't expanded.
- Reactions, read receipts and the contents of attached files aren't captured. Images are saved as displayed (often a preview size). Images the browser won't let the extension read are kept as name and link only.
- Exports are written, and imports read, in parts, so a large archive doesn't have to fit in memory. An export of several gigabytes can still be more than the browser allows for one download; export fewer chats, a period, or without pictures.
- A chat is identified by its Teams thread id. If that id can't be found on the page, the extension goes by the chat title and by the archived messages the chat shows:
  - A renamed chat continues its archive entry when some of the messages on screen are archived already. Otherwise it gets a new entry, which you can merge with the old one on the archive page.
  - A chat with the title of another archived chat gets an entry of its own when that entry lacks the messages it shows from the same period.
  - With no message ids on screen, the title alone decides, and the popup warns about it.
- The beginning of a chat is detected when Teams stops loading older messages. If Teams failed to load (for example because the network dropped), a run can finish too early. Run **Full history** with **Re-read archived parts** to try again.
- Messages that show neither a Teams id nor a timestamp (rare) are matched by their content and position. Two identical messages of that kind next to each other may be stored as one. When two entries that both hold such a message are merged, it is kept twice.

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

`npm run check` runs all three. `npm run watch` rebuilds on every change. `npm run icons` regenerates the logo files from the one description in `scripts/logo.ts` (it needs Node.js 22.18 or newer, which runs TypeScript directly); a test fails when the committed files no longer match it.

```
src/
  manifest.json
  shared/      types, settings, messaging protocol, hashing, time parsing
  extractor/   reads the Teams DOM: selectors, conversation detection, message parsing, diagnostics
  scraper/     the scroll-and-capture engine: pause/resume/stop, render detection, ordering
  storage/     IndexedDB archive: schema, merge rules, coverage, reply resolution, chat identity and merging
  export/      export format v1, the export pipeline (HTML, print, Markdown, text, CSV, JSON, knowledge package), ZIP writing and reading, streaming import
  background/  service worker: routes captured batches into the archive
  content/     content script: runs the engine in the Teams tab
  ui/          popup / side panel and the archive & settings page
icons/         the logo: SVG masters (logo.svg, and logo-16.svg for 16 px) and the extension's PNG icons
store/         store listing images (300 × 300 logo, 440 × 280 tile); not part of the extension
scripts/       build, and the logo description and generator
tests/
  unit/         parsing, dates, ordering, coverage, merge rules, controls, exports, diagnostics
  integration/  engine on a simulated virtualised Teams chat, archive repository, end-to-end pipeline
  helpers/      Teams-like DOM fixtures and the chat simulator
```

The integration tests run the real engine against a simulated Teams message list. The simulator renders only the messages near the viewport, loads older history with a delay when you scroll to the top, groups consecutive messages from one sender, and can drop ids, timestamps or authors. The tests cover 1:1 and group chats, multi-paragraph messages, attachments, replies, missing metadata, a 2,000-message history, interrupted and resumed sessions, pause/resume/stop, incremental updates, edits and duplicate prevention.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works, and [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md) for the export format you can build an import into another system on.

## Trademarks

This is an independent project. It is not affiliated with, endorsed by or sponsored by Microsoft. Microsoft, Microsoft Teams and Microsoft Edge are trademarks of the Microsoft group of companies, and are named here only to say what the extension works with. The extension's logo and colours are its own and don't use Microsoft's.
