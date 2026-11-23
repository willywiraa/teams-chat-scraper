# Teams Chat Scraper

Teams Chat Scraper is a Microsoft Edge extension that archives your Microsoft Teams chats on your own computer. It reads the conversations you open in **Teams Web** (teams.microsoft.com) and stores them in a local database. From there it saves a chat as a PDF or plain text to read, or as JSON or a ZIP package that it can import again and that other systems can read.

- **Uses your existing sign-in.** There's no Microsoft Graph API, no Entra ID app registration and no admin consent.
- **Reads only what Teams shows you.** The extension reads the messages Teams renders in the open chat and scrolls that chat upwards like you would, so Teams loads older messages. It never reads tokens, cookies or network traffic, never calls Teams or Microsoft APIs and never changes anything in Teams. If your account can't see a message, the extension can't either. Images are copied from what the open chat displays (see [Images](#images)).
- **Keeps everything local.** Messages are stored in the extension's IndexedDB in your browser profile. Nothing is sent anywhere.

Teams Chat Scraper is an independent extension. It is not made by, endorsed by or affiliated with Microsoft. Microsoft Teams is a trademark of the Microsoft group of companies.

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
2. Click the extension icon. The popup shows the chat it found and one line about its archive, for example *1,234 messages · complete back to 3 Jan 2023 · updated 3 days ago*. A warning appears only when you can act on it, such as a chat archived in two entries (with a link to merge them).
3. Under **Messages**, choose what to capture, then click the button at the bottom of the popup. It names your choice and the file it saves, for example **Capture new messages and save a PDF**.

| Choice | What it does | Ends when |
| --- | --- | --- |
| **New messages** | Archives the messages that arrived since the last update, and reads the 2 days before it again (setting) to pick up edits, deletions and late replies. Preselected once the chat has something archived. | It has re-read back to the last update minus those days, and seen at least 8 archived messages again. |
| **Last 24 hours**, **Last 7 days**, **Last 30 days** | Archives the messages of that period. | The start of the period is reached, or it joins archived messages that already reach back that far. |
| **Full history** | Scrolls back to the beginning of the chat and archives everything. Preselected for a chat with nothing archived. | The beginning of the chat is reached, or it has caught up with a complete archive. |
| **From a date…** | Shows a date field, **From**, and archives the messages from midnight of that day. | As for a period. |
| **On screen** | Archives the messages Teams shows on screen, without scrolling. | At once. |

Every choice keeps the newer messages it passes on the way, so there is no "to" date: the archive never gets a hole between the period and now.

### Saving a file

With **Save a file** ticked (it is the first time; the popup remembers your choice), the capture ends by saving a file. Choose its **Format**; the line under the formats says what it makes:

- **PDF**, the default: opens the print dialog in a new tab. Choose **Save as PDF** as the printer.
- **Text**: one plain-text file, or a ZIP with the text and the pictures as files when **Pictures** is ticked.
- **JSON**: the complete records in one file, which **Import archive…** reads back.
- **ZIP package**: a ZIP with a Markdown transcript, the records and the pictures as files, for knowledge management systems. **Import archive…** reads it back too.

Under **Include in the file**, tick what it holds: pictures, file attachments, reply context, reactions, system messages and edit history. JSON and the ZIP package always include file attachments and reply context, because they are part of each record. The popup remembers these choices too. [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md) describes every format.

- The file holds the period captured (the last days, or from a date), the messages captured (**On screen**), or everything archived of the chat (**New messages**, **Full history**).
- A page of the extension saves it, in a new tab next to Teams, when the capture completes or stops on its own (for example at the maximum run duration). Closing the popup doesn't stop it. After **Stop** or a failure no file is saved.
- Files go to the browser's downloads. The popup's result names the file once it is saved.
- **Save a file from the archive only**, under the button, saves what the archive already holds of the chat (of the period chosen, or all of it) without capturing.

### Options and progress

The popup also shows how many messages are on screen. Under **Options**, **Re-read archived parts at normal speed** reads archived stretches again, with their images, instead of passing them quickly. Use it to pick up edits and deletions in older messages. The setting *Re-read archived parts by default* presets it. When the popup finds no chat or no messages, it says what to try.

During a run, the progress and **Stop** take the place of the capture controls. For a period, a bar shows how far back the run has reached; for the full history, whose beginning is unknown until it is reached, the popup says how far back it has got. The popup also says which file the run will save. Afterwards the result says what was captured and saved, and links to the chat in the archive.

**The last update** is the most recent run after which the archive held every message, without a gap, from the previous update up to the newest message. Any capture can be one: an update, a period or the full history, also one that was stopped once it got that far. A run that leaves a gap (for example a period of *24 hours* a week after the last update) is not, so the next **New messages** still goes back to the last update and closes the gap. The archive page shows the time of each chat's last update.

While a run is active, the popup shows progress and **Pause**, **Continue** and **Stop**. Everything captured so far is saved after every scroll step, so stopping or closing the tab loses nothing.

For long chats, click the side panel button at the top right of the popup (next to the archive button). The panel stays open while you work, unlike the popup.

**Keep the Teams tab visible.** Edge slows down background tabs, so the extraction pauses on its own while the tab is hidden and continues when you return. You can change this in the settings. Putting Teams in its own window works well.

### Resuming

If a run was interrupted, stopped or failed (tab closed or reloaded, browser closed, extension updated), the popup shows **Resume extraction** in the capture button's place the next time you open that chat (**Start another capture instead** shows the capture choices). Resuming repeats the same capture (the same period, the same reading) and continues where the previous run stopped:

- Through archived parts it takes steps of two screen heights instead of one, and doesn't read their images again. A skipped stretch counts as covered because the archive already holds it without a gap. If a step goes past the end of the archived part, the run steps back and continues normally.
- Teams loads older history only from the newest message backwards, so a resumed run still has to pass everything newer than where it stopped. That is quick but depends on how fast Teams loads older messages.
- Nothing runs while the browser or computer is off. Open the chat again and resume.

Running any capture again is always safe: messages are never stored twice.

## The archive page

Open it with the archive button at the top right of the popup, or via the extension's *Extension options*. It is one page: **Conversations**, then **Backup and import**, then **Settings**, with the version at the end. Each part has its own address (`archive.html#conversations`, `#backup`, `#settings`, `#settings/advanced`), so you can bookmark one; the addresses of earlier versions (`#overview`, `#export`) lead to the part that took their place.

- **Conversations**: each archived chat with its message count, number of saved images (click it to see them), completeness (*Complete*, *Not back to the start*, *Not checked*), archived period and last update. **Search** finds a chat by any word of its name, an earlier title or its key; filter by type and sort by recent activity, name or size. Click a chat's name to open its page:
  - the **message view** opens at the newest of the latest 200 messages (**Back to the top** below them), with a heading for each day, the sender's name once for messages less than five minutes apart, replies with the message they quote, pictures where they were sent (click one for full size), attachments with their links, and the earlier versions of edited messages. **Show earlier messages** loads the 200 before, keeping your place;
  - its actions, above the messages: **Save a file…** (the format and what to include, as in the popup, for every archived message of the chat), **Images** (each saved picture with who sent it and when, to view or download), **Rename…**, **Merge…** and **Delete…**.
- **Backup and import**: when the last full backup was made, with **Back up now** and **Import archive…**, then the totals: conversations, messages, saved images, complete histories and the space used. **Back up now** saves a ZIP package of every chat with everything in it, in a new tab; once it is saved, this part shows its date.
- **Settings**: General, and Advanced, which opens on request (see below).

What you can do with a chat:

- **Rename…** gives a chat its own name in the archive and in saved files. The title Teams shows stays visible below it, with earlier titles. Leave the name empty to show the Teams title again.
- **Merge…** combines two archive entries of the same chat, for example a chat archived under its old and its new title. The dialog lists first the entries that hold some of the same messages or have a similar name, and you choose the one to merge into. Every message is kept once, with its pictures and runs. A merge can't be undone, so back up first if in doubt. If the page closes during a merge, the merge finishes the next time the archive page opens.
- **Import archive…** (under Backup and import) merges a JSON file or a ZIP package back in. Use it to restore a backup or combine archives from two browser profiles. The whole file is checked before anything is written, so a damaged file changes nothing, and importing the same file twice changes nothing. An imported chat joins the entry of the same chat, also when that entry has another title. If the page closes during an import, the chat being imported is left incomplete; import the file again to complete it.

The pages follow the Windows light or dark theme (*Same as Windows*), or *Light* or *Dark* as you choose with **Theme** at the top right of the archive page, or the theme button in the popup and side panel. The choice applies at once, to every open page of the extension. They work with the keyboard alone (a **Skip to content** link, visible focus, headings to navigate by), and narrow windows show each table row as a short card.

### Settings

**General**

| Setting | Default | Meaning |
| --- | --- | --- |
| Scrolling speed | Normal | **Gentle**, **Normal** or **Fast** set the scrolling and waiting values below together (see the table after this one). **Custom** shows when the values under Advanced match no preset. |
| Maximum run duration | 360 min | Hard limit, so a run can never loop forever. |
| Update: days before the last update to check again | 2 | **New messages** (in the popup) reads this many days before the last update again, for edits, deletions and late replies. 0 to 30; 0 stops at the first archived messages. |
| Your display name | (empty) | Teams doesn't show your own name next to your messages. Enter it to record it as their sender. Your messages are marked as yours either way. |
| Date order used by Teams | auto | Order of numeric dates shown by Teams (for example 1/2/2024). It is used only when no exact timestamp is available. |
| Keep the pictures shown in messages | on | Keeps the pictures displayed in messages in the archive while capturing. See [Images](#images). Without them, no saved file can include pictures, whatever **Pictures** says. |
| Pause while the Teams tab is hidden | on | See above. |

**Advanced** (collapsed)

| Setting | Default | Meaning |
| --- | --- | --- |
| Scroll interval while capturing | 600 ms | Minimum time between scroll steps when reading new history. Raise it if Teams loads slowly. At least 250 ms. |
| Scroll interval through archived parts | 300 ms | Same, while passing through already-archived stretches. |
| Scroll step | 0.8 | Step size as a fraction of the visible height. It is reduced automatically if a step skips messages. |
| Smooth scrolling: animation per step | 250 ms | Each step glides instead of jumping (at most 120 ms through archived parts). 0 turns it off. A hidden tab always jumps. |
| Render quiet period | 350 ms | The page must stop changing for this long before a step counts as rendered. |
| Maximum render wait per step | 6000 ms | Upper limit for that wait. |
| Wait for older history at the top | 8000 ms | How long to wait for Teams to load older messages at the top of the list. |
| Attempts at the top before finishing | 3 | Attempts without new messages before the beginning is considered reached. |
| Steps without new messages before stopping | 25 | Guard against a list that has stopped responding. |
| Maximum scroll steps per run | 50,000 | Hard limit, like the maximum duration. |
| Update: archived messages to see again before stopping | 8 | The update also sees at least this many archived messages again. |
| Largest image to save | 10 MB | Larger images aren't saved; their name and link still are. 1 to 50 MB. |
| Re-read archived parts by default | off | Presets the popup's **Re-read archived parts at normal speed** (under **Options**). |
| Selector overrides | (empty) | See [When nothing is found](#when-nothing-is-found). **Reset to defaults** and **Insert default selectors** are here too. |

The scrolling speed presets:

| | Scroll interval | Through archived parts | Step | Animation | Quiet period | Render wait |
| --- | --- | --- | --- | --- | --- | --- |
| Gentle | 1000 ms | 600 ms | 0.6 | 400 ms | 500 ms | 8000 ms |
| Normal | 600 ms | 300 ms | 0.8 | 250 ms | 350 ms | 6000 ms |
| Fast | 300 ms | 150 ms | 1 | 150 ms | 250 ms | 5000 ms |

Settings saved by earlier versions are kept as they are: a speed is shown as a preset only when all six values match it.

## When nothing is found

The extension recognises Teams' page structure through a list of CSS selectors. Microsoft changes Teams Web from time to time, so a selector can stop matching.

1. Open the chat in Teams, wait until its messages are shown, and reload the Teams tab. If the popup still finds no messages, or a part of them is missing (for example the sender or the time), a selector no longer matches.
2. With the browser's developer tools (F12) on the Teams tab, find the element that holds the missing part, and a CSS selector that matches it, such as its `data-tid` attribute.
3. Under **Settings → Advanced → Selector overrides**, enter a JSON object that replaces just those lists, for example:

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
- Reactions: each emoji, how many people chose it and whether you did (not who the others are). A new reaction isn't an edit.
- System messages, such as someone being added to the chat.

Per chat, the extension also records the participants, the title (and earlier titles), the chat type (1:1, group, meeting, channel), the archived period, and whether the archive reaches back to the beginning.

### Images

When **Keep the pictures shown in messages** is on (the default), every picture that a run sees in a message is saved once into the archive and linked from the message's attachment.

- The extension copies the picture Teams already displays. It first reads the page's own copy (Teams usually shows images from a `blob:` address) or the browser cache. Only if neither is available does it request the same image address again, as the page did. If that isn't possible either, it copies the displayed picture through a canvas, which is saved as PNG.
- An image is named by the SHA-256 hash of its bytes. The same picture shown twice is stored once.
- Teams usually displays a preview size, so the saved copy may be smaller than the original upload.
- Images the browser doesn't allow the extension to read (shown from another site without permission), images that never finish loading, and images above **Largest image to save** aren't saved. Their name and link are kept, the run counts them as *not saved*, and a warning explains why.
- Emoji are kept as text, not as images.
- A picture is read once per run. Pictures of archived messages that are shown unchanged are taken from the archive instead of being read again; **Re-read archived parts** reads them again.
- Saved images are included in JSON files (as base64) and ZIP packages (as files), and restored by **Import archive…**. A PDF shows each picture in its message; a text file with pictures is a ZIP with the pictures as files.
- Profile pictures (for example of the original sender in a forwarded message) aren't message content and aren't saved.

## Data and privacy

- The archive lives in the extension's IndexedDB in your Edge profile, which the extension's own pages read directly. Content scripts run only on the Teams domains listed in the manifest. The extension sends nothing anywhere. Its only requests re-read images the open chat is displaying, normally from the page's own copy or the browser cache (see [Images](#images)); turn off **Keep the pictures shown in messages** to avoid them.
- **Removing the extension deletes its archive.** Back up first (archive page → **Backup and import → Back up now**). Back up regularly anyway.
- Saved files contain your messages in plain text, and your saved images unless **Pictures** is off. Store them accordingly.

## Limitations

- It works through Teams Web's page structure, not an official API. Teams updates can require selector overrides, or an extractor update, before extraction works again.
- It's designed for chats. Channel posts may be read partially, but reply threads under channel posts aren't expanded.
- Read receipts and the contents of attached files aren't captured. Reactions are captured (each emoji, its count and whether you chose it, not who else did). A reaction removed in Teams after it was archived stays until another reaction on that message is seen. Images are saved as displayed (often a preview size). Images the browser won't let the extension read are kept as name and link only.
- Files are written, and imports read, in parts, so a large archive doesn't have to fit in memory. A file of several gigabytes can still be more than the browser allows for one download; save one chat, a period, or without pictures.
- When a reply quotes more than one message, only the first quote is kept with it. The words of the other quotes are left out of the message, not mixed into it.
- A chat is identified by its Teams thread id, which Teams Web shows in the chat header. A chat that an earlier version archived under its title continues in that entry once the id is read, unless the entry's messages show it is a different chat. If the id can't be found on the page, the extension goes by the chat title and by the archived messages the chat shows:
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

`npm run check` runs all three. `npm run watch` rebuilds on every change. `npm run package` builds without source maps and writes the store upload, `release/teams-chat-scraper-<version>.zip` (see [docs/STORE_LISTING.md](docs/STORE_LISTING.md) and the [privacy policy](docs/PRIVACY.md)). `npm run icons` regenerates the logo files from the one description in `scripts/logo.ts` (it needs Node.js 22.18 or newer, which runs TypeScript directly); a test fails when the committed files no longer match it.

```
src/
  manifest.json
  shared/      types, settings, messaging protocol, hashing, time parsing
  extractor/   reads the Teams DOM: selectors, conversation detection, message parsing
  scraper/     the scroll-and-capture engine: pause/resume/stop, render detection, ordering
  storage/     IndexedDB archive: schema, merge rules, coverage, reply resolution, chat identity and merging
  export/      export format v1, the pipeline that writes the files (a printable page for PDF, text, JSON, the ZIP package with its Markdown transcript), ZIP writing and reading, streaming import
  background/  service worker: routes captured batches into the archive
  content/     content script: runs the engine in the Teams tab
  ui/          popup / side panel, the save page and its form, the archive page (archive.ts, with its parts in ui/archive/), themes, and the view models the screens draw
icons/         the logo: SVG masters (logo.svg, and logo-16.svg for 16 px) and the extension's PNG icons
store/         store listing images (300 × 300 logo, 440 × 280 tile); not part of the extension
scripts/       build, and the logo description and generator
DESIGN.md      the design direction of the pages (palette, type, focal points, writing)
.claude/skills/ antislop rules that AI coding agents apply to interface work (see AGENTS.md)
tests/
  unit/         parsing, dates, ordering, coverage, merge rules, controls, saved files, view models, colours
  integration/  engine on a simulated virtualised Teams chat, archive repository, end-to-end pipeline, saving a file after a capture
  helpers/      Teams-like DOM fixtures and the chat simulator
```

The integration tests run the real engine against a simulated Teams message list. The simulator renders only the messages near the viewport, loads older history with a delay when you scroll to the top, groups consecutive messages from one sender, and can drop ids, timestamps or authors. The tests cover 1:1 and group chats, multi-paragraph messages, attachments, replies, missing metadata, a 2,000-message history, interrupted and resumed sessions, pause/resume/stop, incremental updates, edits and duplicate prevention.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works, and [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md) for the file format you can build an import into another system on.

## Trademarks

This is an independent project. It is not affiliated with, endorsed by or sponsored by Microsoft. Microsoft, Microsoft Teams and Microsoft Edge are trademarks of the Microsoft group of companies, and are named here only to say what the extension works with. The extension's logo and colours are its own and don't use Microsoft's.
