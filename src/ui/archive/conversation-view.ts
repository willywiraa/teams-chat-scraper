/**
 * The message view of one conversation: its newest messages first, in pages of 200, with day
 * headings, reply quotes, pictures in place, attachments, reactions, and earlier versions of
 * edited messages. Only the message keys are held for the whole chat; messages and pictures are read
 * per page. Text is shown through text nodes only (never parsed as HTML).
 */
import { timeFormat } from '../../export/render';
import { conversationLabel, type ConversationRecord, type StoredMessage } from '../../shared/types';
import { byId, countOf, el, formatNumber, TYPE_LABELS } from '../common';
import { conversationDetails, earlierPage, historyExtent, pictureBox, PICTURE_PLACEHOLDER, timeline, updatedText, type MessageView, type TimelineItem } from '../view-models';
import { conversationActions } from './conversations';
import { guarded, type AppContext } from './context';

const PAGE = 200;

interface Shown {
  record: ConversationRecord;
  keys: string[];
  /** Index in `keys` of the first message shown. */
  from: number;
  messages: StoredMessage[];
  /** Each picture read so far: its address and the size to draw it at (null when not recorded). */
  pictures: Map<string, { url: string; box: { width: number; height: number } | null }>;
}

let shown: Shown | null = null;
/** Increases with every conversation shown, so a slow read for an earlier one is dropped. */
let generation = 0;

/** Releases what the view holds (picture addresses), for example when another section is shown. */
export function closeConversation(): void {
  generation++;
  for (const { url } of shown?.pictures.values() ?? []) URL.revokeObjectURL(url);
  shown = null;
  byId('conv-view-messages').replaceChildren();
}

export function wireConversationView(app: AppContext): void {
  byId('btn-load-earlier').addEventListener('click', guarded(app, () => loadEarlier(app)));
  // The view opens at the newest message; this goes back to the chat's heading and actions.
  byId('btn-to-top').addEventListener('click', () => {
    window.scrollTo(0, 0);
    byId('conv-view-title').focus({ preventScroll: true });
  });
}

/** Shows a conversation; a key merged into another entry shows that entry. Returns the title shown. */
export async function showConversation(app: AppContext, key: string): Promise<string> {
  closeConversation();
  const mine = generation;
  const repo = await app.repository();
  let record = await repo.getConversation(key);
  if (!record) {
    record = (await repo.listConversations()).find((other) => (other.aliases ?? []).includes(key) || (other.mergedFrom ?? []).includes(key));
    if (record && mine === generation) {
      app.notify('This conversation was merged into the one shown here.', 'notice', { carry: true });
      app.go({ view: 'conversation', key: record.conversationKey });
      return conversationLabel(record);
    }
  }
  if (mine !== generation) return '';
  if (!record) {
    byId('conv-view-title').textContent = 'Conversation not found';
    byId('conv-view-meta').textContent = 'It may have been deleted or merged.';
    for (const id of ['conv-view-history', 'conv-view-details', 'conv-view-key', 'conv-view-range']) byId(id).textContent = '';
    byId('conv-view-details').hidden = true;
    byId('conv-view-actions').replaceChildren();
    byId('btn-load-earlier').hidden = true;
    byId('btn-to-top').hidden = true;
    byId('conv-view-empty').hidden = true;
    return 'Conversation not found';
  }
  const [keys, imageCount] = await Promise.all([repo.messageKeys(record.conversationKey), repo.countImages(record.conversationKey)]);
  if (mine !== generation) return '';
  renderHead(app, record, imageCount);
  const page = earlierPage(keys, keys.length, PAGE);
  shown = { record, keys, from: page.from, messages: await repo.getMessagesByKey(page.keys), pictures: new Map() };
  if (mine !== generation) return '';
  await renderMessages(app, mine);
  return conversationLabel(record);
}

/**
 * The chat's head, in two lines under its name: its type, who is in it and how many messages; then
 * the period archived, how much of the history that is, and when it was updated. What else it was
 * called follows only when it had other names.
 */
function renderHead(app: AppContext, record: ConversationRecord, imageCount: number): void {
  byId('conv-view-title').textContent = conversationLabel(record);
  const participants = record.participants.length > 0 ? `${record.participants.slice(0, 8).join(', ')}${record.participants.length > 8 ? `, and ${record.participants.length - 8} more` : ''}` : '';
  byId('conv-view-meta').textContent = [TYPE_LABELS[record.type], participants, countOf(record.messageCount, 'message')].filter(Boolean).join(' · ');
  byId('conv-view-history').textContent = [historyExtent(record), updatedText(record)].filter(Boolean).join(' · ');
  const details = conversationDetails(record);
  byId('conv-view-details').textContent = details;
  byId('conv-view-details').hidden = details === '';
  byId('conv-view-key').textContent = record.conversationKey;
  byId('conv-view-actions').replaceChildren(...conversationActions(app, record, imageCount));
}

async function loadEarlier(app: AppContext): Promise<void> {
  if (!shown || shown.from === 0) return;
  // Says it is loading; a second click meanwhile is ignored (guarded), so no page is added twice.
  const button = byId<HTMLButtonElement>('btn-load-earlier');
  const label = byId('btn-load-earlier-label');
  label.textContent = 'Loading earlier messages…';
  button.setAttribute('aria-disabled', 'true');
  try {
    await addEarlierPage(app);
  } finally {
    label.textContent = 'Show earlier messages';
    button.removeAttribute('aria-disabled');
  }
}

