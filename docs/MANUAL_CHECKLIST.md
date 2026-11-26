# Manual checklist

What to check by hand in Edge after a change to the interface, before a release. The automated tests cover the logic behind each screen (`tests/unit/view-models.test.ts`, the colour contrast in `tests/unit/logo.test.ts`); this list covers what only a real browser shows.

Build with `npm run build`, click **Reload** on the extension card in `edge://extensions`, and reload the Teams tab.

## Popup and side panel

- [ ] The popup, the side panel and the archive page are titled *Teams Chat Scraper*, and so is the toolbar button's tooltip; a chat's page in the archive reads *Project Alpha · Teams Chat Scraper*.

- [ ] In a Teams chat, the popup shows the chat's name, its type, and two summary lines (for example *451 messages · updated 4 days ago*, then in muted text *4–24 Nov 2026 · partial history*, with the dates as the browser's language writes them). A chat with nothing archived says *Not archived yet*, with no second line.
- [ ] No warning shows for a chat that is archived normally. A chat archived in two entries says so, with a link that opens the entry in the archive.
- [ ] The header buttons: the theme button steps through Same as Windows, Light and Dark (its icon a screen, a sun, a moon) and an open archive page follows at once; the archive button opens the archive page; the side panel button opens the side panel and closes the popup. In the side panel, the side panel button is hidden.
- [ ] **Messages to capture** is one row of three segments, 36 px tall, each with its icon before its name (*New*, *Date range*, *Full history*); there is no *On screen*. In the side panel at 300 px each icon sits above its name and no name is cut off. It is preset to **New** (*Since 22 Nov, plus 2 earlier days for edits.*) for an archived chat and **Full history** otherwise; for a chat with nothing archived, **New** is disabled. **Date range** shows **Period** as four equal segments in one row (*24 hours · 7 days · 30 days · From…*, 7 days the first time; a screen reader reads the last as *From a date*); **From…** shows a date field labelled **From**. The popup has no cards: the chat, **Messages to capture** with **Options**, and **Save a file** sit on the background, each padded 16 px, with a rule from edge to edge between them. The four formats stay on one row (*PDF · Text · JSON · ZIP*), with **Include in the file** 16 px under them and no rule between; nothing scrolls sideways, also in the side panel at 300 px. In the archive's **Save a file…** dialog the formats stay on one row too, with a rule before **Include in the file**.
- [ ] The header is 44 px tall and the status bar at the bottom 32 px. The status bar says *Connected to Teams* with *N messages on screen*, its dot green (*no chat open* with a grey dot on a Teams page without a chat); during a run, only *Keep this Teams tab open*, the dot blue (amber while paused).
- [ ] **Save a file** is ticked the first time, and keeps its state when the popup opens again. Ticked, it shows **Format** (*PDF · Text · JSON · ZIP*, PDF the first time) with a line under it saying what the format makes, and **Include in the file** in two columns, each box with its icon. For JSON and the ZIP package, *File attachments* and *Reply context* are ticked and disabled, with the note under the list; back on PDF they show what was chosen before. Unticked, the format and the list are hidden.
- [ ] The button in the bar at the bottom names the capture and the file (*Capture new messages · save PDF*, *Capture the last 7 days · save ZIP*; with **Save a file** unticked, *Capture new messages*), and changes with the capture and the format. The bar stays just above the status bar while the choices scroll. **Save a file from the archive only** shows under the include list when the chat has archived messages and **Save a file** is ticked.
- [ ] With the keyboard: Tab reaches the chosen option, the arrow keys move between the captures, the periods and the formats, and the focus ring goes around the whole segment. The chosen one has a two-line accent ring and its name in blue.
- [ ] **Options** opens to show **Re-read archived parts**, with *Finds edits and deletions. Slower.* under it (its chevron turns). With *Re-read archived parts by default* turned on in Settings, the re-read box starts ticked.
- [ ] On a Teams page with no chat open, or a chat whose messages are not found, the popup says what to try: open a chat, wait until its messages are shown, reload the Teams tab.
- [ ] During a run the capture section is hidden and **Stop** is on screen without scrolling. The run shows its phase with the time so far (*Capturing since 16 Nov, 10:00…* and *1m 05s*), a bar for a period, one line saying how far back it has got (*Reached 22 Nov, 08:47 · going back to 16 Nov, 10:00*; for **Full history** only *Reached 22 Nov, 08:47*, with no bar), the counts *New*, *Updated* and *Already archived* (no *Seen*, no line about scroll steps), and a line naming the file it will save. **Pause**, **Continue** and **Stop** work.
- [ ] When the run completes, a tab opens next to Teams with the save page. For PDF it shows the chat and opens the print dialog (**Save as PDF** saves it; **Print again** opens the dialog again); for the other formats the file goes to the browser's downloads and the page names it. With the popup closed during the run, the file is saved all the same. The popup's result then reads *Done · 3 new messages*, with *0 updated · 40 already archived* in muted text under it, then *Saved Project-Alpha-….txt* (or *Opened the print dialog to save a PDF.*) and **Open in the archive**.
- [ ] After **Stop**, no tab opens, and the result says no file was saved because the capture did not finish.
- [ ] **Save a file from the archive only** opens the save page for the chat without capturing, for the period chosen: *Date range* with *7 days* saves those 7 days, *New* everything archived.
- [ ] After an interrupted run, **Resume extraction** stands where the capture button was, with what the run captured; **Start another capture instead** shows the choices and the capture button. A resumed run saves the file the interrupted one had chosen.
- [ ] The side panel at its narrowest (about 300 px) scrolls only up and down, in every state; the capture, period and format rows fit, with each icon above its name, and the include list wraps without overflowing.
- [ ] In a tab opened before the extension was reloaded, the popup offers **Connect to this tab**.

