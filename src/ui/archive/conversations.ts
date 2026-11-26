/**
 * Conversations, at the top of the archive page: the list with search, type filter and sorting,
 * for finding and opening a chat; and the actions on a conversation (save a file, its images,
 * and in a menu rename, merge, copy its key, delete), which its message view shows.
 */
import { saveTargetHash } from '../../export/options';
import { STALE_SESSION_MS } from '../../shared/protocol';
import { imageFileName } from '../../shared/images';
import { conversationLabel, type ConversationRecord, type StoredImage } from '../../shared/types';
import { titleHistoryOf } from '../../storage/conversation-identity';
import { byId, countOf, el, errorText, formatAgo, formatDate, formatDateTime, formatNumber, TYPE_LABELS } from '../common';
import { icon, type IconName } from '../icons';
import { fileNoun, loadSaveChoices, SaveForm } from '../save-form';
import {
  archivedPeriod,
  conversationDetails,
  CONVERSATION_SORTS,
  filterConversations,
  historyLabel,
  historyLine,
  routeHash,
  TYPE_FILTERS,
  type ConversationSort,
  type TypeFilter,
} from '../view-models';
import { guarded, type AppContext } from './context';
import { actionMenu } from './menu';

// -------------------------------------------------------------------- list

export function buildConversationList(app: AppContext): void {
  byId('conv-search-icon').replaceWith(icon('search'));
  byId('conv-type').replaceChildren(...TYPE_FILTERS.map(({ value, label }) => el('option', { value }, label)));
  byId('conv-sort').replaceChildren(...CONVERSATION_SORTS.map(({ value, label }) => el('option', { value }, label)));
  for (const id of ['conv-search', 'conv-type', 'conv-sort']) byId(id).addEventListener('input', () => void renderConversations(app));
  byId('btn-clear-search').addEventListener('click', () => {
    byId<HTMLInputElement>('conv-search').value = '';
    byId<HTMLSelectElement>('conv-type').value = TYPE_FILTERS[0]!.value;
    void renderConversations(app);
    byId('conv-search').focus();
  });
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
  byId('conv-count').textContent = all.length === 0 ? '' : shown.length === all.length ? countOf(all.length, 'conversation') : `${formatNumber(shown.length)} of ${countOf(all.length, 'conversation')}`;
}

/**
 * The name, linking to the messages, then what else the chat was called. In a narrow window the
 * row is a card, and this cell also gives the type and the history on one line.
 */
function conversationCell(record: ConversationRecord): HTMLTableCellElement {
  const details = conversationDetails(record);
  return el(
    'td',
    {},
    el('a', { className: 'conv-title', href: routeHash({ view: 'conversation', key: record.conversationKey }) }, conversationLabel(record)),
    details ? el('div', { className: 'muted small' }, details) : null,
    el('div', { className: 'narrow-only muted small' }, `${TYPE_LABELS[record.type]} · ${historyLine(record)}`),
  );
}

/**
 * When the chat was last brought up to date, as a relative time ("4 days ago"). The full date, and
 * its last run when that was later, are in the tooltip; the chat's own page says it too.
 */
function lastUpdateCell(record: ConversationRecord): HTMLTableCellElement {
  const update = record.lastUpdate?.at;
  const laterRun = update && Date.parse(record.lastExtractedAt) - Date.parse(update) > 60_000;
  const title = update
    ? `${formatDateTime(update)}${laterRun ? ` · last run ${formatDateTime(record.lastExtractedAt)}` : ''}`
    : `Last run ${formatDateTime(record.lastExtractedAt)}`;
  return el('td', { className: 'wide-only' }, el('time', { dateTime: update ?? record.lastExtractedAt, title }, update ? formatAgo(update) : 'Not yet'));
}

function conversationRow(app: AppContext, record: ConversationRecord, imageCount: number): HTMLTableRowElement {
  const label = conversationLabel(record);
  return el(
    'tr',
    {},
    conversationCell(record),
    el('td', { className: 'wide-only' }, TYPE_LABELS[record.type]),
    el('td', { className: 'num wide-only' }, formatNumber(record.messageCount)),
    el(
      'td',
      { className: `num${imageCount > 0 ? '' : ' wide-only'}` },
      imageCount > 0
        ? el(
            'button',
            { type: 'button', className: 'link', 'aria-label': `View the ${countOf(imageCount, 'saved image')} of ${label}`, onclick: guarded(app, () => showImages(record)) },
            formatNumber(imageCount),
            el('span', { className: 'narrow-only-inline' }, imageCount === 1 ? ' saved image' : ' saved images'),
          )
        : '0',
    ),
    el('td', { className: 'wide-only' }, el('div', { className: 'cell-stack' }, historyBadge(record), el('span', { className: 'muted small' }, archivedPeriod(record)))),
    lastUpdateCell(record),
  );
}

