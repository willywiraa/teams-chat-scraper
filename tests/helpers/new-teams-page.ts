/**
 * A page shaped like new Teams (`/v2/`) for the identifier probe: no chat id in the URL, a chat
 * list, a header and a message list whose parts can be replaced per test. The identifiers below
 * are made up; tests check that none of them (or any name or text) reaches a report.
 */
export const OTHER_PERSON = '1a2b3c4d-0000-4e5f-8a9b-abcdefabcdef';
export const SELF_PERSON = '9f8e7d6c-1111-4b2a-9c3d-fedcbafedcba';
export const ONE_ON_ONE_THREAD = `19:${SELF_PERSON}_${OTHER_PERSON}@unq.gbl.spaces`;
export const GROUP_THREAD = '19:5555aaaa6666bbbb7777cccc8888dddd@thread.v2';
export const NEW_TEAMS_URL = 'https://teams.microsoft.com/v2/';

/** Names, text and identifiers used by the page; none may appear in a diagnostics report. */
export const PAGE_SECRETS = [OTHER_PERSON, SELF_PERSON, '5555aaaa', 'Alice', 'alice', 'contoso', 'Budget', 'Lunch', 'Original words', '1705314600000', '%3A'];

export interface NewTeamsPageOptions {
  /** The highlighted chat-list entry (default: selected, without any id). */
  entry?: string;
  /** Other chat-list entries (default: one group chat carrying its thread id). */
  others?: string;
  /** The chat header (default: a title only). */
  header?: string;
  /** Message items (default: one message with an avatar). */
  items?: string;
}

/** One message from the other person, with their avatar; `extra` goes into the body. */
export function newTeamsMessageHtml(extra = ''): string {
  const avatar = `https://teams.microsoft.com/api/mt/beta/users/${encodeURIComponent(`8:orgid:${OTHER_PERSON}`)}/profilepicturev2?displayname=Alice%20Andersen`;
  return (
    '<div data-tid="chat-pane-item"><div data-tid="chat-pane-message" class="fui-ChatMessage" data-mid="1705314600000">' +
    `<img data-tid="message-avatar" src="${avatar}" alt="Alice Andersen">` +
    '<div data-tid="message-author-name">Alice Andersen</div><time datetime="2024-01-15T10:30:00Z">10:30</time>' +
    `<div id="content-1705314600000" data-tid="message-body"><p>Lunch at noon?</p>${extra}</div>` +
    '</div></div>'
  );
}

export function renderNewTeamsPage(options: NewTeamsPageOptions = {}): void {
  document.body.innerHTML =
    '<div data-tid="app-shell">' +
    '<div role="tree" aria-label="Chat list">' +
    (options.entry ?? '<div role="treeitem" data-tid="chat-list-item" aria-selected="true"><span>Alice Andersen</span></div>') +
    (options.others ?? `<div role="treeitem" data-tid="chat-list-item" data-item-id="${GROUP_THREAD}"><span>Budget group</span></div>`) +
    '</div>' +
    '<div role="main">' +
    (options.header ?? '<div data-tid="title-bar"><h2>Alice Andersen</h2></div>') +
    '<div data-tid="message-pane-list-viewport"><div data-tid="message-pane-list-runway">' +
    (options.items ?? newTeamsMessageHtml()) +
    '</div></div></div></div>';
}

/** A header showing the 1:1 thread id and the other person's id, as the reference exporter expects. */
export const HEADER_WITH_IDS =
  '<div data-tid="title-bar">' +
  `<div id="chat-header-${ONE_ON_ONE_THREAD}"><h2>Alice Andersen</h2></div>` +
  `<span id="chat-topic-person-8:orgid:${OTHER_PERSON}" title="alice.andersen@contoso.example">Alice Andersen</span>` +
  '</div>';
