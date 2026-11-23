# Manual checklist

What to check by hand in Edge after a change to the interface, before a release. The automated tests cover the logic behind each screen (`tests/unit/view-models.test.ts`, the colour contrast in `tests/unit/logo.test.ts`); this list covers what only a real browser shows.

Build with `npm run build`, click **Reload** on the extension card in `edge://extensions`, and reload the Teams tab.

## Popup and side panel

- [ ] The popup, the side panel and the archive page are titled *Teams Chat Scraper*, and so is the toolbar button's tooltip; the archive page's tabs read *Overview · Teams Chat Scraper*.

- [ ] In a Teams chat, the popup shows the chat's name, its type, and one summary line (for example *451 messages · complete back to 3 Jan 2023 · updated 3 days ago*). A chat with nothing archived says *Not archived yet*.
- [ ] No warning shows for a chat that is archived normally. A chat archived in two entries says so, with a link that opens the entry in the archive.
- [ ] The header buttons: the theme button steps through Same as Windows, Light and Dark (its icon a screen, a sun, a moon) and an open archive page follows at once; the archive button opens the archive page; the side panel button opens the side panel and closes the popup. In the side panel, the side panel button is hidden.
- [ ] **Capture** shows four tiles, preset to **New messages** (*Since the last update, 3 days ago*) for an archived chat and **Full history** otherwise; for a chat with nothing archived, **New messages** is disabled. The button under the tiles names the choice (*Capture new messages*, *Capture the last 7 days*, *Capture the full history*…) and runs it. **A period** shows *24 hours · 7 days · 30 days · From a date…* under the tiles; *From a date…* shows a date field labelled **From**. **On screen** archives without scrolling, and turns the re-read box off.
- [ ] With the keyboard: Tab reaches the chosen tile, the arrow keys move between the tiles and between the periods, and the focus ring goes around the whole tile.
- [ ] The chat card shows the number of messages on screen. **Options** opens to show **Re-read archived parts** and a **Troubleshooting** link. With *Re-read archived parts by default* turned on in Settings, the re-read box starts ticked.
- [ ] **Troubleshooting** opens Settings › Troubleshooting with this Teams tab chosen.
- [ ] On a Teams page with no chat open, the popup offers the Troubleshooting link on its own.
- [ ] During a run the capture card is hidden and **Stop** is on screen without scrolling; progress, **Pause**, **Continue** and **Stop** work. For **A period**, a bar fills as the run reaches back (*Back to 14 Nov 09:12, going back to 23 Oct*); for **Full history** there is no bar, only *Reached back to …*. After it, the result shows with **Open this chat in the archive** and **Export this chat…**, which opens Export with only this chat selected.
- [ ] After an interrupted run, **Resume extraction** stands where the capture button was, with what the run captured; **Start another capture instead** shows the tiles and the capture button.
- [ ] The side panel at its narrowest (about 300 px) scrolls only up and down, in every state.
- [ ] In a tab opened before the extension was reloaded, the popup offers **Connect to this tab**.

## Archive page

- [ ] The navigation shows Overview, Conversations, Export and Settings; the current one is highlighted and underlined, and the tab title names it.
- [ ] Back and Forward move between sections, and reloading keeps the section.
- [ ] **Overview**: the Backup card comes first, with the last full backup and **Back up now…**, then the totals, which match the Conversations list; latest activity links to the chats; recent runs show the latest 5, and **Show all runs (N)** the rest; **Back up now…** opens Export with *Full backup* set, and after that export Overview says *Last full backup just now* with its totals.
- [ ] With an empty archive (a new browser profile): Overview says *Nothing to back up yet* with **Back up now…** disabled, and every list says what to do next; Export says there is nothing to export.
- [ ] **Conversations**: typing in the search narrows the list (try a word of an earlier title); the type filter and the sorting work; the count says *N of M conversations*. A search that matches nothing offers **Show all conversations**, which clears it.
- [ ] Clicking a chat's name opens its messages, scrolled to the newest at the bottom, with **Back to the top** below it: a heading for each day, the sender's name once for messages from one person less than five minutes apart, replies with their quote, pictures in place (click opens full size), attachments with links, and *Earlier version* under edited messages.
- [ ] In a chat with more than 200 messages, **Show earlier messages** adds the earlier ones above without moving what you were reading. While it loads it says *Loading earlier messages…*, and a double click adds the page once. Pictures keep their place as they load.
- [ ] On a chat's page, **Export…**, **Images (N)**, **Rename…**, **Merge…** and **Delete…** work; in the list, the number of saved images opens them. **Rename…** and **Delete…** open the page's own dialogs: Escape cancels, Delete opens with the focus on **Cancel**, and deleting returns to the list.
- [ ] Below 760 px each Conversations row and each run is a short card (name, then a summary line); links are 44 px tall on a touch screen, and nothing scrolls sideways at 375 px.
- [ ] **Export**: the order is preset, format tiles (with what the format makes, and **What is inside** for JSON and the package), packaging (HTML only), messages, content, conversations. The button names what it writes (*Export 2 conversations (ZIP)*; *Open the print dialog* for PDF). **Export…** on one chat opens Export with only that chat selected; the presets set their choices and their tile says *In use* until a choice departs from them; an HTML, a CSV and a knowledge package export download; *PDF (print)* opens the print dialog. With **Select none**, Export is disabled and says *Select at least one conversation*.
- [ ] The bar at the bottom of the Export card stays at the window's bottom edge while you scroll the card, and says *Will save* with the name the download gets (for PDF, *Opens the print dialog in a new tab*). During an export the button reads *Exporting…* and the bar says how many messages have been written (with a bar for several conversations); afterwards it shows the result until a choice changes. Below 760 px the button spans the bar.
- [ ] In the conversation list, **Filter by name** narrows it, the type chips (shown when the archive holds two kinds of chat or more) narrow it by type, **Select shown** selects only the shown chats, and the count says *(N not shown)* for selected chats the filter hides. A filter that matches nothing says so. From 1200 px the conversations stand beside the other choices.
- [ ] **Import archive…** (from Export or Storage) imports a knowledge package and shows its progress and result.
- [ ] **Reactions**: after capturing a chat in which messages have reactions, the message view shows *Reactions: 👍 2 · ❤️ 1 (yours: 👍)* under them, with the right counts, and *yours* only for reactions you chose. Adding a reaction in Teams and capturing **New messages** updates the line, without marking the message edited. HTML, Markdown, text and CSV exports show the same line; with **Reactions** unticked in Export they don't.

