# Privacy policy

**Teams Chat Scraper**, a browser extension for Microsoft Edge. Last updated 24 November 2026, for version 1.10.0.

Teams Chat Scraper keeps the chats you archive in your own browser profile. It has no server, no account and no analytics. It sends nothing to its developer or to anyone else.

Teams Chat Scraper is an independent extension. It is not made by, endorsed by or affiliated with Microsoft.

## What it reads

Teams Chat Scraper works only in Teams Web tabs: `teams.microsoft.com`, `teams.cloud.microsoft` and `teams.live.com`.

- **When you open the popup or side panel on a Teams tab**, it reads which chat is open (its title and Teams id) and how many messages are on screen, to show them to you.
- **When you start a capture**, it reads the messages Teams shows in that chat, and scrolls the chat upwards so Teams loads older ones. For each message it keeps:
  - the text and formatting;
  - the sender's name, and their Teams user id when the page shows it;
  - the time;
  - the message it replies to;
  - mentions and links;
  - the names and links of attachments;
  - reactions: each emoji, how many people chose it, and whether you did (not who the others are);
  - whether it was edited or deleted, with earlier versions it saw.
- **Pictures** shown in messages are saved too, unless you turn off *Keep the pictures shown in messages*. Profile pictures are not saved.

It reads only what Teams already shows your account. It never reads your password, sign-in tokens, cookies, Teams' own browser storage or network traffic. It never calls Teams or Microsoft APIs, and it never changes anything in Teams.

## Where it keeps it

- **Archived chats and pictures** are kept in the extension's IndexedDB database, in your browser profile on your computer.
- **Settings, your choices for saved files, the name of the last file saved after a capture and the time of your last full backup** are kept in the extension's local storage (`chrome.storage.local`), in the same profile.

Nothing is synced to other devices. Removing the extension deletes all of it, so back it up first (**Back up now** on the archive page) if you want to keep it.

## What leaves your computer

- **Network requests.** Teams Chat Scraper makes none of its own, apart from one case. To save a picture, it reads the copy the Teams page already has, or the browser cache. Only if neither is available does it request the same picture address again, as the page did, from the service Teams loaded it from. Turn off *Keep the pictures shown in messages* to avoid these requests.
- **Saved files.** These are files you choose to save (PDF, text, JSON or a ZIP package), into the browser's downloads or through its print dialog. They contain your messages and, if you include them, your pictures. Where they go after that is up to you.

## What is not done with your data

- No data is sold or given to anyone.
- No advertising, analytics, tracking or crash reports.
- No use for any purpose other than archiving your chats and saving them as files for you.

## Changes

Changes to this policy are published in this file, with the date at the top. Questions can be asked in the issue tracker of the GitHub repository that publishes this policy.
