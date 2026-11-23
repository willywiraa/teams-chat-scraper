# antislop proposal 003, follow-up, 23 November 2026

This builds every proposal of [audit-003-2026-11-22.md](audit-003-2026-11-22.md), which you approved ("All 12"). The proposals are numbered 1 to 12 without a 5, so there are 11. Version 1.8.0.

The scraping engine, the selectors, the database and the export and import code are unchanged: nothing in `src/export`, `src/storage`, `src/scraper` or `src/extractor` was touched. The changes are in `src/ui`, their tests, DESIGN.md and the docs. No function was removed. What moved is listed under [Where things went](#where-things-went).

## How it was checked

- **`npm run check`:** the typecheck, all 360 tests and the build pass, in the default parallel run as well as with three workers.
- **New tests:**
  - the `#export/<key>` route;
  - the share of a run's progress bar (`reachShare`);
  - when a preset is in use (`presetInUse`);
  - the *Will save* file name (`plannedFileName`). It is compared with the name `runExport` gives the file, for every format and packaging, with and without pictures, for one conversation and for two: 26 exports in all;
  - the line after each conversation's name;
  - the tile lines;
  - the contrast of text and muted text on the selected tint;
  - the control outline on tiles and segments.
- **Preview.** The rebuilt pages were opened in a browser against the seeded archive: *Design review* with 451 messages, and a one-message chat with *Alice Andersen*. Sizes, positions and states were read from the rendered page. The sizes and themes checked:
  - the popup at 380 × 600 with a touch screen emulated;
  - the side panel at 300 × 640;
  - Export at 1024 × 768 and 1280 × 800 with a mouse, and at 375 × 760 with touch;
  - light and dark.
- **One export was run in the preview** with the page's download intercepted, so no file was saved.
- **Not checked:**
  - **The extension in Edge with a real Teams tab.** The parts of [docs/MANUAL_CHECKLIST.md](../docs/MANUAL_CHECKLIST.md) for the popup and Export, updated for these changes, cover that.
  - **Pause and Continue.** The stand-in Teams tab of the preview cannot pause. The code that shows those buttons is unchanged.
  - **PDF printing.**

## Proposals

| # | Status | What changed, and the evidence |
| --- | --- | --- |
| 1 | Done | **Change:** the select became four tiles, *New messages*, *A period*, *Full history* and *On screen*, each with its line. *A period* shows *24 hours · 7 days · 30 days · From a date…* under them, and the hint is one sentence. **Evidence:**<ul><li>In the 380 × 600 popup with touch sizes, the button is at 481 to 525 px with the period row open. It reads *Capture the last 7 days*.</li><li>In the side panel at 300 px, `scrollWidth` was 300 for every choice.</li><li>From *New messages*, the right arrow moved to *A period*, opened the period row and drew the focus ring around the tile.</li></ul> |
| 2 | Done | **Change:** an interrupted run shows its line and **Resume extraction** in the capture card, in the button's place, with **Start another capture instead**. **Evidence:**<ul><li>With a stopped run seeded, **Resume extraction** was the only primary button on screen.</li><li>**Start another capture instead** showed the tiles, put the focus on the chosen tile and made **Capture new messages** the primary button. It stayed that way through the popup's refresh every second.</li></ul> |
| 3 | Done | **Change:** a capture of a period shows a 4 px bar under the run's state, with *Back to 19 Nov 13:57, going back to 16 Nov 13:57*. The full history shows only *Reached back to …*. **Pause** and **Stop** share a row. **Evidence:**<ul><li>A 7-day run that had reached 4 days back showed 57%, with the value text *57%, back to …*. A 30-day run showed 13%.</li><li>The tests show no bar without a start date.</li><li>**Pause** and **Stop** are 161 px each at 380 px.</li></ul> |
| 4 | Done | **Change:** after a run, **Export this chat…** sits next to **Open this chat in the archive**. It opens `#export/<key>`, where Export selects that chat, also by an earlier key (an alias). A key that matches no chat keeps the previous selection. **Evidence:** both links are 44 px tall on touch, on one row; the link's address was `archive.html#export/title%3Adesign%20review`. |
| 5 | None | The proposal skips number 5, so it held 11 proposals, not the 12 its summary said. |
| 6 | Done | **Change:** seven format tiles, each with one line. **Evidence:**<ul><li>4 per row at 1024 px, and 2 per row at 375 px and in the left column at 1280 px.</li><li>The explanation and **What is inside** are unchanged.</li></ul> |
| 7 | Done | **Change:** packaging (HTML only) and the messages are rows of buttons, and *A period…* shows the *From* and *Before* fields. **Evidence:**<ul><li>Choosing HTML showed *One file, pictures embedded · ZIP with the pictures as files*.</li><li>After *ZIP…* was chosen, the focus stayed on it: the row is drawn again only when its options change.</li><li>*A period…* filled *From* with a week ago, as before.</li></ul> |
| 8 | Done | **Change:**<ul><li>**Filter by name** and the type chips (*All 2 · 1:1 chats 1 · Group chats 1*) narrow the list. The chips show only when the archive holds two kinds of chat or more.</li><li>**Select shown** appears while the filter hides something.</li><li>Each row reads *Design review · Group chat · 451 messages · updated 5 hours ago*.</li><li>The list no longer scrolls inside itself.</li></ul>**Evidence:**<ul><li>Filtering for *alice* showed one row and *2 of 2 selected (1 not shown)*. **Select shown** made it *1 of 2 selected*, and the button *Export 1 conversation*.</li><li>*zzz* showed *No conversation matches the filter. Clear it to see them all.*</li><li>*Group chats* showed only *Design review*.</li></ul> |
| 9 | Done | **Change:** the last row of the Export card is a bar that sticks to the window's bottom edge. It holds the file name, the progress, the result and the button. **Evidence:**<ul><li>At 1024 × 768 the bar was at 711 to 768 px while the card ran on below it.</li><li>*Will save teams-archive-2026-11-23T06-58-54.zip* matched the name of the file the export saved.</li><li>During the export the button read *Exporting…*, disabled, and the line went *Preparing the export…* → *Writing 451 messages, conversation 1 of 2* (bar 0%) → *Writing 452 messages, conversation 2 of 2* (50%). Then the result appeared: *Exported 452 messages and 1 picture from 2 conversations as …*.</li><li>At 375 px the button spans the bar, and the bar is 109 px with a result in it.</li></ul> |
| 10 | Done | **Change:** **Knowledge system** and **Full backup** are tiles. The one whose choices the form holds is checked and says *· In use*. **Evidence:** choosing *Knowledge system* set the package. Choosing *A period…* afterwards cleared both tiles, and so did choosing HTML. |
| 11 | Done | **Change:** the content checklist is in two columns from 761 px. Each item is the noun with its note in muted text: **File attachments** *names and links*. |
| 12 | Done | **Change:** from 1200 px the choices and the conversations stand side by side. **Evidence:** at 1280 px the choices span 29 to 620 px and the conversations 644 to 1236 px, with the bar across both. Below 1200 px it is one column. |

## Changed from the proposal

- **9, a wrong number.** The proposal said the Export button would be about 1,970 px down with 50 conversations. In fact the list stopped growing at 220 px and scrolled inside itself, so the button went no lower than about 900 px. It was still below a 768 px window from the 4th conversation, as the proposal said. The proposal now carries the correction. With the inner scroll gone (8), the bar is what keeps **Export** in reach.
- **9, the result's look.** In the first build, the result was a boxed message in the bar, which made the bar 162 px tall at 375 px. It is now a plain line in the bar, red for an error, and it takes the *Will save* line's place until a choice changes.
- **10, no status message.** Choosing a preset no longer writes *Knowledge system chosen: …* in the status line. The tile's *In use* says it.
- **12, the order in one column.** The conversations now come after the content; they used to sit between the format and the messages. This keeps the reading and tab order the same as the two columns. DESIGN.md's Export focal point says so.
- **6, two tile lines:**
  - Plain text reads *Text without formatting* instead of *Just the words*.
  - HTML reads *To read in a browser*: its pictures can be left out, so the line no longer says they are included.
- **1, the hint.** It says *Also checks the 2 days before again, for edits and late replies.* The exact time of the last update left the hint. The tile says *3 days ago*, and so does the chat card.
- **7, separate buttons.** The segments are buttons 4 px apart rather than joined, so a row that wraps stays tidy.
- **9, no bar for one chat.** The export bar shows only for two conversations or more: for one, the share is not known.

## Where things went

| Function | Before | Now |
| --- | --- | --- |
| The capture choices | One select of seven | Four tiles, and the four periods under *A period* |
| **Resume extraction** | A card above the capture card | The capture card, in the button's place |
| Format, packaging, messages | Selects | Tiles and rows of buttons |
| The presets | Two buttons | Two tiles that show *In use* |
| **Export**, its progress and its result | Under the content, inside the card | The bar at the card's bottom, always in view |
| The conversation list | Between the format and the messages | Last, or the right column from 1200 px |

## Rules re-checked after the changes

| Rule | Result |
| --- | --- |
| R-02 | No em dash in an added line (`git diff` searched: 0). |
| R-03 | No sideways scroll in any of these states: the popup at 380 px; the side panel at 300 px, for every capture choice, idle, running and after a run; Export at 375, 1024 and 1280 px. On touch every control, tile and segment is 44 px tall. The filter's text box sits inside its 44 px frame, as on Conversations. |
| R-04 | No icon added. The filter has the magnifier the search on Conversations has. |
| R-06 | Headings and labels are in sentence case. |
| R-25 | The new pairs are text and muted text on the selected tint: 13.79:1 and 4.98:1 in light, 10.66:1 and 5.02:1 in dark. They are now in `tests/unit/logo.test.ts`. Tiles and segments use `--control-border`, also tested. |
| R-32 | The arrow keys move between tiles and segments, and the focus ring goes around the tile. The focus stays on a segment after it is chosen. **Start another capture instead** moves the focus to the chosen tile. |
| R-34 | The popup and Export were drawn in light and in dark. |
| R-39 | **Native controls.** Native radios, in fieldsets with legends. **Progress bars.** `role="progressbar"`, with a value and a text value. **Filter.** A visible label. |
| MOTION 1 | Neither bar has a transition, and nothing moves on its own. |
| DESIGN.md | Updated:<ul><li>tiles and segmented rows as controls;</li><li>the known-share bar under MOTION 1;</li><li>the accent's two new uses;</li><li>the popup's and Export's focal points;</li><li>no icons on tiles;</li><li>keyboard use of radio groups.</li></ul> |

## Delivery Gate

**Block 1: Hard Gate**

| Item | Result |
| --- | --- |
| R-02 em dash | PASS: 0 in added lines. |
| R-03 mobile | PASS: `scrollWidth` equals the window width at 300, 375 and 380 px; touch targets are 44 px. |
| R-17 statistics | PASS: every number shown comes from the archive or the run: counts, dates, the share reached, the conversation being written. |
| R-18 testimonials | PASS: none. |
| R-23 assets | PASS: none added. |
| R-24 navigation | PASS: unchanged. The new link opens Export with the chat selected. |
| R-25 contrast | PASS: the new pairs are tested at 4.5:1 or more in both themes. |
| R-26 dead controls | PASS: every new control did what it says in the click-through below. |
| R-27 states | PASS. These states were seen:<ul><li>no match: the filter says so;</li><li>no selection: the hint shows;</li><li>running: *Exporting…*;</li><li>result and error: shown in the bar.</li></ul>The empty archive was not seen in the preview, which seeds itself. Its code hides the filter, the chips and the select row, and keeps *Nothing to export yet*. |
| R-28 FAQ | PASS: none. |
| R-32 keyboard | PASS: radio groups with arrow keys, and a visible focus ring. |
| R-33 external patches | PASS: changes in `src/ui`, `tests` and the docs only. |
| R-34 themes | PASS: light and dark. |
| R-35 run and click-through | PASS: built, and clicked through as below. No console errors. |
| R-36 claims | PASS: none added. |
| R-37 direction | PASS: DESIGN.md at ENERGY 1 / RHYTHM 1 / MOTION 1. You kept the defaults, so these reference patterns were left out: uppercase labels, icons on headings and options, a box around each section, and a bar that moves while the end is unknown. |
| R-38 fabricated content | PASS: the seeded names are the project's made-up test names, in the preview only. |
| R-39 semantics | PASS: native radios, checkboxes and buttons; fieldsets with legends; progressbar roles. |
| R-40 media | PASS: none added. |

**Block 2: Purpose-Gate.** PASS. Nothing was added that the Purpose-Gate forbids: no gradient, glow, pattern, glass, shadow, badge or animation. The two bars show a share that is known, in the one accent.

**Block 3: Liveliness.** PASS:
- **Focal points:**
  - in the popup, the capture button under the tiles; **Resume extraction** in its place; **Stop** during a run;
  - on Export, the button in the bar, which stays in view.
- **One accent per view.** The primary button, plus the chosen tile's or segment's edge and the bar, as DESIGN.md now says.
- **Spacing.** Whitespace keeps to the 4 to 24 px steps.
- **Identity.** The logo remains the one identity motif.

**Block 4: Craftsmanship.** PASS:
- C-1: each change cites its proposal.
- C-2: no dead control.
- C-3: one place per function, as listed under *Where things went*.
- C-4: checked in both themes, at five widths, with touch and keyboard.
- C-5: no claims.

**Click-through** (preview build, seeded archive):
- **Popup:**
  - each tile, and each period with its button label;
  - the arrow keys;
  - a 7-day and a 30-day run, with the bar and **Stop**;
  - the result's two links;
  - with an interrupted run: **Resume extraction**, then **Start another capture instead**.
- **Side panel at 300 px:** every choice, a run and its result.
- **Export:**
  - each preset;
  - HTML and its packaging, PDF, Markdown, and the package;
  - every period, and *A period…* with a wrong order of dates, which gave the error in the bar;
  - the filter, the type chips, **Select all**, **Select none** and **Select shown**;
  - one export of two conversations, with the download intercepted;
  - the bar at 1024, 1280 and 375 px.
