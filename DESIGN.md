# Design direction

The look and voice of the extension's pages: the popup, the side panel and the archive page. This file states the direction; `src/ui/ui.css` holds the values, and the antislop skills in `.claude/skills/` are the filter applied on top (see `AGENTS.md`). When the two disagree, change one of them on purpose, not by accident.

It records the decisions already made (Phase 4 and 5 of [docs/IMPROVEMENT_PLAN.md](docs/IMPROVEMENT_PLAN.md), and antislop audits [001](anti-slop/audit-001-2026-11-22.md) and [002](anti-slop/audit-002-2026-11-22.md)). Change it when the direction changes.

## Design read

Reading this as: a personal archiving tool inside Edge, for someone keeping their own Teams chats, in a quiet Windows-native utility style, dial **ENERGY 1 / RHYTHM 1 / MOTION 1**.

Dial: ENERGY 1 / RHYTHM 1 / MOTION 1

- **ENERGY 1.** The pages are opened to do one job (archive a chat, find a message, export, fix a setting) and closed again. They should feel like part of the browser, calm and dependable, not like a product trying to impress.
- **RHYTHM 1.** Lists and tables are uniform on purpose: every conversation, run and setting is the same kind of thing, and a regular grid makes them quick to scan and compare. Variety comes from the content (a chat's messages, its pictures), not from the layout.
- **MOTION 1.** Hover and focus states only. Nothing animates on its own; progress is shown as numbers and text that update.

## Identity

- **Who it is for.** One person archiving the chats their own account can see, on their own computer. No team, no sign-up, no cloud.
- **Personality.** Plain, careful, honest. It says exactly what it did and what it did not do, and never claims more than it knows (a history that does not reach the chat's beginning says "not back to the start").
- **Not affiliated with Microsoft.** Nothing may use the Teams logo, Teams purple (`#5b5fc7` and its relatives) or anything that reads as an official Microsoft product.
- **Identity motif.** The logo: an archive box shaped like a speech bubble, white on a blue tile. It appears once, in the page header, at 20 or 24 px. No other illustration or decoration.

## Palette

One accent, neutral greys, and the few status colours the content needs. Every value is in `src/ui/ui.css` (light, and dark twice: for *System* and for *Dark*); `tests/unit/logo.test.ts` keeps every text pair at 4.5:1 or more and the control outline at 3:1 or more.

| Role | Light | Dark | Used for |
| --- | --- | --- | --- |
| Accent | `#1f5fbf` | `#7aaaf5` | The one primary button of a view, links, the current navigation entry, the focus ring. Nowhere else. |
| Background, card | `#f5f5f7`, `#ffffff` | `#1b1b1f`, `#26262c` | Page and surface. |
| Text, muted | `#1f1f24`, `#63636e` | `#ececf1`, `#a3a3ad` | Content; secondary details (dates, keys, hints). |
| Border, hover, selected | `#dcdce3`, `#eef0f4`, `#e3ecfa` | `#3a3a44`, `#30303a`, `#24344d` | Structure (card edges, table rules) and state. |
| Control border | `#86868f` | `#7a7a86` | The outline of buttons, selects and fields: 3:1 or more against card and page, so a control can be found. |
| Danger | `#c4314b` | `#f1707f` | Delete and Stop, errors. |
| Warning | `#8a5300` | `#f3b65c` | Warnings that need an action. |
| Notice, success, error backgrounds | `#eaf1fb`, `#e7f5ea`, `#fbe9ec` | `#1f2a3b`, `#1e3324`, `#3d2228` | Status messages and run results. |

The theme follows Windows (*Same as Windows*) unless the user chooses Light or Dark: with the **Theme** select in the archive page's header, or the theme button in the popup and side panel, which steps through the three. It applies at once, to every page of the extension. Neither theme is the "real" one.

No gradients, glow, glass, background textures or decorative shadows. A shadow is allowed only on something that floats above the page (a dialog).

## Typography

- **Segoe UI** (then the system font), because the extension lives in Edge on Windows and should read like the browser around it.
- Sizes: 12, 13, 14 (body), 16 and 20 px (section titles). Weight 600 for headings, names and numbers that matter; 400 for everything else.
- **Consolas** only for machine values the user may need to copy exactly: conversation keys and the diagnostics report. Never as a style for headings or labels.
- Sentence case everywhere. No uppercase labels, no wide letter-spacing.

## Shape and space

- Spacing steps of 4, 8, 12, 16 and 24 px. Related items 4 to 8 px apart; separate groups 12 to 16; views 16 to 24.
- Radius 6 px for controls, 8 px for cards and dialogs. No pill shapes except the small run-phase badge, which marks a real state.
- Controls (buttons, selects, fields, navigation entries, **More** and **Advanced**) are at least 32 px tall with a mouse and 44 px on a touch screen. A link inside a sentence stays a link in the text.
- Links that open a chat, and **All conversations**, are targets like controls: 32 px tall with a mouse, 44 px on touch.
- Cards are flat with a 1 px border, and nothing inside a card gets a border of its own: groups inside it (the parts of Export, for example) are set apart by space and a heading. Messages have no border either; your own carry the selected tint.
- A coloured left edge appears only where it means something: a quoted reply, an earlier version of a message.

## Focal point of each screen

| Screen | The one thing that matters most |
| --- | --- |
| Popup, side panel | The capture button, which names what it captures, or **Resume extraction** when a run was interrupted. During a run, the progress and **Stop** take the capture controls' place. |
| Overview | Whether the archive is safe: when the last full backup was made and **Back up now…**, then the totals. |
| Conversations | The list itself, and the search above it. The actions on a chat are on its own page. |
| A conversation | The messages; it opens at the newest one. |
| Export | **Export**, after the choices that lead to it: a preset, the format and what it makes, then the conversations, messages and content. |
| Settings | The section that was opened; **Save settings** for General and Advanced. |

## Icons

Few, and only where a label would not fit: the header buttons of the popup (the theme, which shows the one in use as a screen, a sun or a moon; open the archive; open the side panel) and the search field. They are drawn for this extension (`src/ui/icons.ts`) with a 1.5 px stroke, always with an accessible name and a tooltip. No icon is added for decoration.

## Writing

- Plain sentences that say what happens: "Archives the messages on screen without scrolling", not "Instantly capture your conversations". File formats and other technical detail go under a disclosure (**What is inside**), not in the first sentence.
- Buttons say what they do: "Capture new messages", "Export 2 conversations (ZIP)". A button that opens a dialog ends with an ellipsis ("Rename…").
- Everything the user needs is on the page. A tooltip may repeat it, never hold it alone: there is no hover on a touch screen.
- Name the next action in empty, error and warning states: "Nothing archived yet. Open a chat in Teams Web and click the toolbar button."
- Real numbers only, with their unit ("451 messages", "0.8 MB"). Never invented examples in the interface; fixtures and screenshots use made-up names such as Alice Andersen, Bob Brown, *Project Alpha* and *Design review*.
- British spelling, as in the existing text ("recognised", "colour").
- No emoji, no exclamation marks, no marketing words ("powerful", "seamless", "effortless").

## Accessibility and layout

- Every page works with the keyboard alone: skip link, visible focus ring, focus moved to the heading of the section opened, Escape closes dialogs.
- Status messages, run progress and results are live regions.
- Colour is never the only signal: states also have text. The current navigation entry is underlined; a pressed button gets a heavier bottom edge; a disabled control is faded and shows the *not allowed* cursor.
- Every enabled control shows the hand cursor, checkboxes and their labels included. Every field has a visible label.
- Every view has a loading line ("Reading the archive…", "Checking this tab…"), an empty state that names the next action, and an error in the status line. A button whose action is running ignores another click.
- Below 760 px (narrow windows) each table row becomes a short card: its first cell sums the row up in a line or two, and the cells that line repeats are hidden. Nothing scrolls sideways at any width. The popup is 380 px wide; the side panel works from 300 px.
- Dialogs are drawn by the page (`<dialog>`), never the browser's `prompt()` or `confirm()`.