async function addEarlierPage(app: AppContext): Promise<void> {
  if (!shown || shown.from === 0) return;
  const mine = generation;
  const repo = await app.repository();
  const page = earlierPage(shown.keys, shown.from, PAGE);
  const earlier = await repo.getMessagesByKey(page.keys);
  if (mine !== generation || !shown) return;
  shown.from = page.from;
  shown.messages = [...earlier, ...shown.messages];
  // Keep the message that was first in the list where it was on screen (the list is drawn anew).
  const list = byId('conv-view-messages');
  const anchor = list.querySelector<HTMLElement>('li[data-key]');
  const anchorKey = anchor?.dataset.key;
  const top = anchor?.getBoundingClientRect().top ?? 0;
  await renderMessages(app, mine);
  const again = anchorKey ? Array.from(list.querySelectorAll<HTMLElement>('li[data-key]')).find((item) => item.dataset.key === anchorKey) : undefined;
  if (again) window.scrollBy(0, again.getBoundingClientRect().top - top);
}

async function renderMessages(app: AppContext, mine: number): Promise<void> {
  if (!shown) return;
  const { keys, from, messages } = shown;
  const time = timeFormat(undefined, navigator.language);
  const items = timeline(messages, time);
  byId('conv-view-messages').replaceChildren(...items.map((item) => timelineItem(item)));
  byId('conv-view-empty').hidden = keys.length > 0;
  byId('btn-load-earlier').hidden = from === 0;
  byId('btn-to-top').hidden = keys.length === 0;
  byId('conv-view-range').textContent =
    keys.length === 0 ? '' : keys.length === 1 ? '1 message' : from === 0 ? `All ${formatNumber(keys.length)} messages` : `The newest ${formatNumber(keys.length - from)} of ${formatNumber(keys.length)} messages`;
  await loadPictures(app, mine);
}

/** Reads the pictures of the messages shown, each once, and shows them in place. */
async function loadPictures(app: AppContext, mine: number): Promise<void> {
  if (!shown) return;
  const repo = await app.repository();
  for (const img of byId('conv-view-messages').querySelectorAll<HTMLImageElement>('img[data-image-id]')) {
    if (mine !== generation || !shown) return;
    const imageId = img.dataset.imageId as string;
    let picture = shown.pictures.get(imageId);
    if (!picture) {
      const image = await repo.getImage(shown.record.conversationKey, imageId);
      if (mine !== generation || !shown) return;
      if (!image) {
        img.replaceWith(el('span', { className: 'muted small' }, `Picture not saved: ${img.alt}`));
        continue;
      }
      picture = { url: URL.createObjectURL(new Blob([image.data], { type: image.mimeType })), box: pictureBox(image.width, image.height) };
      shown.pictures.set(imageId, picture);
    }
    // The size is set before the address, so the picture's space is fixed before it loads.
    if (picture.box) {
      img.width = picture.box.width;
      img.height = picture.box.height;
    }
    img.src = picture.url;
    (img.parentElement as HTMLAnchorElement).href = picture.url;
  }
}

function timelineItem(item: TimelineItem): HTMLLIElement {
  if (item.kind === 'day') return el('li', { className: 'day' }, el('h4', { className: 'visually-hidden' }, item.label), el('span', { 'aria-hidden': 'true' }, item.label));
  return messageItem(item.message, item.continued);
}

/** A message; one that continues its sender's run shows the name to screen readers only. */
function messageItem(message: MessageView, continued: boolean): HTMLLIElement {
  if (message.system) return el('li', { className: 'msg system', 'data-key': message.key }, `${message.time} · ${message.text}`);
  const flags = [message.edited ? 'edited' : '', message.deleted ? 'deleted' : ''].filter(Boolean);
  const text = message.text || (message.deleted ? 'This message was deleted.' : '');
  return el(
    'li',
    { className: `msg${message.self ? ' self' : ''}${continued ? ' continued' : ''}`, 'data-key': message.key },
    el(
      'div',
      { className: 'msg-meta' },
      el('span', { className: continued ? 'who visually-hidden' : 'who' }, message.sender),
      el('span', {}, message.time),
      flags.length > 0 ? el('span', {}, `(${flags.join(', ')})`) : null,
    ),
    message.reply ? el('blockquote', { className: 'msg-reply' }, `Replying to ${message.reply.who}${message.reply.text ? `: ${message.reply.text}` : ''}`) : null,
    text ? el('div', { className: 'msg-text' }, text) : null,
    message.pictures.length > 0
      ? el(
          'div',
          { className: 'msg-pictures' },
          ...message.pictures.map((picture) =>
            el(
              'a',
              { target: '_blank', rel: 'noopener', title: 'Open full size' },
              // Drawn in a placeholder box until the picture's recorded size is read.
              el('img', {
                alt: picture.name === 'image' ? 'Picture' : picture.name,
                'data-image-id': picture.imageId,
                width: String(PICTURE_PLACEHOLDER.width),
                height: String(PICTURE_PLACEHOLDER.height),
                loading: 'lazy',
              }),
            ),
          ),
        )
      : null,
    message.attachments.length > 0
      ? el(
          'ul',
          { className: 'msg-attachments' },
          ...message.attachments.map((att) =>
            el('li', {}, `${att.label}: `, att.href ? el('a', { href: att.href, target: '_blank', rel: 'noopener noreferrer' }, att.name) : att.name),
          ),
        )
      : null,
    message.reactions ? el('p', { className: 'msg-reactions' }, `Reactions: ${message.reactions}`) : null,
    message.history.length > 0
      ? el(
          'details',
          { className: 'msg-history' },
          el('summary', {}, message.history.length === 1 ? 'Earlier version' : `Earlier versions (${message.history.length})`),
          ...message.history.map((version) => el('blockquote', {}, el('div', { className: 'muted small' }, `Replaced ${version.replaced}`), version.text)),
        )
      : null,
  );
}