## Save page

- [ ] It names what it saves (the chat, or *All archived chats*; the format and the period) and says how many messages it has written; for several chats, a bar shows which one it is writing.
- [ ] A chat with no messages in the period says nothing was saved, and nothing is downloaded.
- [ ] Opened as `save.html` alone, it says *Nothing to save*.

## Archive page

- [ ] The page shows Conversations, Backup and import, and Settings one under the other, with the version line at the end, and no navigation. `#backup`, `#settings` and `#settings/advanced` (Advanced open) bring their part into view, with the focus on its heading; the addresses `#overview` and `#export` of earlier versions lead to Backup and import.
- [ ] Back and Forward move between the page and a chat's page, and reloading keeps what is shown.
- [ ] **Backup and import**: one line with the last full backup (*No full backup has been made from this browser profile yet.* at first), the warning *Stored only in this browser. Back up regularly.*, **Back up now** and **Import archive…**, then, under a rule, the totals, which match the Conversations list, and the space used. **Back up now** opens the save page, which downloads a ZIP package of every chat; afterwards this part says *Last full backup just now* with its totals.
- [ ] With an empty archive (a new browser profile): Backup and import says *Nothing to back up yet* with **Back up now** disabled, and the list says what to do next.
- [ ] **Conversations**: typing in the search narrows the list (try a word of an earlier title); the type filter and the sorting work; the count says *N of M conversations*. **Last update** shows how long ago (*3 days ago*), with the date and time in its tooltip; the history badges read *Complete*, *Partial* or *Not checked*. A search that matches nothing offers **Show all conversations**, which clears it.
- [ ] Clicking a chat's name opens its messages, scrolled to the newest at the bottom, with **Back to the top** below it: a heading for each day, the sender's name once for messages from one person less than five minutes apart, replies with their quote, pictures in place (click opens full size), attachments with links, and *Earlier version* under edited messages.
- [ ] In a chat with more than 200 messages, **Show earlier messages** adds the earlier ones above without moving what you were reading. While it loads it says *Loading earlier messages…*, and a double click adds the page once. Pictures keep their place as they load.
- [ ] A chat's page shows its name, then two lines: its type, people and message count, then its period, history and last update; its key is not shown. **Save a file…** and **Images (N)** are buttons, and **⋯** opens a menu with **Rename…**, **Merge…**, **Copy chat key** and, after a rule, **Delete…** in red. The menu works with the keyboard (the arrow keys, Home and End; Escape closes it and returns to **⋯**) and closes on a click elsewhere; **Copy chat key** puts the key on the clipboard and says so. All of them work; in the list, the number of saved images opens them. **Save a file…** asks for the format and what to include in a dialog whose button names the file (*Save a PDF*), then opens the save page. The dialogs are the page's own: Escape cancels, Delete opens with the focus on **Cancel**, and deleting returns to the list.
- [ ] Below 760 px each Conversations row is a short card (name, then a summary line); links are 44 px tall on a touch screen, and nothing scrolls sideways at 375 px.
- [ ] **Import archive…** imports a ZIP package and a JSON file, and shows its progress and result.