## Settings

- [ ] **Theme** (in the archive page's header): *Light* and *Dark* apply at once, also to an open popup or side panel and another archive tab; *Same as Windows* follows the Windows setting (Settings › Personalisation › Colours). No page flashes in the other theme when it opens.
- [ ] **Scrolling speed**: choosing *Gentle*, *Normal* or *Fast* fills the six values under Advanced; changing one of them shows *Custom*. After **Save settings** and a reload, the choice is kept.
- [ ] Settings saved by version 1.5 open unchanged (custom values show as *Custom*).
- [ ] An out-of-range value is corrected on saving, and the message names it. An invalid selector override is refused, with Advanced opened.
- [ ] **Storage** shows the space used and the totals.
- [ ] **Troubleshooting**: **Find Teams tabs** lists the open Teams tabs; **Run diagnostics** shows the chat, the number of messages on screen and a summary; **Copy report** copies the JSON. In a Teams tab opened before the extension was reloaded, it says to reload the tab.

- [ ] In a chat with reactions, **Run diagnostics** says *N with reactions* in its summary, with no warning about reaction markup, and `reactionReads` shows `"read": true` for each reaction. If it warns, send the report: the reaction selectors need an update.
- [ ] The copied report starts with `extensionVersion` and has `"reportVersion": 5`; searching it for a name, a word of a message or an emoji shown on screen finds nothing.
- [ ] In a 1:1 chat and in a group chat, the report shows `"hasThreadId": true`, the type `one-on-one` or `group`, and no warning about the thread id. The popup doesn't say the chat is recognised by its title.
- [ ] A chat archived before 1.8.1: capturing **New messages** continues its archive entry (the message count grows, no second entry with the same name appears), and the entry then shows its type.
- [ ] In a chat with quoted replies, `replyWithSender` equals `withReply` in the report, and the message view names the quoted sender instead of *an earlier message*.
- [ ] **About** (at the end of Settings) shows *Teams Chat Scraper, version …* with the current version, and the not-affiliated note.

## Release

- [ ] `npm run package` writes `release/teams-chat-scraper-<version>.zip`. Unzipped into a new folder and loaded with **Load unpacked**, it works like the development build, and `edge://extensions` shows the name, version and description.

## Keyboard, contrast and size

- [ ] With the keyboard alone: Tab shows **Skip to content** first; every control can be reached and shows a focus ring; Enter and Space work on buttons, links and **More**/**Advanced**.
- [ ] After choosing a section in the navigation, the focus is on its heading (a screen reader reads the section's name).
- [ ] Text is readable in both themes, also muted text on hovered rows, placeholders and the side panel. Button and field outlines are clearly visible in both themes.
- [ ] With a mouse, buttons, fields and navigation entries are at least 32 px tall; on a touch screen, 44 px. A pressed button shows a heavier bottom edge. Checkboxes and their labels show the hand cursor, disabled controls the *not allowed* cursor.
- [ ] At a window width below 760 px (or the side panel), tables become cards with labelled cells, the navigation gets its own row, and nothing needs sideways scrolling.
- [ ] At 200 % zoom the pages still work.
