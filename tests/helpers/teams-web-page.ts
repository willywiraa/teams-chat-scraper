/**
 * Teams Web markup as two reports of the extension's former Diagnostics showed it in November
 * 2026, one from a 1:1 chat and one from a group chat, rebuilt from their outlines (tags, test
 * ids, roles, classes and attribute names). Names, ids and text are made up; where a report gave
 * only a text's length, the text here is a guess of that length (the reaction pill's
 * "1 Like reaction.").
 */
import { GROUP_THREAD, ONE_ON_ONE_THREAD, OTHER_PERSON } from './new-teams-page';

export { GROUP_THREAD, ONE_ON_ONE_THREAD };

export const OTHER_NAME = 'Alice Andersen';
export const SELF_NAME = 'Bob Brown';

/** The chat header: the chat id is in the id of its first block and in the Chat tab's value. */
export function teamsWebHeader(threadId: string, title: string, options: { headerId?: boolean } = {}): string {
  const id = options.headerId === false ? '' : ` id="chat-header-${threadId}"`;
  return (
    '<div data-tid="app-layout-area--header" class="fui-AppLayoutArea">' +
    '<div data-tid="slot-measurer" data-app-name="chat">' +
    `<div${id} telemetryset="">` +
    '<div class="fui-Flex"><div data-tid="entity-header" class="fui-Flex">' +
    `<div id="entity-header-title-area-avatar-container" class="fui-Flex"><div data-tid="chat-header-emblem" data-person-mri="8:orgid:${OTHER_PERSON}"></div></div>` +
    '<div id="entity-header-title-area-flex-container" class="fui-Flex"><div id="entity-header-title-area-flex" class="fui-Flex">' +
    `<div id="entity-header-title-area-prim" class="fui-Primitive"><h2 data-tid="chat-title" class="fui-Primitive"><div>${title}</div></h2></div>` +
    '</div></div>' +
    '<div data-tid="entity-header-toolbar" role="toolbar" class="fui-Toolbar" aria-label="Chat actions">' +
    '<button data-tid="chat-header-participant-count" class="fui-Button" aria-label="People"></button>' +
    '<div role="separator" class="fui-Divider" aria-orientation="vertical"></div>' +
    '</div>' +
    '</div></div>' +
    `<div><div data-pinbar-coachmark-anchor="${threadId}">` +
    '<div data-tid="chat-collaborative-tabs" role="tablist" class="fui-TabList">' +
    `<button data-tid="tab-item-com.microsoft.chattabs.chat" role="tab" aria-selected="true" class="fui-Tab" type="button" value="${threadId}"><span class="fui-Tab__content"><span aria-label="Chat">Chat</span></span></button>` +
    `<button data-tid="tab-item-com.microsoft.chattabs.files" role="tab" aria-selected="false" class="fui-Tab" type="button" value="${threadId}"><span class="fui-Tab__content"><span aria-label="Shared">Shared</span></span></button>` +
    '</div></div></div>' +
    '</div></div></div>'
  );
}

export interface PillOptions {
  emoji: string;
  /** Teams' name for the emoji, used in the id of the pill's text. */
  itemId: string;
  messageId: string;
  text: string;
  pressed: boolean;
}

/** The reactions under a message: one pill per emoji, then Add reaction. */
export function reactionBar(side: 'ChatMessage' | 'ChatMyMessage', pills: PillOptions[]): string {
  const pill = (p: PillOptions) =>
    `<button data-tid="diverse-reaction-pill-button" id="menur${p.itemId}" class="fui-Button fui-ToggleButton" type="button" aria-labelledby="message-${p.itemId}-${p.messageId}" aria-haspopup="true" aria-pressed="${p.pressed}">` +
    '<div class="fui-Primitive"><span data-tid="emoticon-renderer">' +
    `<img itemtype="http://schema.skype.com/Emoji" class="fui-Image" alt="${p.emoji}" draggable="false" itemid="${p.itemId}" width="20" src="https://statics.example/emoticons/${p.itemId}.png">` +
    `</span><div id="message-${p.itemId}-${p.messageId}" class="fui-Primitive" dir="auto" aria-hidden="true">${p.text}</div></div></button>`;
  return (
    `<div class="fui-${side}__reactions"><div>` +
    '<div data-tid="diverse-reaction-summary" role="toolbar" class="fui-Toolbar" aria-label="Reactions">' +
    pills.map(pill).join('') +
    '<div data-tid="reactions-summary-item-renderer" class="fui-Primitive"><button data-tid="add-reaction-picker-entry-point-button" role="button" class="fui-Button" type="button" aria-label="Add reaction"><span class="fui-Button__icon"><svg data-tid="add-reaction-picker-entry-point-icon"></svg></span></button></div>' +
    '</div></div></div>'
  );
}