/** The history column: Complete, Partial or Not checked, as a badge whose words carry the state. */
function historyBadge(record: ConversationRecord): HTMLSpanElement {
  const label = historyLabel(record);
  const tone = label === 'Complete' ? 'success' : label === 'Not checked' ? 'neutral' : '';
  return el('span', { className: `badge ${tone}`.trim() }, label);
}

/**
 * The actions on a conversation, on its message view: **Save a file…** and its images as buttons,
 * then a ⋯ menu with Rename, Merge, Copy chat key and, last and apart, Delete.
 */
export function conversationActions(app: AppContext, record: ConversationRecord, imageCount: number): HTMLElement[] {
  const merging = Boolean(record.mergedInto);
  const button = (name: IconName, text: string, props: Parameters<typeof el>[1]): HTMLButtonElement =>
    el('button', { type: 'button', ...props }, el('span', { className: 'icon-holder' }, icon(name)), text);
  const actions: HTMLElement[] = [
    button('file-down', 'Save a file…', { className: 'primary', disabled: record.messageCount === 0, onclick: guarded(app, () => saveConversation(record)) }),
  ];
  if (imageCount > 0) actions.push(button('images', `Images (${formatNumber(imageCount)})`, { onclick: guarded(app, () => showImages(record)) }));
  actions.push(
    actionMenu('More actions', [
      [
        { icon: 'pencil', label: 'Rename…', disabled: merging, action: guarded(app, () => renameConversation(app, record)) },
        { icon: 'merge', label: 'Merge…', disabled: merging, action: guarded(app, () => openMerge(app, record)) },
        { icon: 'copy', label: 'Copy chat key', action: guarded(app, () => copyKey(app, record)) },
      ],
      [{ icon: 'trash', label: 'Delete…', danger: true, disabled: merging, action: guarded(app, () => deleteConversation(app, record, imageCount)) }],
    ]),
  );
  return actions;
}

/**
 * Copies the chat's key, which the search finds it by. When the browser refuses (the page not in
 * focus), the status line shows the key to select instead, so it is never out of reach.
 */
async function copyKey(app: AppContext, record: ConversationRecord): Promise<void> {
  try {
    await navigator.clipboard.writeText(record.conversationKey);
    app.notify('Copied the chat key.', 'success');
  } catch {
    app.notify(`The browser did not allow copying. The chat key is ${record.conversationKey}`, 'notice');
  }
}

/** Opens a dialog and settles with what its buttons gave once it closes (Escape gives `cancelled`). */
function ask<T>(dialog: HTMLDialogElement, cancelled: T, wire: (answer: (value: T) => void) => () => void): Promise<T> {
  return new Promise((resolve) => {
    let result = cancelled;
    const unwire = wire((value) => {
      result = value;
      dialog.close();
    });
    dialog.addEventListener(
      'close',
      () => {
        unwire();
        resolve(result);
      },
      { once: true },
    );
    dialog.showModal();
  });
}

let saveForm: SaveForm | null = null;

/** The label of the dialog's button, which names the file. */
function showSaveLabel(): void {
  if (saveForm) byId('btn-save-confirm').textContent = `Save ${fileNoun(saveForm.value)}`;
}

/**
 * Asks for the format and what to include, then saves the chat's archived messages in a new tab
 * (the save page). The choices are the popup's, remembered.
 */
async function saveConversation(record: ConversationRecord): Promise<void> {
  saveForm ??= new SaveForm(byId('save-dialog-choices'), showSaveLabel);
  saveForm.set(await loadSaveChoices());
  showSaveLabel();
  byId('save-dialog-what').textContent = `${conversationLabel(record)} · all ${countOf(record.messageCount, 'archived message')}. The file is saved in a new tab.`;
  const dialog = byId<HTMLDialogElement>('save-dialog');
  const confirmed = await ask(dialog, false, (answer) => {
    const form = byId('save-dialog-form');
    const cancel = byId('btn-save-cancel');
    const submit = (event: Event) => {
      event.preventDefault();
      answer(true);
    };
    const close = () => dialog.close();
    form.addEventListener('submit', submit);
    cancel.addEventListener('click', close);
    return () => {
      form.removeEventListener('submit', submit);
      cancel.removeEventListener('click', close);
    };
  });
  if (!confirmed || !saveForm) return;
  const target = saveTargetHash({ kind: 'conversation', conversationKey: record.conversationKey, choices: saveForm.value, range: { from: null, to: null } });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`save.html${target}`) });
}

