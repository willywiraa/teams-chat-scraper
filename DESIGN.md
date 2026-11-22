# Design direction

The look and voice of the extension's pages: the popup, the side panel and the archive page. This file states the direction; `src/ui/ui.css` holds the values, and the antislop skills in `.claude/skills/` are the filter applied on top (see `AGENTS.md`). When the two disagree, change one of them on purpose, not by accident.

It records the decisions already made (Phase 4 and 5 of [docs/IMPROVEMENT_PLAN.md](docs/IMPROVEMENT_PLAN.md)). Change it when the direction changes.

## Design read

Reading this as: a personal archiving tool inside Edge, for someone keeping their own Teams chats, in a quiet Windows-native utility style, dial **ENERGY 1 / RHYTHM 1 / MOTION 1**.

Dial: ENERGY 1 / RHYTHM 1 / MOTION 1

- **ENERGY 1.** The pages are opened to do one job (archive a chat, find a message, export, fix a setting) and closed again. They should feel like part of the browser, calm and dependable, not like a product trying to impress.
- **RHYTHM 1.** Lists and tables are uniform on purpose: every conversation, run and setting is the same kind of thing, and a regular grid makes them quick to scan and compare. Variety comes from the content (a chat's messages, its pictures), not from the layout.
- **MOTION 1.** Hover and focus states only. Nothing animates on its own; progress is shown as numbers and text that update.

## Identity

- **Who it is for.** One person archiving the chats their own account can see, on their own computer. No team, no sign-up, no cloud.
- **Personality.** Plain, careful, honest. It says exactly what it did and what it did not do, and never claims more than it knows (a partial history says "partial").
- **Not affiliated with Microsoft.** Nothing may use the Teams logo, Teams purple (`#5b5fc7` and its relatives) or anything that reads as an official Microsoft product.
- **Identity motif.** The logo: an archive box shaped like a speech bubble, white on a blue tile. It appears once, in the page header, at 20 or 24 px. No other illustration or decoration.

## Palette

One accent, neutral greys, and the few status colours the content needs. Every value is in `src/ui/ui.css` (light, and dark twice: for *System* and for *Dark*); `tests/unit/logo.test.ts` keeps every text pair at 4.5:1 or more.

| Role | Light | Dark | Used for |
| --- | --- | --- | --- |
| Accent | `#1f5fbf` | `#7aaaf5` | The one primary button of a view, links, the current navigation entry, the focus ring. Nowhere else. |
| Background, card | `#f5f5f7`, `#ffffff` | `#1b1b1f`, `#26262c` | Page and surface. |
| Text, muted | `#1f1f24`, `#63636e` | `#ececf1`, `#a3a3ad` | Content; secondary details (dates, keys, hints). |
| Border, hover, selected | `#dcdce3`, `#eef0f4`, `#e3ecfa` | `#3a3a44`, `#30303a`, `#24344d` | Structure and state. |
| Danger | `#c4314b` | `#f1707f` | Delete and Stop, errors. |
| Warning | `#8a5300` | `#f3b65c` | Warnings that need an action. |
| Notice, success, error backgrounds | `#eaf1fb`, `#e7f5ea`, `#fbe9ec` | `#1f2a3b`, `#1e3324`, `#3d2228` | Status messages and run results. |

The theme follows Windows unless the user chooses Light or Dark in Settings. Neither theme is the "real" one.

No gradients, glow, glass, background textures or decorative shadows. A shadow is allowed only on something that floats above the page (a dialog).

## Typography

- **Segoe UI** (then the system font), because the extension lives in Edge on Windows and should read like the browser around it.
- Sizes: 12, 13, 14 (body), 16 and 20 px (section titles). Weight 600 for headings, names and numbers that matter; 400 for everything else.
- **Consolas** only for machine values the user may need to copy exactly: conversation keys and the diagnostics report. Never as a style for headings or labels.
- Sentence case everywhere. No uppercase labels, no wide letter-spacing.

## Shape and space

- Spacing steps of 4, 8, 12, 16 and 24 px. Related items 4 to 8 px apart; separate groups 12 to 16; views 16 to 24.
- Radius 6 px for controls, 8 px for cards. No pill shapes except the small run-phase badge, which marks a real state.
- Cards are flat with a 1 px border. A coloured left edge appears only where it means something: a quoted reply, an earlier version of a message.

## Focal point of each screen

| Screen | The one thing that matters most |
| --- | --- |
| Popup, side panel | **Start**, or **Resume extraction** when a run was interrupted. During a run: the progress and **Stop**. |
| Overview | Whether the archive is safe: the totals and **Back up now**. |
| Conversations | The list itself, and the search above it. |
| A conversation | The messages. |
| Export | **Export**, after the choices that lead to it. |
| Settings | The section that was opened; **Save settings** for General and Advanced. |

## Icons

Few, and only where a label would not fit: the two header buttons of the popup (open the archive, open the side panel) and the search field. They are drawn for this extension (`src/ui/icons.ts`) with a 1.5 px stroke, always with an accessible name and a tooltip. No icon is added for decoration.

## Writing

- Plain sentences that say what happens: "Archives the messages on screen without scrolling", not "Instantly capture your conversations".
- Name the next action in empty, error and warning states: "Nothing archived yet. Open a chat in Teams Web and click the toolbar button."
- Real numbers only, with their unit ("451 messages", "0.8 MB"). Never invented examples in the interface; fixtures and screenshots use made-up names such as Alice Andersen, Bob Brown, *Project Alpha* and *Design review*.
- British spelling, as in the existing text ("recognised", "colour").
- No emoji, no exclamation marks, no marketing words ("powerful", "seamless", "effortless").

## Accessibility and layout

- Every page works with the keyboard alone: skip link, visible focus ring, focus moved to the heading of the section opened, Escape closes dialogs.
- Status messages, run progress and results are live regions.
- Colour is never the only signal: states also have text.
- Below 760 px (narrow windows, the side panel) tables become cards with labelled cells, and nothing scrolls sideways. The popup is 380 px wide.
