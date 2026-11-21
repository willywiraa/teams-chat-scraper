/**
 * The Conversations section: the list with search, type filter and sorting, and the actions on
 * a conversation (export, rename, merge, delete, its images), which the message view uses too.
 */
import { STALE_SESSION_MS } from '../../shared/protocol';
import { imageFileName } from '../../shared/images';
import { conversationLabel, type ConversationRecord, type StoredImage } from '../../shared/types';
import { titleHistoryOf } from '../../storage/conversation-identity';
import { byId, el, errorText, formatAgo, formatDate, formatDateTime, formatNumber, TYPE_LABELS } from '../common';
import { icon } from '../icons';
import {
  conversationDetails,
  CONVERSATION_SORTS,
  filterConversations,
  historyLabel,
  routeHash,
  TYPE_FILTERS,
  type ConversationSort,
  type TypeFilter,
} from '../view-models';
import { guarded, type AppContext } from './context';

// -------------------------------------------------------------------- list

export function buildConversationList(app: AppContext): void {
  byId('conv-search-icon').replaceWith(icon('search'));
  byId('conv-type').replaceChildren(...TYPE_FILTERS.map(({ value, label }) => el('option', { value }, label)));
  byId('conv-sort').replaceChildren(...CONVERSATION_SORTS.map(({ value, label }) => el('option', { value }, label)));
  for (const id of ['conv-search', 'conv-type', 'conv-sort']) byId(id).addEventListener('input', () => void renderConversations(app));
  byId('btn-export-all').addEventListener('click', () => app.exportConversations());
}

export async function renderConversations(app: AppContext): Promise<void> {
  const repo = await app.repository();
  const all = await repo.listConversations();
  const imageCounts = new Map(await Promise.all(all.map(async (record) => [record.conversationKey, await repo.countImages(record.conversationKey)] as const)));
  const shown = filterConversations(all, {
    query: byId<HTMLInputElement>('conv-search').value,
    type: byId<HTMLSelectElement>('conv-type').value as TypeFilter,
    sort: byId<HTMLSelectElement>('conv-sort').value as ConversationSort,
  });
  byId('conversations').querySelector('tbody')!.replaceChildren(...shown.map((record) => conversationRow(app, record, imageCounts.get(record.conversationKey) ?? 0)));
  byId('conversations').hidden = shown.length === 0;
  byId('no-conversations').hidden = all.length > 0;
  byId('no-matches').hidden = all.length === 0 || shown.length > 0;
  byId('conv-count').textContent = all.length === 0 ? '' : shown.length === all.length ? `${formatNumber(all.length)} conversations` : `${formatNumber(shown.length)} of ${formatNumber(all.length)} conversations`;
  byId<HTMLButtonElement>('btn-export-all').disabled = all.length === 0;
}

/** The name, linking to the messages, then what else the chat was called and its key. */
function conversationCell(record: ConversationRecord): HTMLTableCellElement {
  const details = conversationDetails(record);
  return el(
    'td',
    { 'data-label': 'Conversation' },
    el(
      'div',
      {},
      el('a', { className: 'conv-title', href: routeHash({ view: 'conversation', key: record.conversationKey }) }, conversationLabel(record)),
      details ? el('div', { className: 'muted small' }, details) : null,
      el('div', { className: 'muted small mono' }, record.conversationKey),
    ),
  );
}

function conversationRow(app: AppContext, record: ConversationRecord, imageCount: number): HTMLTableRowElement {
  const label = conversationLabel(record);
  return el(
    'tr',
    {},
    conversationCell(record),
    el('td', { 'data-label': 'Type' }, TYPE_LABELS[record.type]),
    el('td', { className: 'num', 'data-label': 'Messages' }, formatNumber(record.messageCount)),
    el(
      'td',
      { className: 'num', 'data-label': 'Images' },
      imageCount > 0
        ? el('button', { type: 'button', className: 'link', title: 'View the saved images', 'aria-label': `View the ${imageCount} saved images of ${label}`, onclick: guarded(app, () => showImages(record)) }, formatNumber(imageCount))
        : '0',
    ),
    el('td', { 'data-label': 'History' }, historyLabel(record)),
    el('td', { 'data-label': 'Archived period' }, record.oldestSortKey !== null ? `${formatDate(record.oldestSortKey)} – ${formatDate(record.newestSortKey)}` : '–'),
    el(
      'td',
      { 'data-label': 'Last update', title: record.lastUpdate ? `Brought up to date on ${formatDateTime(record.lastUpdate.at)}` : 'No run has brought this chat up to date yet' },
      el('div', {}, record.lastUpdate ? formatAgo(record.lastUpdate.at) : '–', el('div', { className: 'muted small' }, `last run ${formatDateTime(record.lastExtractedAt)}`)),
    ),
    el('td', { className: 'actions', 'data-label': 'Actions' }, el('div', { className: 'cell-actions' }, ...conversationActions(app, record, imageCount, { list: true }))),
  );
}

