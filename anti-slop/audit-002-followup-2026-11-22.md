# antislop audit 002, follow-up, 22 November 2026

The fixes for all 21 findings of [audit-002-2026-11-22.md](audit-002-2026-11-22.md), which you approved ("All 21"), and the theme switch you asked for during the audit. Version 1.7.1.

The scraping engine, the extraction selectors, the database and the export and import formats are unchanged. No function was removed: what moved is listed under [Where things went](#where-things-went).

## How it was checked

- `npm run check`: the typecheck and the build pass.
  - All 351 tests pass when the suite runs with three workers (`npx vitest run --maxWorkers=3`).
  - In the default fully parallel run, one timing test failed: the large-list parser took 31.6 s against its 15 s limit. It covers the page parser, which this change does not touch, and it passes with three workers, as in audit 001.
  - New tests cover:
    - the wording of a chat's history (*Not back to the start*, *Not checked*) and the archived period, also for a single day;
    - which messages count as one run from a sender (five minutes, same day, no system message between);
    - the theme button's steps (Same as Windows, Light, Dark) and their names;
    - the Export button's label for each format and number of chats;
    - the plain explanation of the knowledge package, with the file names kept apart for **What is inside**.
- The rebuilt pages were opened in a browser against a seeded archive:
  - a 451-message *Design review*, with the newest messages a few minutes apart, two of them from *Bob Brown*;
  - a one-message 1:1 chat with *Alice Andersen*;
  - seven runs.

  The popup ran against a stand-in Teams tab. Every view was checked in light and dark, at 1280 and 900 px with a mouse, and at 375 px emulating a touch screen. The popup was checked at 380 px and the side panel at 320 and 300 px. Sizes, positions and colours were read from the rendered page.
- Not checked here: the extension loaded in Edge with a real Teams tab. The parts of [docs/MANUAL_CHECKLIST.md](../docs/MANUAL_CHECKLIST.md) for the popup and archive page, updated for these changes, are the place for that.

## Findings

| # | Rule | Status | What changed, and the evidence |
| --- | --- | --- | --- |
| 1 | R-03 | Fixed | **Change:** nothing in the popup may be wider than the panel: its sections can shrink, and selects never exceed their container. **Evidence:** the side panel measured `scrollWidth` 320 at 320 px for each of the seven capture choices, and 300 at 300 px, idle, during a run and after it. Before: 363 px at 320. |
| 2 | R-03 | Fixed | **Change:** links that act as targets (a chat's name, **All conversations**, **Open this chat in the archive**) are 32 px tall with a mouse and 44 px on touch. **Evidence:**<ul><li>At 1280 px: the chat links and the back link measured 32 px.</li><li>At 375 px with touch: no link, button, select or summary below 44 px on any of the five views. Before: 19, 16 and 37 px.</li><li>The result link measured 44 px on touch.</li></ul>**Troubleshooting** in the popup's Options stays the height of its sentence, as an inline link. |
| 3 | R-03, R-39 | Fixed | **Change:** nothing is held in a tooltip alone.<ul><li>The row and content tooltips are removed.</li><li>What they said is now on the page: *File attachments and reply context are always included in JSON and package exports…* under Content, and the number of messages on screen in the popup's chat card.</li><li>On narrow cards, the picture count reads *1 saved image*.</li></ul>The icon buttons keep a tooltip that repeats their accessible name. |
| 4 | R-03 | Fixed | **Change:** below 760 px each row of Conversations and Recent runs becomes a short card (`table.cards`). Its first cell sums the row up in a line or two, and the cells it repeats are hidden. **Evidence:**<ul><li>At 900 px Conversations shows six columns without breaking a word (`scrollWidth` 900).</li><li>At 375 px a chat card is 149 px (*Design review*, with its summary and *1 saved image*) or 105 px, where before it was 13 lines.</li><li>A run card is 103 px. Before: 257 px.</li></ul> |
| 5 | Liveliness, focal point | Fixed | **Change:** during a run, the progress and **Stop** take the place of the capture card. **Evidence:** in the 380 × 600 popup with touch sizes, **Stop** ends at 412 px. Before: 619 to 651 px, below the fold. |
| 6 | Liveliness, focal point | Fixed | **Change:**<ul><li>The idle popup is the chat card and one capture card: one select, one button, and **Options** (re-read and Troubleshooting).</li><li>*Only the messages on screen now* became the select's last choice instead of a separate button.</li><li>The run shows four counters; the picture counts moved into its detail line.</li></ul> |
| 7 | Liveliness, focal point | Fixed | **Change:** Overview opens with a **Backup** card: when the last full backup was made, at body size, with **Back up now…**. Then come the four totals and the note on where the archive is kept. Storage used is in Settings → Storage only. **Evidence:** the first card heading is *Backup* and the backup line is 14 px. |
| 8 | Liveliness, focal point | Fixed | **Change:** a conversation opens scrolled to its newest message, with **Back to the top** under the list. **Evidence:**<ul><li>On opening, the page was at 13,426 of 14,311 px, with the newest message's bottom at the window's bottom edge.</li><li>**Back to the top** went to 0 and put the focus on the chat's heading.</li></ul> |
| 9 | Liveliness, focal point | Fixed | **Change:** Export reads, top to bottom:<ol><li>a preset, each with its sentence on the page;</li><li>the format, with what it makes;</li><li>**What is inside**;</li><li>the conversations;</li><li>the messages;</li><li>the content;</li><li>the button.</li></ol>Packaging shows only when there is a choice to make: for HTML. **Evidence:** read in that order from the page; the packaging field was hidden for PDF, Markdown and CSV with pictures, JSON and the package. |
| 10 | R-06 | Fixed | `h3` is 16 px, on the type scale between body (14) and view titles (20). Measured on the Backup heading. |
| 11 | R-21, your request | Fixed | **Change:**<ul><li>The archive page's header has a **Theme** select (*Same as Windows*, *Light*, *Dark*) where the storage line was.</li><li>The popup and side panel have a theme button whose icon shows the theme in use (a screen, a sun, a moon); a click steps to the next one.</li><li>Settings → General no longer has its own copy.</li></ul>**Evidence:**<ul><li>Choosing *Light* in the header set `data-theme="light"` and the light page background at once.</li><li>The popup button went *Light* → *Dark* → *Same as Windows* → *Light*, with its accessible name (*Theme: Dark*) following, and the focus stayed on it.</li></ul> |
| 12 | R-05, C-1 | Fixed | **Change:**<ul><li>Messages have no border or background; your own keep the selected tint.</li><li>Messages from one sender less than five minutes apart form a run: the name is shown once and the run sits closer together. The name stays for screen readers.</li></ul>**Evidence:** 4 px between messages of a run against 12 px between runs, which puts 16 px between their texts against 28 px. 0 px message borders. |
| 13 | R-15 | Fixed | **Change:** buttons say what they do:<ul><li>the popup's button names the choice: *Capture new messages*, *Capture the last 7 days*, *Capture the full history*, *Capture the messages on screen*;</li><li>Export names what it writes: *Export 2 conversations (ZIP)*, *Export 1 conversation (JSON)*, and *Open the print dialog* for PDF.</li></ul>**Evidence:** read from the page for every format. |
| 14 | R-05, C-1 | Fixed | **Change:** the sections inside the Export card have no border of their own; space and a 13 px heading set them apart. |
| 15 | R-16 | Fixed | **Change:** the first sentence about each format is plain (*A ZIP for knowledge tools and backups, with a Markdown transcript of each conversation and its pictures…*). File names and formats (`manifest.json`, `messages.jsonl`, SHA-256) are under **What is inside**, shown only for JSON and the package. CSV says it *opens in Excel* instead of *UTF-8*. |
| 16 | R-20 | Fixed | **Change:**<ul><li>A history is *Complete*, *Not back to the start* or *Not checked*, with the same words in the list, the cards, the popup and Latest activity.</li><li>A single day reads as one date, not *21 Nov 2026 – 21 Nov 2026*.</li><li>The run log says *On screen*, as the popup does.</li></ul> |
| 17 | R-31, DESIGN.md | Fixed | 2 px spacing became 4 px; 6 px became 4 or 8 px; the 18 px list indents became 16 px; the 11 px report text became 12 px. |
| 18 | R-05 | Fixed | The popup shows four counters, in one row of four at 380 px; the cells have 8 px padding. |
| 19 | DESIGN.md, writing | Fixed | A finished run in the popup ends with **Open this chat in the archive**. |
| 20 | R-20 | Fixed | **Change:** Rename and Delete use the page's own dialogs, drawn like the merge dialog. **Evidence**, with real clicks and keys:<ul><li>**Rename…** opens with the name selected. Enter saves it, the status line says *Renamed to "Design review (Q4)"*, and the focus returns to **Rename…**. Escape closes it and changes nothing.</li><li>**Delete…** names the chat, its 451 messages and 1 image, and says it cannot be undone. It opens with the focus on **Cancel**, and Escape closes it.</li><li>**Delete** removed the chat and opened Conversations with *Deleted 451 messages, 1 image and 7 runs.*</li></ul> |
| 21 | C-3 | Fixed | **Change:**<ul><li>A chat's actions are on its own page only.</li><li>**Export…** and **Import archive…** left Conversations: Export is in the navigation, and Import is in Export and Settings → Storage.</li><li>Storage used is in Settings → Storage only.</li><li>Overview shows the latest 5 runs, with **Show all runs (7)** for the rest; it keeps the focus when clicked.</li></ul> |

## Found while checking, and fixed

| What | Fix |
| --- | --- |
| After a rename the page drew the buttons again, and the focus fell to the page itself. | The focus goes back to **Rename…**. |
| The Delete dialog opened with the focus on **Delete**, so Enter would delete at once. | **Cancel** has the focus when it opens. |
| A run of messages from one sender sat only 8 px closer than separate messages, too little to read as a group. | Continued messages have 4 px top padding: 16 px between their texts against 28 px. |
| **Open this chat in the archive** was 16 px tall on touch. | It follows the 32 / 44 px rule of finding 2. |
| A one-day period read *21 Nov 2026 – 21 Nov 2026*. | One date. |
| The run log said *Visible only* while the popup now says *the messages on screen*. | *On screen*. |

## Where things went

| Function | Before | Now |
| --- | --- | --- |
| Visible only | A button under **More** | *Only the messages on screen now*, a choice of the Capture select |
| Number of messages on screen | Under **More** | The popup's chat card |
| Export…, Rename, Merge…, Delete for one chat | Every row of the list, and the chat's page | The chat's page (**Rename…**, **Delete…**) |
| Images of a chat | A button in every row | The picture count in the list, and **Images (N)** on the chat's page |
| Import archive… | Conversations, Export, Settings → Storage | Export, Settings → Storage |
| Storage used | The header, Overview, Settings → Storage | Settings → Storage |
| Theme | Settings → General | The archive page's header, and the popup's theme button |
| Older runs | All of them in Overview | The latest 5, then **Show all runs** |

## Rules re-checked after the fixes

| Rule | Result |
| --- | --- |
| R-02 | No em dash in any added line (`git diff` searched: 0). |
| R-03 | No sideways scroll at 1280, 900 or 375 px on any archive view, nor in the popup at 380 px or the side panel at 300 px. Touch targets 44 px. |
| R-25 | No new colours; the new text uses the existing text and muted tokens, which `tests/unit/logo.test.ts` keeps at 4.5:1 in both themes. |
| R-32 | The dialogs take and return the focus; Escape closes them; **Back to the top**, **Show all runs** and the theme button keep or move the focus as described above. |
| R-34 | The header select and popup button switch both themes at once; the views were drawn in both. |
| R-39 | The theme select has a visible label; the theme button an accessible name that names the theme in use; both dialogs are labelled by their headings. |
| DESIGN.md | Updated: the theme controls, the focal points, link targets, no borders inside cards or around messages, narrow cards, page dialogs, and the writing rules for buttons, technical detail and tooltips. |

## Delivery Gate

**Block 1: Hard Gate**

| Item | Result |
| --- | --- |
| R-02 em dash | PASS: 0 em dashes in added lines. |
| R-03 mobile | PASS: `scrollWidth` equals the window width at 375 px on all five views and at 300 px in the side panel; no target under 44 px on touch. |
| R-17 statistics | PASS: every number shown comes from the archive (counts, dates, runs). |
| R-18 testimonials | PASS: none. |
| R-23 assets | PASS: the three theme icons were proposed in finding 11 and approved with it; no other asset was added. |
| R-24 navigation | PASS: the four navigation entries open their four views; the header select is a setting, not a link. |
| R-25 contrast | PASS: no new colour pairs; the contrast tests pass in both themes. |
| R-26 dead controls | PASS: every new control did what it says in the click-through below. |
| R-27 states | PASS: loading and empty states unchanged from audit 001; **Show all runs** shows only when there are more than five runs. |
| R-28 FAQ | PASS: none. |
| R-32 keyboard | PASS: Rename and Delete were driven with Tab, Enter and Escape; the focus ring is unchanged. |
| R-33 external patches | PASS: every change is in `src/` and `tests/`. |
| R-34 themes | PASS: Light, Dark and Same as Windows drawn on the popup and the archive views. |
| R-35 run and click-through | PASS: built, and clicked through as listed below. No errors in the console. |
| R-36 claims | PASS: none added. |
| R-37 direction | PASS: DESIGN.md, ENERGY 1 / RHYTHM 1 / MOTION 1. |
| R-38 fabricated content | PASS: the seeded names are the project's made-up test names, in the preview only. |
| R-39 semantics | PASS: native `<select>`, `<button>` and `<dialog>`; visible labels; accessible names. |
| R-40 media | PASS: no new media; pictures keep their reserved size. |

**Block 2: Purpose-Gate.** PASS: no gradient, glow, pattern, glass, shadow, badge or animation was added. The three theme icons show which theme is in use, where a label would not fit (R-04).

**Block 3: Liveliness.** PASS:
- The dials are declared in DESIGN.md, and the result matches them: still, plain and even.
- One focal point per screen:
  - the popup: the capture button, or **Stop** during a run;
  - Overview: the Backup card;
  - a conversation: the newest message;
  - Export: the button that names the file.
- One accent per view: the capture button, **Back up now…**, the Export button, **Save settings**, **Rename** in its dialog.
- Whitespace keeps to the 4 to 24 px steps and now carries the grouping that borders used to.
- The logo remains the one identity motif.

**Block 4: Craftsmanship.** PASS:
- C-1: each change cites its finding.
- C-2: no dead control.
- C-3: one entry point per function, as listed under *Where things went*.
- C-4: checked in both themes, at four widths, with touch and keyboard.
- C-5: no claims.

**Click-through** (preview build, seeded archive):
- **Popup:**
  - every capture choice, and the button label for each;
  - **Options**;
  - the capture button: the run started, the capture card was hidden and **Stop** was on screen;
  - **Stop**: the result showed with **Open this chat in the archive**;
  - the theme button, three times.
- **Archive header:** Theme → *Light* and *Dark*.
- **Overview:** **Show all runs (7)** and **Show the latest 5 runs**.
- **Conversations:** a chat's name, which opened its page; the picture count, which opened *Design review: 1 saved image* (Escape closed it).
- **Chat page:**
  - **Back to the top**;
  - **Rename…** (Escape, then Enter with a new name);
  - **Delete…** (Escape, then **Delete**).
- **Export:**
  - every format;
  - **Knowledge system** (*Knowledge system chosen…*, system messages unticked) and **Full backup** (ticked);
  - **What is inside**, which lists the package's files.
- **Settings:** General (no Theme field) and Storage (three figures, **Back up now…**, **Import archive…**).
