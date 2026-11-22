/**
 * Builds DOM that mirrors the structure of Teams Web ("new Teams") chat panes, matching the
 * default selector profile. Used by unit tests and by the virtualised chat simulator.
 */
export interface FixtureReply {
  id?: string | null;
  author?: string | null;
  preview?: string;
  time?: string | null;
}

export interface FixtureAttachment {
  name: string;
  url?: string;
  kind?: 'file' | 'image';
}

export interface FixtureMessage {
  /** Teams message id (rendered as data-mid / content-<id>). Omit or null for "no id". */
  id?: string | null;
  /** Author name shown in the header; omit for grouped continuation messages. */
  author?: string | null;
  self?: boolean;
  /** ISO timestamp for <time datetime>; null renders no time element. */
  time?: string | null;
  timeText?: string;
  timeTitle?: string;
  /** Render a <time> element without a datetime attribute (visible label only). */
  timeWithoutDatetime?: boolean;
  paragraphs?: string[];
  /** Raw body HTML (overrides paragraphs). */
  html?: string;
  reply?: FixtureReply;
  attachments?: FixtureAttachment[];
  edited?: boolean;
  /**
   * Raw HTML of the reactions under the message. Default: a reaction row in markup that the
   * reaction selectors do not match, so it is only checked to stay out of the text.
   */
  reactionsHtml?: string;
  /** Render as a system / control message with this text. */
  system?: string;
  /** Render as a date divider with this text. */
  divider?: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function replyHtml(reply: FixtureReply): string {
  const idAttr = reply.id ? ` itemid="${escapeHtml(reply.id)}"` : '';
  return (
    `<div data-tid="quoted-reply-card" itemscope itemtype="http://schema.skype.com/Reply"${idAttr}>` +
    (reply.author ? `<strong itemprop="mri" itemid="8:orgid:00000000-0000-0000-0000-000000000001">${escapeHtml(reply.author)}</strong>` : '') +
    (reply.time ? `<span itemprop="time">${escapeHtml(reply.time)}</span>` : '') +
    `<p itemprop="preview">${escapeHtml(reply.preview ?? '')}</p>` +
    `</div>`
  );
}

function attachmentsHtml(attachments: FixtureAttachment[]): string {
  const files = attachments.filter((att) => att.kind !== 'image');
  const images = attachments.filter((att) => att.kind === 'image');
  let html = '';
  if (files.length > 0) {
    html +=
      '<div data-tid="file-attachment-grid">' +
      files
        .map(
          (att) =>
            `<div data-tid="file-attachment" title="${escapeHtml(att.name)}">` +
            `<span data-tid="file-name">${escapeHtml(att.name)}</span>` +
            (att.url ? `<a href="${escapeHtml(att.url)}">Open</a>` : '') +
            `<button aria-label="More options">…</button></div>`,
        )
        .join('') +
      '</div>';
  }
  for (const image of images) {
    html += `<img itemtype="http://schema.skype.com/AMSImage" src="${escapeHtml(image.url ?? 'https://example.invalid/image.png')}" alt="${escapeHtml(image.name)}">`;
  }
  return html;
}

export function messageItemHtml(message: FixtureMessage): string {
  if (message.divider !== undefined) {
    return `<div data-tid="chat-pane-item"><div data-tid="message-pane-date-divider" role="separator"><span>${escapeHtml(message.divider)}</span></div></div>`;
  }
  if (message.system !== undefined) {
    const mid = message.id ? ` data-mid="${escapeHtml(message.id)}"` : '';
    const time = message.time ? `<time datetime="${message.time}">${escapeHtml(message.timeText ?? '')}</time>` : '';
    return `<div data-tid="chat-pane-item"><div data-tid="control-message-renderer"${mid}><span>${escapeHtml(message.system)}</span>${time}</div></div>`;
  }
  const id = message.id ?? null;
  const cls = message.self ? 'fui-ChatMyMessage' : 'fui-ChatMessage';
  const mid = id ? ` data-mid="${escapeHtml(id)}"` : '';
  const author = message.author ? `<div data-tid="message-author-name">${escapeHtml(message.author)}</div>` : '';
  let time = '';
  if (message.time !== null && (message.time !== undefined || message.timeText || message.timeTitle)) {
    const datetime = message.time && !message.timeWithoutDatetime ? ` datetime="${message.time}"` : '';
    const title = message.timeTitle ? ` title="${escapeHtml(message.timeTitle)}"` : '';
    const timeId = id ? ` id="timestamp-${escapeHtml(id)}"` : '';
    time = `<time${datetime}${title}${timeId}>${escapeHtml(message.timeText ?? '10:00')}</time>`;
  }
  const edited = message.edited ? '<span data-tid="message-edited-indicator">Edited</span>' : '';
  const paragraphs = message.html ?? (message.paragraphs ?? []).map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const bodyId = id ? ` id="content-${escapeHtml(id)}"` : '';
  const body =
    `<div${bodyId} data-tid="message-body">` +
    (message.reply ? replyHtml(message.reply) : '') +
    `<div>${paragraphs}</div>` +
    (message.attachments ? attachmentsHtml(message.attachments) : '') +
    `</div>`;
  return (
    `<div data-tid="chat-pane-item">` +
    `<div data-tid="chat-pane-message" class="${cls}"${mid}>` +
    `<div class="${cls}__body">${author}${time}${edited}${body}</div>` +
    (message.reactionsHtml ?? `<div data-tid="message-reactions"><button>👍 2</button></div>`) +
    `</div></div>`
  );
}

export interface ShellOptions {
  threadId?: string | null;
  title?: string;
  /** Put the thread id on the selected chat-list entry (default true). */
  threadIdInList?: boolean;
  itemsHtml?: string;
}

export function shellHtml(options: ShellOptions = {}): string {
  const threadId = options.threadId === undefined ? '19:00000000aaaa1111bbbb2222cccc3333@thread.v2' : options.threadId;
  const title = options.title ?? 'Project Alpha';
  const selectedId = threadId && options.threadIdInList !== false ? ` id="chat-list-item_${escapeHtml(threadId)}"` : '';
  return (
    `<div data-tid="app-shell">` +
    `<div role="tree" aria-label="Chats">` +
    `<div role="treeitem" data-tid="chat-list-item" aria-selected="true"${selectedId}><span>${escapeHtml(title)}</span></div>` +
    `<div role="treeitem" data-tid="chat-list-item" aria-selected="false" id="chat-list-item_19:ffffffff0000@thread.v2"><span>Another chat</span></div>` +
    `</div>` +
    `<div role="main">` +
    `<div data-tid="chat-header"><h2 data-tid="chat-header-title">${escapeHtml(title)}</h2></div>` +
    `<div data-tid="message-pane-list-viewport" style="overflow-y: auto; height: 600px">` +
    `<div data-tid="message-pane-list-runway">${options.itemsHtml ?? ''}</div>` +
    `</div></div></div>`
  );
}

/** Renders a static (non-virtualised) chat into document.body. */
export function renderStaticChat(messages: FixtureMessage[], options: ShellOptions = {}): void {
  document.body.innerHTML = shellHtml({ ...options, itemsHtml: messages.map(messageItemHtml).join('') });
}

/** Parses a single message item into a detached element (for message-parser unit tests). */
export function itemElement(message: FixtureMessage): Element {
  const template = document.createElement('template');
  template.innerHTML = messageItemHtml(message);
  return template.content.firstElementChild as Element;
}
