# Manual checklist

What to check by hand in Edge after a change to the interface, before a release. The automated tests cover the logic behind each screen (`tests/unit/view-models.test.ts`, the colour contrast in `tests/unit/logo.test.ts`); this list covers what only a real browser shows.

Build with `npm run build`, click **Reload** on the extension card in `edge://extensions`, and reload the Teams tab.

## Popup and side panel

- [ ] In a Teams chat, the popup shows the chat's name, its type, and one summary line (for example *451 messages · complete back to 3 Jan 2023 · updated 3 days ago*). A chat with nothing archived says *Not archived yet*.
- [ ] No warning shows for a chat that is archived normally. A chat archived in two entries says so, with a link that opens the entry in the archive.
- [ ] The two header buttons: the archive button opens the archive page; the side panel button opens the side panel and closes the popup. In the side panel, the side panel button is hidden.
- [ ] **Capture** is preset to *New messages since the last update* for an archived chat and *Full history* otherwise; **Start** runs it. *From a date…* shows a date field labelled **From**.
- [ ] **More** opens to show **Visible only**, **Re-read archived parts**, the number of messages on screen and a **Troubleshooting** link. With *Re-read archived parts by default* turned on in Settings, the re-read box starts ticked.
- [ ] **Troubleshooting** opens Settings › Troubleshooting with this Teams tab chosen.
- [ ] On a Teams page with no chat open, the popup offers the Troubleshooting link on its own.
- [ ] During a run: progress, **Pause**, **Continue** and **Stop** work; after it, the result shows. After an interrupted run, **Resume extraction** is the primary button.
- [ ] In a tab opened before the extension was reloaded, the popup offers **Connect to this tab**.

## Archive page

- [ ] The navigation shows Overview, Conversations, Export and Settings; the current one is highlighted and underlined, and the tab title names it.
- [ ] Back and Forward move between sections, and reloading keeps the section.
- [ ] **Overview**: the totals match the Conversations list; latest activity links to the chats; recent runs show the last runs; **Back up now…** opens Export with *Full backup* set, and after that export Overview says *Last full backup just now* with its totals.
- [ ] With an empty archive (a new browser profile): Overview says *Nothing to back up yet* with **Back up now…** disabled, and every list says what to do next; Export says there is nothing to export.
- [ ] **Conversations**: typing in the search narrows the list (try a word of an earlier title); the type filter and the sorting work; the count says *N of M conversations*. A search that matches nothing offers **Show all conversations**, which clears it.
- [ ] Clicking a chat's name opens its messages: the newest at the bottom, a heading for each day, replies with their quote, pictures in place (click opens full size), attachments with links, and *Earlier version* under edited messages.
- [ ] In a chat with more than 200 messages, **Show earlier messages** adds the earlier ones above without moving what you were reading. While it loads it says *Loading earlier messages…*, and a double click adds the page once. Pictures keep their place as they load.
- [ ] **Export…**, **Images**, **Rename**, **Merge…** and **Delete** work from the list and from the message view. Deleting from the message view returns to the list.
- [ ] **Export**: **Export…** on one chat opens Export with only that chat selected; the presets set their choices; an HTML, a CSV and a knowledge package export download; *PDF (print)* opens the print dialog. With **Select none**, Export is disabled and says *Select at least one conversation*.
- [ ] **Import archive…** (from Conversations, Export or Storage) imports a knowledge package and shows its progress and result.

## Settings

- [ ] **Theme**: *Light* and *Dark* apply at once, also to an open popup or side panel and another archive tab; *System* follows the Windows setting (Settings › Personalisation › Colours). No page flashes in the other theme when it opens.
- [ ] **Scrolling speed**: choosing *Gentle*, *Normal* or *Fast* fills the six values under Advanced; changing one of them shows *Custom*. After **Save settings** and a reload, the choice is kept.
- [ ] Settings saved by version 1.5 open unchanged (custom values show as *Custom*).
- [ ] An out-of-range value is corrected on saving, and the message names it. An invalid selector override is refused, with Advanced opened.
- [ ] **Storage** shows the space used and the totals.
- [ ] **Troubleshooting**: **Find Teams tabs** lists the open Teams tabs; **Run diagnostics** shows the chat, the number of messages on screen and a summary; **Copy report** copies the JSON. In a Teams tab opened before the extension was reloaded, it says to reload the tab.

## Keyboard, contrast and size

- [ ] With the keyboard alone: Tab shows **Skip to content** first; every control can be reached and shows a focus ring; Enter and Space work on buttons, links and **More**/**Advanced**.
- [ ] After choosing a section in the navigation, the focus is on its heading (a screen reader reads the section's name).
- [ ] Text is readable in both themes, also muted text on hovered rows, placeholders and the side panel. Button and field outlines are clearly visible in both themes.
- [ ] With a mouse, buttons, fields and navigation entries are at least 32 px tall; on a touch screen, 44 px. A pressed button shows a heavier bottom edge. Checkboxes and their labels show the hand cursor, disabled controls the *not allowed* cursor.
- [ ] At a window width below 760 px (or the side panel), tables become cards with labelled cells, the navigation gets its own row, and nothing needs sideways scrolling.
- [ ] At 200 % zoom the pages still work.
