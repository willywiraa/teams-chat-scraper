# Store listing (Edge Add-ons)

What to enter in Microsoft Partner Center when submitting the extension, and how to build the file to upload. The texts below are ready to paste.

## Build the upload

1. Set the new version in `package.json` (the build copies it into the manifest).
2. Run `npm run check`, and the parts of [MANUAL_CHECKLIST.md](MANUAL_CHECKLIST.md) the release touches.
3. Run `npm run package`. It builds `dist/` without source maps and writes `release/teams-chat-scraper-<version>.zip`. It refuses a build whose manifest version differs from `package.json`, or one with source maps or files missing.
4. Upload that ZIP. `release/` is not committed.

## Listing

| Field | Value |
| --- | --- |
| Name | Teams Chat Scraper (from the manifest) |
| Short description | Saves the Microsoft Teams Web chats you can already see to this browser and exports them. Not affiliated with Microsoft. (from the manifest, 132 characters at most) |
| Category | Productivity |
| Privacy policy URL | The public address of [PRIVACY.md](PRIVACY.md), for example `https://github.com/willywiraa/teams-chat-scraper/blob/main/docs/PRIVACY.md`. That address works only while the repository is public; otherwise publish the policy somewhere public and use that address. |
| Logo (300 × 300) | `store/logo-300.png` |
| Small promotional tile (440 × 280) | `store/tile-440x280.png` |
| Screenshots (1280 × 800) | Still to make. Take them from the archive page with made-up chats (as in the tests: *Project Alpha*, *Alice Andersen*, *Bob Brown*), never from real chats: Overview, a conversation's messages, Export, and the popup over a Teams tab. |
| Search terms | Teams chat export · Teams chat backup · chat archive · chat history · export chat to HTML · Teams Web · CSV export |

### Description

> Teams Chat Scraper saves the Microsoft Teams chats you open in Teams Web to your own browser, so you keep a copy you can read, search and export.
>
> Open a chat in Teams Web, click the extension and choose what to capture: new messages since the last update, the last day, week or month, everything from a date, or the full history. Teams Chat Scraper reads the messages Teams shows you and scrolls the chat back like you would, so Teams loads older ones. It keeps text, senders, times, replies, mentions, links, attachment names and links, reactions, edits and the pictures shown in messages.
>
> On the archive page you can browse your chats and their messages, see which ones are complete, merge entries of the same chat, and export one chat or all of them as an HTML page, PDF, Markdown, plain text, CSV, JSON, or a ZIP package for knowledge systems. A JSON or package export is a full backup that Import restores.
>
> Your sign-in stays as it is: Teams Chat Scraper needs no Microsoft Graph API, no app registration and no admin consent. It reads only what Teams already shows your account. It never reads passwords, tokens or cookies, never calls Teams or Microsoft APIs, and never changes anything in Teams.
>
> Everything stays in your browser profile. There is no server, no account and no analytics. Removing the extension deletes the archive, so back it up first.
>
> Teams Chat Scraper works with Teams Web in Edge, not with the Teams desktop app. It reads Teams' page as displayed, so a Teams update can need a selector change before capture works again; Settings → Troubleshooting checks this.
>
> Teams Chat Scraper is an independent extension. It is not made by, endorsed by or affiliated with Microsoft. Microsoft Teams is a trademark of the Microsoft group of companies.

## Single purpose

Archive the Microsoft Teams Web chats the user opens into local browser storage, and export them.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| Host access to `teams.microsoft.com`, `teams.cloud.microsoft`, `teams.live.com` | The content script runs only on Teams Web. It reads the messages of the open chat as the page displays them and scrolls that chat so Teams loads older messages. No other site is accessed. |
| `storage` | Keeps the settings, the last export choices and the time of the last full backup in local extension storage. |
| `unlimitedStorage` | A long chat history with its pictures can be larger than the default storage quota. The archive is kept in the extension's IndexedDB database on this computer. |
| `scripting` | **Connect to this tab** adds the extension's own content script to a Teams tab that was already open when the extension was installed or updated, so the user does not have to reload Teams. Only the bundled `content.js` is injected, and only into Teams tabs. |
| `sidePanel` | Shows the capture controls in the side panel, which stays open during a long capture while the popup would close. |

No remote code is loaded or run. All scripts are part of the package.

## Data disclosures

| Question | Answer |
| --- | --- |
| Personal data handled | Personal communications (message text, pictures and attachment names and links), and names and Teams user ids of the people in the chats, as Teams shows them. |
| Where it goes | Only into the extension's storage in the user's browser profile, and into export files the user downloads. Nothing is sent to the developer or to third parties. |
| Sold or transferred | No. |
| Used for anything else | No: no advertising, analytics, profiling or creditworthiness. |
| Network requests | Only to save a picture that the open chat displays, when neither the page's copy nor the browser cache can be read: the same address the page loaded it from. The user can turn picture saving off. |

## Notes for certification

> Testing needs a Microsoft account with Teams (a free personal account works on teams.live.com). Open a chat with a few messages in Teams Web, click the extension, keep **Full history** and click **Start**. Then click the archive button at the top of the popup to see the chat on the archive page, and try **Export**.
>
> The extension reads only the rendered page of the chat the user opens. It does not use any Microsoft API, does not read tokens or cookies, and sends no data anywhere. It is not affiliated with Microsoft; "for Microsoft Teams" describes what it works with. The logo is its own (a white archive box shaped like a speech bubble, on a blue tile), not a Microsoft logo or colour.