/** A quoted message inside a reply's body. */
export function quotedReply(sender: string, time: string, preview: string): string {
  return (
    '<div role="group" class="fui-Flex" data-message-object="" aria-label="Quoted message" tabindex="0"><div class="fui-Primitive"></div>' +
    '<div data-tid="quoted-reply-card" class="fui-Primitive"><div class="fui-Flex"><div class="fui-Flex">' +
    `<span class="fui-StyledText" dir="auto">${sender}</span>` +
    `<span data-tid="quoted-reply-timestamp" class="fui-StyledText" dir="auto">${time}</span>` +
    `</div><div class="fui-Primitive"><span data-tid="quoted-reply-preview-content" class="fui-StyledText" dir="auto">${preview}</span></div></div></div>` +
    '</div>'
  );
}

/** A picture someone sent, as it shows in the body; Teams gives its element an opaque hex id. */
export function sentPicture(name: string, threadId: string): string {
  const hex = Array.from(name, (char) => char.charCodeAt(0).toString(16)).join('');
  return (
    '<div class="fui-Primitive" data-message-object=""><span itemtype="http://schema.skype.com/AMSImage" data-testid="ams-image">' +
    `<img data-tid="lazy-image-2" itemtype="http://schema.skype.com/AMSImage" id="x_0-jhb-d4-${hex}" class="fui-Image" aria-label="image" data-orig-src="https://example.invalid/${name}" data-gallery-id="${threadId}" data-gallery-src="blob:https://teams.example/${name}" alt="image" title="image" src="blob:https://teams.example/${name}">` +
    '</span></div>'
  );
}

export function mention(name: string): string {
  return `<span itemtype="http://schema.skype.com/Mention" class="fui-StyledText" dir="auto" itemid="0" data-mention-type="person">${name}</span>`;
}

export interface TeamsWebMessage {
  id: string;
  /** ISO time for the datetime attribute. */
  time: string;
  author: string;
  /** Inner HTML of the body (inside data-ask-copilot-content). */
  body: string;
  self?: boolean;
  edited?: boolean;
  reactions?: PillOptions[];
}

/** One message item; another person's carries their avatar, itself marked as a chat-pane-item. */
export function teamsWebMessage(m: TeamsWebMessage): string {
  const side = m.self ? 'ChatMyMessage' : 'ChatMessage';
  const author = `<div class="fui-${side}__author"><div class="fui-Flex"><div class="fui-Flex"><span data-tid="message-author-name" id="author-${m.id}" class="fui-StyledText" dir="auto">${m.author}</span></div></div></div>`;
  const time = `<time id="timestamp-${m.id}" class="fui-${side}__timestamp" aria-label="Sent" datetime="${m.time}" title="Sent">10:30</time>`;
  const edited = m.edited ? `<div class="fui-${side}__details"><div class="fui-Flex"><span id="edited-${m.id}" class="fui-StyledText" dir="auto" title="Edited">Edited</span></div></div>` : '';
  const header = m.self ? `<div>${time}${edited}${author}</div>` : `<div>${author}${time}</div>`;
  const avatar = m.self
    ? ''
    : `<div class="fui-ChatMessage__avatar"><div data-tid="chat-pane-item" data-person-mri="8:orgid:${OTHER_PERSON}"><span data-tid="message-avatar" id="avatar-${m.id}" class="fui-Avatar" aria-hidden="true"><img role="presentation" class="fui-Avatar__image" alt="" aria-hidden="true" src="https://teams.example/profilepicturev2/${OTHER_PERSON}"></span></div></div>`;
  return (
    '<div data-tid="chat-pane-item" class="fui-unstable-ChatItem"><div class="fui-Primitive" data-testid="message-wrapper">' +
    `<div role="heading" class="fui-Primitive" dir="auto" aria-level="4">${m.author} sent a message</div>` +
    `<div id="menu${m.id}" class="fui-Primitive"><div class="fui-${side}">` +
    header +
    '<div>' +
    avatar +
    `<div data-tid="chat-pane-message" role="group" id="message-body-${m.id}" class="fui-${side}__body" aria-labelledby="author-${m.id}" data-mid="${m.id}" tabindex="0">` +
    '<button data-tid="message-actions-menu-hidden-button" class="fui-Primitive" aria-label="More options"></button>' +
    `<div id="content-${m.id}" class="fui-Primitive" dir="auto" aria-label="Message" data-message-content=""><div data-ask-copilot-content="">${m.body}</div></div>` +
    (m.reactions ? reactionBar(side, m.reactions) : '') +
    '</div></div></div></div></div></div>'
  );
}

/** A day divider, which Teams also wraps in a chat-pane-item. */
export function teamsWebDivider(text: string): string {
  return `<div data-tid="chat-pane-item" class="fui-unstable-ChatItem"><div role="heading" class="fui-Divider" aria-labelledby="divider-1" aria-level="2"><div id="divider-1" class="fui-Divider__wrapper">${text}</div></div></div>`;
}

export function renderTeamsWebPage(header: string, items: string[]): void {
  document.body.innerHTML =
    '<div data-tid="app-shell">' +
    header +
    '<div role="main"><div data-tid="message-pane-body"><div data-tid="message-pane-list-viewport">' +
    `<div data-tid="message-pane-list-runway" id="chat-pane-list" role="log">${items.join('')}</div>` +
    '</div></div></div></div>';
}