## Reading Teams

- [ ] **Reactions**: after capturing a chat in which messages have reactions, the message view shows *Reactions: 👍 2 · ❤️ 1 (yours: 👍)* under them, with the right counts, and *yours* only for reactions you chose. Adding a reaction in Teams and capturing with **New** updates the line, without marking the message edited. PDF and text files show the same line; with **Reactions** unticked they don't.
- [ ] In a 1:1 chat and in a group chat, the popup shows the chat's type and doesn't say the chat is recognised by its title.
- [ ] A chat archived before 1.8.1: capturing with **New** continues its archive entry (the message count grows, no second entry with the same name appears), and the entry then shows its type.
- [ ] In a chat with quoted replies, the message view names the quoted sender instead of *an earlier message*.

## Settings

- [ ] The theme button (in the archive page's header, its tooltip *Theme: Same as Windows. Click for Light.*): *Light* and *Dark* apply at once, also to an open popup or side panel and another archive tab; *Same as Windows* follows the Windows setting (Settings › Personalisation › Colours). No page flashes in the other theme when it opens.
- [ ] **General** holds, each with a short label and a muted line under it, the scrolling speed, **Longest run**, **Recheck days**, your display name, the date order, **Keep pictures while capturing** and **Pause when the Teams tab is hidden**. **Advanced** is closed until opened, and holds the other values and the selector overrides.
- [ ] **Scrolling speed**: choosing *Gentle*, *Normal* or *Fast* fills the six values under Advanced; changing one of them shows *Custom*. After **Save settings** and a reload, the choice is kept.
- [ ] Settings saved by version 1.5 open unchanged (custom values show as *Custom*).
- [ ] An out-of-range value is corrected on saving, and the message names it. An invalid selector override is refused, with Advanced opened.
- [ ] The line at the end of the page reads *Teams Chat Scraper 1.12.0 · Not made by or affiliated with Microsoft; …* with the current version, on one line in a wide window.

## Release

- [ ] `npm run package` writes `release/teams-chat-scraper-<version>.zip`. Unzipped into a new folder and loaded with **Load unpacked**, it works like the development build, and `edge://extensions` shows the name, version and description.

## Keyboard, contrast and size

- [ ] With the keyboard alone: Tab shows **Skip to content** first; every control can be reached and shows a focus ring; Enter and Space work on buttons, links and **Options**/**Advanced**.
- [ ] After following an address to a part of the page, or **All conversations**, the focus is on its heading (a screen reader reads its name).
- [ ] Text is readable in both themes, also muted text on hovered rows, placeholders and the side panel. Button and field outlines are clearly visible in both themes.
- [ ] With a mouse, buttons, fields and segments are at least 32 px tall; on a touch screen, 44 px. A pressed button shows a heavier bottom edge. Checkboxes and their labels show the hand cursor, disabled controls the *not allowed* cursor.
- [ ] Every page is set in Segoe UI (in the developer tools, *Rendered fonts*), with Consolas only for the selector overrides. Icons have even 1.5 px lines at 16 and 20 px, in both themes.
- [ ] At a window width below 760 px (or the side panel), tables become cards with labelled cells, and nothing needs sideways scrolling.
- [ ] At 200 % zoom the pages still work.