/** Export, Rename, Merge and Delete for a conversation (and its images, outside the list). */
export function conversationActions(app: AppContext, record: ConversationRecord, imageCount: number, where: { list: boolean }): HTMLButtonElement[] {
  const merging = Boolean(record.mergedInto);
  const label = conversationLabel(record);
  const named = (action: string) => (where.list ? `${action} ${label}` : undefined);
  const buttons: HTMLButtonElement[] = [
    el('button', { type: 'button', title: 'Export this chat: HTML, PDF, Markdown, text, CSV, JSON or a knowledge package', 'aria-label': named('Export'), onclick: () => app.exportConversations([record.conversationKey]) }, 'Export…'),
  ];
  if (!where.list && imageCount > 0) buttons.push(el('button', { type: 'button', onclick: guarded(app, () => showImages(record)) }, `Images (${formatNumber(imageCount)})`));
  buttons.push(
    el('button', { type: 'button', disabled: merging, title: 'Give this chat a name in the archive', 'aria-label': named('Rename'), onclick: guarded(app, () => renameConversation(app, record)) }, 'Rename'),
    el('button', { type: 'button', disabled: merging, title: 'Merge with another entry of the same chat', 'aria-label': named('Merge'), onclick: guarded(app, () => openMerge(app, record)) }, 'Merge…'),
    el('button', { type: 'button', className: 'danger', disabled: merging, 'aria-label': named('Delete'), onclick: guarded(app, () => deleteConversation(app, record, imageCount, where)) }, 'Delete'),
  );
  return buttons;
}

async function renameConversation(app: AppContext, record: ConversationRecord): Promise<void> {
  const name = prompt('Name for this chat in the archive and in exports. Leave empty to show the Teams title.', record.displayName ?? record.title ?? '');
  if (name === null) return;
  const renamed = await (await app.repository()).renameConversation(record.conversationKey, name);
  app.notify(renamed.displayName ? `Renamed to “${renamed.displayName}”.` : 'The Teams title is shown again.', 'success');
  await app.refresh();
}

async function deleteConversation(app: AppContext, record: ConversationRecord, imageCount: number, where: { list: boolean }): Promise<void> {
  const ok = confirm(
    `Delete "${conversationLabel(record)}" with ${record.messageCount} archived messages${imageCount > 0 ? ` and ${imageCount} images` : ''} from this browser?\n\nThis cannot be undone. Export a backup first if you may need it.`,
  );
  if (!ok) return;
  const removed = await (await app.repository()).deleteConversation(record.conversationKey);
  app.notify(`Deleted ${formatNumber(removed.messages)} messages, ${formatNumber(removed.images)} images and ${removed.sessions} sessions.`, 'success', { carry: true });
  if (where.list) await app.refresh();
  else app.go({ view: 'conversations' });
}

// ------------------------------------------------------------------ images

let imageUrls: string[] = [];

function closeImages(): void {
  const dialog = byId<HTMLDialogElement>('image-dialog');
  if (dialog.open) dialog.close();
  for (const url of imageUrls) URL.revokeObjectURL(url);
  imageUrls = [];
  byId('image-grid').replaceChildren();
}

/** Shows the saved images of a conversation, with who sent each and when. */
async function showImages(record: ConversationRecord): Promise<void> {
  closeImages();
  const repo = await openRepository();
  const images = await repo.getImages(record.conversationKey);
  const context = new Map<string, { sortKey: number; caption: string }>();
  await repo.forEachMessage(record.conversationKey, (stored) => {
    for (const attachment of stored.attachments) {
      if (!attachment.imageId || context.has(attachment.imageId)) continue;
      const sender = stored.sender.name ?? (stored.sender.isSelf ? 'Me' : 'Unknown sender');
      context.set(attachment.imageId, { sortKey: stored.sortKey, caption: `${sender} · ${formatDateTime(stored.timestamp ?? stored.sortKey)}` });
    }
  });
  const position = (image: StoredImage) => context.get(image.imageId)?.sortKey ?? Number.MAX_VALUE;
  const ordered = [...images].sort((a, b) => position(a) - position(b) || a.firstSavedAt.localeCompare(b.firstSavedAt));
  byId('image-dialog-title').textContent = `${conversationLabel(record)}: ${formatNumber(images.length)} saved images`;
  byId('image-grid').replaceChildren(...ordered.map((image) => imageTile(image, context.get(image.imageId)?.caption ?? 'No longer referenced by a message')));
  byId<HTMLDialogElement>('image-dialog').showModal();
}