/** The new name, '' for the Teams title again, or null when cancelled. */
function askName(current: string): Promise<string | null> {
  const dialog = byId<HTMLDialogElement>('rename-dialog');
  const input = byId<HTMLInputElement>('rename-input');
  input.value = current;
  const promise = ask<string | null>(dialog, null, (answer) => {
    const form = byId('rename-form');
    const cancel = byId('btn-rename-cancel');
    const submit = (event: Event) => {
      event.preventDefault();
      answer(input.value);
    };
    const close = () => dialog.close();
    form.addEventListener('submit', submit);
    cancel.addEventListener('click', close);
    return () => {
      form.removeEventListener('submit', submit);
      cancel.removeEventListener('click', close);
    };
  });
  input.select();
  return promise;
}

function askDelete(text: string): Promise<boolean> {
  const dialog = byId<HTMLDialogElement>('delete-dialog');
  byId('delete-text').textContent = text;
  return ask(dialog, false, (answer) => {
    const confirmButton = byId('btn-delete-confirm');
    const cancel = byId('btn-delete-cancel');
    const yes = () => answer(true);
    const close = () => dialog.close();
    confirmButton.addEventListener('click', yes);
    cancel.addEventListener('click', close);
    return () => {
      confirmButton.removeEventListener('click', yes);
      cancel.removeEventListener('click', close);
    };
  });
}

async function renameConversation(app: AppContext, record: ConversationRecord): Promise<void> {
  const name = await askName(record.displayName ?? record.title ?? '');
  if (name === null) return;
  const renamed = await (await app.repository()).renameConversation(record.conversationKey, name);
  app.notify(renamed.displayName ? `Renamed to “${renamed.displayName}”.` : 'The Teams title is shown again.', 'success');
  await app.refresh();
  // The refresh drew the actions again; give the focus back to the menu Rename was chosen from.
  byId('conv-view-actions').querySelector<HTMLButtonElement>('.menu-button')?.focus();
}

async function deleteConversation(app: AppContext, record: ConversationRecord, imageCount: number): Promise<void> {
  const ok = await askDelete(
    `“${conversationLabel(record)}”, with ${countOf(record.messageCount, 'archived message')}${imageCount > 0 ? ` and ${countOf(imageCount, 'image')}` : ''}, will be deleted from this browser.`,
  );
  if (!ok) return;
  const removed = await (await app.repository()).deleteConversation(record.conversationKey);
  app.notify(`Deleted ${countOf(removed.messages, 'message')}, ${countOf(removed.images, 'image')} and ${countOf(removed.sessions, 'run')}.`, 'success', { carry: true });
  app.go({ view: 'home', section: 'conversations' });
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
  byId('image-dialog-title').textContent = `${conversationLabel(record)}: ${countOf(images.length, 'saved image')}`;
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
    el('a', { href: url, target: '_blank', rel: 'noopener', title: 'Open full size' }, el('img', { src: url, alt: caption, loading: 'lazy', width: image.width ? String(image.width) : false, height: image.height ? String(image.height) : false })),
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
  const parts = [conversationLabel(other), countOf(other.messageCount, 'message'), `last run ${formatDate(other.lastExtractedAt)}`];
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
  byId('merge-source').textContent = `Merge “${conversationLabel(record)}” (${countOf(record.messageCount, 'message')}) with another archive entry of the same chat, for example after Teams renamed it.`;
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
    'This cannot be undone: back up first if you may need it.';
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
        mergeMessage(`Moving… ${formatNumber(progress.messagesMoved)} of ${countOf(source.messageCount, 'message')}${progress.imagesMoved > 0 ? `, ${countOf(progress.imagesMoved, 'image')}` : ''}`),
    });
    byId<HTMLDialogElement>('merge-dialog').close();
    mergedInto = outcome.target.conversationKey;
    app.notify(`Merged into “${conversationLabel(outcome.target)}”, which now holds ${countOf(outcome.target.messageCount, 'message')}.`, 'success', { carry: true });
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
