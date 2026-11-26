# Design direction

The look and voice of the extension's pages: the popup, the side panel, the archive page and the save page. This file states the direction; `src/ui/ui.css` holds the values, and the antislop skills in `.claude/skills/` are the filter applied on top (see `AGENTS.md`). When the two disagree, change one of them on purpose, not by accident.

It records the decisions already made (Phase 4 and 5 of [docs/IMPROVEMENT_PLAN.md](docs/IMPROVEMENT_PLAN.md), antislop audits [001](anti-slop/audit-001-2026-11-22.md) and [002](anti-slop/audit-002-2026-11-22.md), proposal [004](anti-slop/proposal-004-2026-11-23.md), which moved saving a file into the popup and made the archive one page, and the owner's Claude Design prototype of November 2026, which brought the capture tiles, the status bar and the icons; its Geist type was tried in 1.10 and dropped again in 1.11). Change it when the direction changes.

## Design read

Reading this as: a personal archiving tool inside Edge, for someone keeping their own Teams chats, in a quiet Windows-native utility style, dial **ENERGY 1 / RHYTHM 1 / MOTION 1**.

Dial: ENERGY 1 / RHYTHM 1 / MOTION 1

- **ENERGY 1.** The pages are opened to do one job (archive a chat and save it as a file, find a message, fix a setting) and closed again. They should feel like part of the browser, calm and dependable, not like a product trying to impress.
- **RHYTHM 1.** Lists and tables are uniform on purpose: every conversation and setting is the same kind of thing, and a regular grid makes them quick to scan and compare. Variety comes from the content (a chat's messages, its pictures), not from the layout.
- **MOTION 1.** Hover and focus states only, with a 120 ms colour fade on hover (none when Windows asks for reduced motion). Nothing animates on its own; progress is shown as numbers and text that update. A bar may show a share that is known (how far back a capture of a period has reached, which chat the save page is writing): it changes in steps, with no transition. Where the end is unknown (the full history), progress is text only.

## Identity

- **Who it is for.** One person archiving the chats their own account can see, on their own computer. No team, no sign-up, no cloud.
- **Personality.** Plain, careful, honest. It says exactly what it did and what it did not do, and never claims more than it knows (a history that does not reach the chat's beginning says "not back to the start").
- **Not affiliated with Microsoft.** Nothing may use the Teams logo, Teams purple (`#5b5fc7` and its relatives) or anything that reads as an official Microsoft product.
- **Identity motif.** The logo: an archive box shaped like a speech bubble, white on a blue tile. It appears once, in the page header, at 20 or 24 px. No other illustration or decoration.

## Palette

One accent, neutral greys, and the few status colours the content needs. Every value is in `src/ui/ui.css` (light, and dark twice: for *System* and for *Dark*); `tests/unit/logo.test.ts` keeps every text pair at 4.5:1 or more, and the control outline and the status graphics (success, accent, warning, danger) at 3:1 or more.

| Role | Light | Dark | Used for |
| --- | --- | --- | --- |
| Accent | `#1f5fbf` | `#7aaaf5` | The one primary button of a view, links, the focus ring, the edge of a chosen segment, and the fill of a progress bar. Nowhere else. |
| Background, card | `#f5f5f7`, `#ffffff` | `#1b1b1f`, `#26262c` | Page and surface. |
| Text, muted | `#1f1f24`, `#63636e` | `#ececf1`, `#a3a3ad` | Content; secondary details (dates, keys, hints). |
| Border, hover, selected | `#dcdce3`, `#eef0f4`, `#e3ecfa` | `#3a3a44`, `#30303a`, `#24344d` | Structure (card edges, table rules) and state. |
| Control border | `#86868f` | `#7a7a86` | The outline of buttons, selects and fields: 3:1 or more against card and page, so a control can be found. |
| Danger | `#c4314b` | `#f1707f` | Delete and Stop, errors. |
| Warning | `#8a5300` | `#f3b65c` | Warnings that need an action. |
| Success | `#2f8a45` | `#6cc488` | Graphics only, at 3:1 or more: the status dot when the popup reaches Teams, and the check of a run that finished. |
| Notice, success, error backgrounds | `#eaf1fb`, `#e7f5ea`, `#fbe9ec` | `#1f2a3b`, `#1e3324`, `#3d2228` | Status messages, run results and badges. |

The theme follows Windows (*Same as Windows*) unless the user chooses Light or Dark with the theme button in the header of the popup, the side panel and the archive page, which shows the one in use and steps through the three. It applies at once, to every page of the extension. Neither theme is the "real" one.

No gradients, glow, glass, background textures or decorative shadows. A shadow is allowed only on something that floats above the page (a dialog).

## Typography

- **Segoe UI** (then the system font), because the extension lives in Edge on Windows and should read like the browser around it. The owner tried Geist in version 1.10 and returned to Segoe UI in 1.11: a bundled display face made the pages look like a web product rather than part of the browser. No font is bundled or downloaded.
- Sizes 12, 13, 14 (body), 16 and 20 px, each with its line height: 12/16, 13/18, 14/20, and 1.25 for titles. No letter-spacing anywhere.
- Two weights, because Segoe UI has no medium (a 500 would draw as 400): **600** for titles, group headings (*Messages to capture*, *Format*, *Options*), sender names, chat names and the numbers that matter; **400** for everything else, controls and labels included. The hierarchy comes from size, weight and colour together: 16 px for section titles, 20 px only for a chat's name on its page, and nothing larger. Counts that change while you watch use tabular figures, which Segoe UI has.
- **Consolas** only for machine values the user may need to copy exactly: conversation keys and the selector overrides. Never for headings, labels, logs or decoration.
- Sentence case everywhere. No uppercase labels, no wide letter-spacing.

## Shape and space

- Spacing steps of 4, 8, 12, 16 and 24 px. Related items 4 to 8 px apart; separate groups 12 to 16; views 16 to 24. In practice: cards are padded 16 px everywhere; on the pages a section title sits 8 px above its card and sections are 24 px apart; messages are 16 px apart (6 px within one sender's run). Balanced, neither cramped nor padded out: no gap is there only to fill space.
- **The popup** (and the side panel) is a stack of cards 12 px apart, one per part: the chat, **Messages to capture** (with **Options**, which changes how the capture reads), and **Save a file** (its **Format**, a hairline rule, then **Include in the file**). Inside a card, 12 px between its parts, 8 px between a group's heading and its choices, and 16 px around the rule. Its controls are 36 px tall with a mouse (tiles 64 px), 8 px apart. The capture button's bar runs from edge to edge above the status bar. The reference for this spacing was the stacked section cards of another Teams exporter's popup (owner's choice, November 2026); its uppercase headings and colours were not taken.
- Totals and run counts are a label over a number, set apart by space alone: no boxes or tinted tiles around them.
- Radius 6 px for controls, 8 px for cards and dialogs. Pill shapes only for **badges**, which mark a real state in a word or two (a chat's type, its history such as *Complete* or *Not checked*, the phase of a run), and for the count of messages seen in the status bar.
- Controls (buttons, selects, fields, segments, **Options** and **Advanced**) are at least 32 px tall with a mouse and 44 px on a touch screen. A link inside a sentence stays a link in the text.
- Links that open a chat, and **All conversations**, are targets like controls: 32 px tall with a mouse, 44 px on touch.
- Cards are flat with a 1 px border, and nothing inside a card gets a border of its own except controls: groups inside it (the format and the include list of the save form, for example) are set apart by space and a heading, or by a hairline rule in the border colour where one part of a card follows another (**Include in the file** after **Format**, **Options**, **Advanced**). Messages have no border either; your own carry the selected tint.
- A choice among a few options is drawn as **segments** or **tiles**, not a select, so every option can be seen at once: a radio group drawn as buttons with short names.
  - The popup's **Messages to capture** is three tiles in a row, each an icon over a short name: *New messages*, *Date range*, *Full history*. (Capturing only the messages on screen was taken out of the popup in 1.11.) *Date range* opens a **Period** under them, four segments two by two (*24 hours*, *7 days*, *30 days*, *From a date*), and *From a date* opens the date field. One line under the choices says what the chosen one does.
  - The formats are segments, each with its icon before its name: one row where there is room (the archive's **Save a file…** dialog), two by two in the popup and the side panel. One line under them says what the chosen format makes. The line changes with the choice; the names stay short.

  Segments and tiles take the control outline, the 6 px radius and the 32 / 44 px minimum (36 px in the popup, where a tile is 64 px tall). The chosen one has the selected tint, an accent ring two lines wide (its border and an inner line), and its name and icon in the accent colour. Longer lists, such as the settings and the Conversations list's type and sort, stay selects. What a file includes is a list of checkboxes in two columns; a box the format fixes is ticked and disabled, with a note under the list saying why.
- A coloured left edge appears only where it means something: a quoted reply, an earlier version of a message.

## Focal point of each screen

| Screen | The one thing that matters most |
| --- | --- |
| Popup, side panel | The button in the bar above the status bar, which stays in view and names what it captures and the file it saves (*Capture new messages and save a PDF*); when a run was interrupted, **Resume extraction** in its place. Above it, the choices that lead to it: the messages to capture, then **Save a file** with the format and what to include. During a run, the progress and **Stop** take the capture controls' place. The status bar under it says in one line whether the popup reaches Teams and what the tab shows, or during a run its phase, its time and the messages seen. |
| Archive page | The chat list, and the search above it. **Backup and import** and **Settings** follow under it (the header links to all three), and a line with the version ends the page. The actions on a chat are on its own page. |
| A conversation | The messages; it opens at the newest one. |
| Save page | What it is saving and how far it has got, then the result naming the file; for a PDF, the print dialog. |
| Settings | **Save settings**, for General and Advanced; Advanced stays closed until it is opened. |

## Icons

An icon stands beside words that name the same thing, so the eye finds a choice or an action before reading it; alone, only where a label would not fit (the header buttons and the search field), and then the control has an accessible name and a tooltip. Every icon is a line drawing 1.5 px wide at any size, in the colour of the text beside it, and hidden from screen readers. They are built in `src/ui/icons.ts` from two sets: the extension's own, on a 16 px grid, and icons from [Lucide](https://lucide.dev) (ISC licence, in `src/ui/licenses/`), on a 24 px grid, which the prototype used. No icon is added for decoration.

| Where | Icon | What it stands for |
| --- | --- | --- |
| Header | screen, sun or moon; window with an arrow; window with a column | The theme in use; open the archive; open the side panel. |
| Messages to capture | circling arrows, calendar, clock turning back | Messages new since the last run; a date range; the history back to the start. |
| Formats | printer, page of lines, page with braces, page with a zip | PDF (printed by the browser); Text; JSON; ZIP package. |
| What a file includes | picture, paperclip, reply arrow, smile, *i* in a circle, pencil | Pictures, file attachments, reply context, reactions, system messages, edit history. |
| Capture and run | arrow into a tray; pause, play, square | The capture brings messages in; pause, resume and stop, as on any player. |
| Run result | check, *i* or *!* in a circle | Finished; finished with something to know; failed. |
| A chat's actions | page with an arrow down, pictures, pencil, joining arrows, bin | Save a file, saved images, rename, merge, delete. |
| Archive | arrow into a tray, arrow out of a tray; arrow up; back arrow; chevron | Back up, import; show earlier messages; all conversations; open **Options** or **Advanced** (it turns when open). |

## Writing

- Plain sentences that say what happens: "Back to the beginning of the chat; parts already archived are passed quickly", not "Instantly capture your conversations". Technical detail goes in the line under a choice, or in the docs, not in its name: the format is *ZIP package*, and the line under it says what the package holds.
- Buttons say what they do: "Capture new messages and save a PDF", "Back up now". A button that opens a dialog ends with an ellipsis ("Rename…").
- Everything the user needs is on the page. A tooltip may repeat it, never hold it alone: there is no hover on a touch screen.
- Name the next action in empty, error and warning states: "Nothing archived yet. Open a chat in Teams Web and click the toolbar button."
- Real numbers only, with their unit ("451 messages", "0.8 MB"). Never invented examples in the interface; fixtures and screenshots use made-up names such as Alice Andersen, Bob Brown, *Project Alpha* and *Design review*.
- British spelling, as in the existing text ("recognised", "colour").
- No emoji, no exclamation marks, no marketing words ("powerful", "seamless", "effortless").

## Accessibility and layout

- Every page works with the keyboard alone: skip link, visible focus ring, focus moved to the heading of the part opened, Escape closes dialogs. Segments are radio groups: the arrow keys move between their options, and the focus ring goes around the whole segment.
- Status messages, run progress and results are live regions.
- Colour is never the only signal: states also have text. A pressed button gets a heavier bottom edge, a pressed segment or tile the selected tint, and the chosen one a ring two lines wide; a disabled control is faded and shows the *not allowed* cursor. The status bar's dot only repeats its words.
- Every enabled control shows the hand cursor, checkboxes and their labels included. Every field has a visible label.
- Every view has a loading line ("Reading the archive…", "Checking this tab…"), an empty state that names the next action, and an error in the status line. A button whose action is running ignores another click.
- Below 760 px (narrow windows) each table row becomes a short card: its first cell sums the row up in a line or two, and the cells that line repeats are hidden. Nothing scrolls sideways at any width. The popup is 380 px wide; the side panel works from 300 px.
- Dialogs are drawn by the page (`<dialog>`), never the browser's `prompt()` or `confirm()`.
