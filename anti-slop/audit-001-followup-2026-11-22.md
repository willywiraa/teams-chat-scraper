# antislop audit 001, follow-up, 22 November 2026

The fixes for findings 1 to 14 of [audit-001-2026-11-22.md](audit-001-2026-11-22.md), which you approved. Finding 15 (the name) waited on decision 1 and was fixed later, in 1.7.0. Version 1.6.1.

## How it was checked

- `npm run check`: the typecheck and the build pass, and all 336 tests pass.
  - The full suite was run with three workers. In the default fully parallel run, two timing tests failed: the large-list parser at 47 s against its 15 s limit, and the icon rendering test at its 60 s timeout. Neither covers code this change touched, and both pass on their own.
  - New tests cover:
    - the repeated-click guard;
    - picture sizes;
    - the backup line and its stored record;
    - the full-backup rule;
    - singular counts;
    - the control outline contrast and the placeholder colour.
- The rebuilt pages were opened in a browser against the same seeded archive as the audit (a 451-message *Design review* and a 1:1 chat with *Alice Andersen*) and against an empty one. They were checked:
  - in light and dark, at desktop width with a mouse;
  - at 375 and 380 px emulating a touch screen.

  Sizes and colours were read from the rendered page.

## Findings

| # | Rule | Status | What changed, and the evidence |
| --- | --- | --- | --- |
| 1 | R-27 | Fixed | **Change:**<ul><li>`guarded()` ignores a click while its action is still running, which covers every button that uses it.</li><li>**Show earlier messages** says *Loading earlier messages…* and shows the busy cursor while it loads.</li></ul>**Evidence:** three quick clicks now give 400 messages, 400 of them distinct. Before the fix it was 600, with 400 distinct. |
| 2 | R-27 | Fixed | **Change:**<ul><li>The archive page opens with *Reading the archive…*, and shows it again when a section takes more than 200 ms to draw.</li><li>The view being drawn is marked `aria-busy`.</li><li>The popup shows *Checking this tab…* until the tab answers.</li><li>If checking the tab fails, the popup now says so instead of staying blank.</li></ul> |
| 3 | R-27 | Fixed | **Change:** every empty state names the next action. **Evidence**, checked on an empty archive:<ul><li>Recent runs, and a chat with no messages, say what to do next.</li><li>A search that matches nothing offers **Show all conversations**, which clears the search and the type filter and puts the focus back in the search field.</li><li>Export says *Nothing archived yet, so there is nothing to export*.</li><li>A disabled Export says why: *Select at least one conversation* or *Nothing to export yet*.</li></ul> |
| 4 | R-25 (non-text) | Fixed | **Change:** a new `--control-border` outlines buttons, selects, fields and the search box; `--border` stays for cards and table rules. **Evidence**, measured:<ul><li>light `#86868f`: 3.61:1 on card, 3.31:1 on page;</li><li>dark `#7a7a86`: 3.55:1 on card, 4.05:1 on page.</li></ul>`tests/unit/logo.test.ts` keeps both at 3:1 or more. |
| 5 | R-25 | Fixed | **Change:** placeholders use the muted text colour. **Evidence**, measured:<ul><li>search field: 5.93:1 light, 6.02:1 dark;</li><li>Advanced text area on the page background: 5.45:1 light, 6.87:1 dark.</li></ul> |
| 6 | R-03 | Fixed, as proposed | **Change:** at least 32 px with a mouse and 44 px on a touch screen (`pointer: coarse`). **Evidence**, measured:<ul><li>With a mouse: every button, select, search field, navigation entry, summary and link button is 32 px tall.</li><li>With touch emulated: all of them are 44 px. The popup's icon buttons are 44 × 44 and checkbox rows 44 px.</li><li>The picture count link is 32 px wide (44 on touch), and its number still lines up with the column.</li><li>At 375 px nothing scrolls sideways on any of the five views.</li></ul>R-03 itself asks for 44 px everywhere; the mouse size can be raised if you want that. |
| 7 | R-39 | Fixed | **Change and evidence:**<ul><li>Checkboxes, their labels and every `label[for]` show the hand cursor.</li><li>Disabled controls, and labels of disabled checkboxes, show *not allowed*.</li><li>Text fields keep the text cursor.</li><li>Pressed buttons get a 2 px bottom edge and the selected background; pressed link buttons get a thicker underline.</li><li>The current navigation entry has a 2 px underline, and navigation entries underline on hover.</li></ul>Cursors and the underline were read from the page. The pressed style was checked in the CSS only, because a script cannot hold a mouse button down. |
| 8 | R-39 | Fixed | **Change:** visible labels **Search**, **Type** and **Sort by** above the conversation toolbar. The popup's date field is labelled **From**; its accessible name is now "From". |
| 9 | R-40 | Fixed | **Change:**<ul><li>Message pictures are created with a 240 × 160 box.</li><li>When their record is read, they get its recorded size, scaled to fit 420 × 320, before their address is set.</li><li>The image dialog's tiles carry the recorded width and height, on top of their fixed CSS box.</li></ul>**Evidence:** the seeded picture got `width="120" height="60"` before loading. |
| 10 | Liveliness, one accent | Fixed | **Change:** Settings has one primary button, **Save settings**. **Back up now…** and **Run diagnostics** are normal buttons. **Evidence:** measured one accent button per view: Overview, Export, Settings and the popup. |
| 11 | Liveliness, focal point | Fixed | **Change:**<ul><li>Under the totals, Overview says when the last full backup was made, with **Back up now…** as its primary button.</li><li>A downloaded export counts as a full backup when it is importable and covers every conversation, the whole period and all content. Its time and totals are kept in `chrome.storage.local` (`lastBackup.v1`), not in the archive database.</li></ul>**Evidence:** in the browser, Overview went from *No full backup has been made…* to *Last full backup just now (…): 2 conversations, 452 messages*. The file download was intercepted in the preview, so nothing was saved. |
| 12 | C-4 | Fixed | **Change:** a shared `countOf()` gives the singular for one. It is used in:<ul><li>the Export list;</li><li>the merge dialog, its progress and its result;</li><li>the delete question and its result (which now says *runs*, as the rest of the page does);</li><li>the image dialog title, and the image count's accessible name;</li><li>the conversation count;</li><li>the import result, which said "conversation(s)".</li></ul>**Evidence:** the Export list now reads *Alice Andersen · 1 message*. |
| 13 | R-11 | Fixed | The image and merge dialogs use the 8 px radius. |
| 14 | C-1 | Fixed | The unused `label.button` rules are removed. |
| 15 | R-20 | Fixed in 1.7.0 | **Change:** decision 1 chose "Chat Archiver for Microsoft Teams". The popup and the archive page are both titled *Chat Archiver*; tab titles read *Overview · Chat Archiver*. The full name, with a note that it is not affiliated with Microsoft, is in the manifest, the toolbar tooltip and Settings → About. |

## Rules re-checked after the fixes

| Rule | Result |
| --- | --- |
| R-02 | No em dash in the new text. |
| R-25 | Text pairs, control outlines and placeholders all pass in both themes; enforced by tests. |
| R-27 | Every view has a loading line, empty states naming the next action, and errors in the status line. |
| R-32 | Focus moves to the search field after **Show all conversations**. **Show earlier messages** keeps the focus while it loads: it is marked `aria-disabled`, not disabled. |
| R-34 | Both themes measured. |
| R-39 | Cursors, visible labels and states as above. |
| R-40 | Every picture has dimensions before it loads. |
| Liveliness | One accent per view. Overview's focal point is the backup state. |
| DESIGN.md | Updated to match: control border, 32 and 44 px controls, the Overview focal point, and the state rules. |