function imageTile(image: StoredImage, caption: string): HTMLElement {
  const url = URL.createObjectURL(new Blob([image.data], { type: image.mimeType }));
  imageUrls.push(url);
  const size = image.width && image.height ? `${image.width}×${image.height} · ` : '';
  return el(
    'figure',
    { className: 'image-tile' },
    el('a', { href: url, target: '_blank', rel: 'noopener', title: 'Open full size' }, el('img', { src: url, alt: caption, loading: 'lazy' })),
    el(
      'figcaption',
      { className: 'small' },
      el('div', {}, caption),
      el('div', { className: 'muted' }, `${size}${Math.max(1, Math.round(image.byteLength / 1024))} KB · `, el('a', { href: url, download: imageFileName(image) }, 'Download')),
    ),
  );
}

// ----------------------------------------------------------------- merging

let repositoryOf: AppContext['repository'] | null = null;
const openRepository = () => (repositoryOf as AppContext['repository'])();

let mergeApp: AppContext | null = null;
let mergeSource: ConversationRecord | null = null;
let mergeTargets: ConversationRecord[] = [];
/** For each other entry, how many messages it shares with the entry being merged. */
let mergeShared = new Map<string, number>();

/** Every name an entry was shown under, for suggesting entries of the same chat first. */
function namesOf(record: ConversationRecord): string[] {
  const names = [record.displayName, record.title, ...titleHistoryOf(record).map((seen) => seen.title)];
  return names.filter((name): name is string => Boolean(name)).map((name) => name.toLocaleLowerCase().replace(/\s+/g, ' ').trim());
}

/** 2 when two entries were shown under the same name, 1 when a name of one contains a name of the other. */
function nameLikeness(names: string[], others: string[]): number {
  let likeness = 0;
  for (const name of names) {
    for (const other of others) {
      if (name === other) return 2;
      const [shorter, longer] = name.length <= other.length ? [name, other] : [other, name];
      if (shorter.length >= 3 && longer.includes(shorter)) likeness = 1;
    }
  }
  return likeness;
}

function mergeTargetLabel(other: ConversationRecord, shared: number): string {
  const parts = [conversationLabel(other), `${formatNumber(other.messageCount)} messages`, `last run ${formatDate(other.lastExtractedAt)}`];
  if (shared > 0) parts.push(`${formatNumber(shared)} in common`);
  return parts.join(' · ');
}

async function openMerge(app: AppContext, record: ConversationRecord): Promise<void> {
  const repo = await app.repository();
  const others = (await repo.listConversations()).filter((other) => other.conversationKey !== record.conversationKey && !other.mergedInto);
  if (others.length === 0) {
    app.notify('There is no other archived conversation to merge with.');
    return;
  }
  // Suggest the entries most likely to be the same chat first, but let the user choose.
  const shared = new Map((await repo.entriesSharingMessages(record.conversationKey)).map((entry) => [entry.conversationKey, entry.shared] as const));
  const names = namesOf(record);
  const likeness = new Map(others.map((other) => [other.conversationKey, nameLikeness(names, namesOf(other))] as const));
  const sharedWith = (other: ConversationRecord) => shared.get(other.conversationKey) ?? 0;
  const likenessOf = (other: ConversationRecord) => likeness.get(other.conversationKey) ?? 0;
  others.sort((a, b) => sharedWith(b) - sharedWith(a) || likenessOf(b) - likenessOf(a) || b.lastExtractedAt.localeCompare(a.lastExtractedAt));
  mergeApp = app;
  mergeSource = record;
  mergeTargets = others;
  mergeShared = shared;
  byId('merge-source').textContent = `Merge “${conversationLabel(record)}” (${formatNumber(record.messageCount)} messages) with another archive entry of the same chat, for example after Teams renamed it.`;
  const select = byId<HTMLSelectElement>('merge-target');
  select.replaceChildren(
    el('option', { value: '' }, 'Choose the entry of the same chat…'),
    ...others.map((other) => el('option', { value: other.conversationKey }, mergeTargetLabel(other, sharedWith(other)))),
  );
  select.value = '';
  explainMerge();
  mergeMessage('');
  byId<HTMLDialogElement>('merge-dialog').showModal();
}

function mergeMessage(text: string, kind: 'notice' | 'error' = 'notice'): void {
  const element = byId('merge-message');
  element.textContent = text;
  element.className = `${kind} small`;
  element.hidden = text === '';
}

function explainMerge(): void {
  const target = mergeTargets.find((other) => other.conversationKey === byId<HTMLSelectElement>('merge-target').value);
  byId<HTMLButtonElement>('btn-merge-confirm').disabled = !target;
  if (!mergeSource) return;
  if (!target) {
    byId('merge-explain').textContent = 'Entries that hold some of the same messages, or were shown under a similar name, are listed first.';
    return;
  }
  const source = conversationLabel(mergeSource);
  const shared = mergeShared.get(target.conversationKey) ?? 0;
  const evidence =
    shared === 0
      ? 'No message was found in both entries: make sure they are the same chat. '
      : `${shared === 1 ? 'One message is' : `${formatNumber(shared)} messages are`} in both entries, so they are most likely the same chat. `;
  byId('merge-explain').textContent =
    evidence +
    `The messages, pictures and run history of “${source}” move into “${conversationLabel(target)}”, and “${source}” leaves the list. ` +
    'Messages archived in both are kept once. Its key and titles become other names of that entry, so the chat is found under either. ' +
    'This cannot be undone: export a backup first if you may need it.';
}

async function confirmMerge(): Promise<void> {
  const source = mergeSource;
  const app = mergeApp;
  const targetKey = byId<HTMLSelectElement>('merge-target').value;
  if (!source || !app || !targetKey) return;
  const buttons = [byId<HTMLButtonElement>('btn-merge-confirm'), byId<HTMLButtonElement>('btn-merge-cancel')];
  for (const button of buttons) button.disabled = true;
  let mergedInto: string | null = null;
  try {
    const outcome = await (await app.repository()).mergeConversations(source.conversationKey, targetKey, {
      staleSessionMs: STALE_SESSION_MS,
      onProgress: (progress) =>
        mergeMessage(`Moving… ${formatNumber(progress.messagesMoved)} of ${formatNumber(source.messageCount)} messages${progress.imagesMoved > 0 ? `, ${formatNumber(progress.imagesMoved)} images` : ''}`),
    });
    byId<HTMLDialogElement>('merge-dialog').close();
    mergedInto = outcome.target.conversationKey;
    app.notify(`Merged into “${conversationLabel(outcome.target)}”, which now holds ${formatNumber(outcome.target.messageCount)} messages.`, 'success', { carry: true });
  } catch (error) {
    mergeMessage(errorText(error), 'error');
  } finally {
    for (const button of buttons) button.disabled = false;
  }
  // From the message view of the merged entry, show the entry it went into.
  if (mergedInto && location.hash === routeHash({ view: 'conversation', key: source.conversationKey })) app.go({ view: 'conversation', key: mergedInto });
  else await app.refresh();
}

/** Finishes merges that were interrupted, for example by closing this page. */
export async function resumeMerges(app: AppContext): Promise<void> {
  try {
    const finished = await (await app.repository()).resumePendingMerges({ staleSessionMs: STALE_SESSION_MS });
    if (finished > 0) app.notify(`Finished ${finished === 1 ? 'a merge' : `${finished} merges`} that had been interrupted.`, 'success', { carry: true });
  } catch (error) {
    app.notify(`An interrupted merge could not be finished: ${errorText(error)}`, 'error', { carry: true });
  }
}

/** Wires the image and merge dialogs (once). */
export function wireConversationDialogs(app: AppContext): void {
  repositoryOf = () => app.repository();
  byId('btn-image-close').addEventListener('click', closeImages);
  byId<HTMLDialogElement>('image-dialog').addEventListener('close', closeImages);
  byId('merge-target').addEventListener('change', explainMerge);
  byId('btn-merge-confirm').addEventListener('click', () => void confirmMerge());
  byId('btn-merge-cancel').addEventListener('click', () => byId<HTMLDialogElement>('merge-dialog').close());
  byId<HTMLDialogElement>('merge-dialog').addEventListener('close', () => {
    mergeSource = null;
    mergeTargets = [];
  });
}
