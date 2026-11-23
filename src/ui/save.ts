/**
 * The save page: writes one file and says what it wrote. It is opened in a tab of its own, by the
 * background when a capture that saves a file ends, by the popup (*Save a file from the archive
 * only*) and by the archive page (a chat's *Save a file…*, *Back up now*), so closing the popup
 * cancels nothing. Its address says what to save (see `parseSaveTarget`).
 *
 * A file is downloaded; a PDF is printed from a preview of the page in this tab.
 */
import { isFullBackup, packagingOf, parseSaveTarget, sessionSaveRange, type SaveChoices, type SaveTarget, type TimeRange } from '../export/options';
import { runExport, writePrintable, type ExportProgress, type ExportRequest, type ExportTotals } from '../export/pipeline';
import { conversationLabel, type ConversationRecord } from '../shared/types';
import { ArchiveRepository } from '../storage/repository';
import { byId, countOf, downloadBlob, errorText, formatDateTime, formatMoment, formatNumber } from './common';
import { recordBackup } from './last-backup';
import { recordLastSave } from './last-save';
import { FORMAT_NAMES } from './save-form';
import { routeHash } from './view-models';

const APP_NAME = 'Teams Chat Scraper';

interface Job {
  request: ExportRequest;
  choices: SaveChoices;
  /** The chat saved, or null for every chat. */
  record: ConversationRecord | null;
  /** The capture the file is saved for, or null. */
  sessionId: string | null;
  /** The messages saved, in words: "messages since 16 Nov 2026". */
  period: string;
}

class NothingToSave extends Error {}

function status(text: string, error = false): void {
  const element = byId('save-status');
  element.textContent = text;
  element.className = error ? 'error-text small' : 'small';
}

function periodText(range: TimeRange, onScreen: boolean): string {
  if (onScreen) return 'the messages the capture found on screen';
  if (range.from === null && range.to === null) return 'all archived messages';
  if (range.to === null) return `messages since ${formatMoment(range.from as number)}`;
  if (range.from === null) return `messages before ${formatDateTime(range.to)}`;
  return `messages from ${formatMoment(range.from)} to ${formatDateTime(range.to - 1)}`;
}

/** The archive entry of a key, also when the chat was merged into another one since. */
async function findRecord(repository: ArchiveRepository, key: string): Promise<ConversationRecord> {
  const record =
    (await repository.getConversation(key)) ??
    (await repository.listConversations()).find((other) => (other.aliases ?? []).includes(key) || (other.mergedFrom ?? []).includes(key));
  if (!record) throw new NothingToSave('This chat is not in the archive any more. It may have been deleted or merged.');
  if (record.messageCount === 0) throw new NothingToSave('No messages are archived for this chat, so there is nothing to save.');
  return record;
}

async function jobOf(repository: ArchiveRepository, target: SaveTarget): Promise<Job> {
  const version = chrome.runtime.getManifest().version;
  const request = (conversations: string[] | 'all', choices: SaveChoices, range: TimeRange): ExportRequest => ({
    conversations,
    format: choices.format,
    packaging: packagingOf(choices),
    range,
    content: choices.content,
    generatorVersion: version,
  });
  switch (target.kind) {
    case 'session': {
      const session = await repository.getSession(target.sessionId);
      if (!session?.save) throw new NothingToSave('This capture has no file to save.');
      const record = await findRecord(repository, session.conversationKey);
      const range = sessionSaveRange(session);
      return { request: request([record.conversationKey], session.save, range), choices: session.save, record, sessionId: session.sessionId, period: periodText(range, session.mode === 'visible') };
    }
    case 'conversation': {
      const record = await findRecord(repository, target.conversationKey);
      return { request: request([record.conversationKey], target.choices, target.range), choices: target.choices, record, sessionId: null, period: periodText(target.range, false) };
    }
    case 'all': {
      const records = await repository.listConversations();
      if (records.every((record) => record.messageCount === 0)) throw new NothingToSave('Nothing is archived yet, so there is nothing to save.');
      return { request: request('all', target.choices, { from: null, to: null }), choices: target.choices, record: null, sessionId: null, period: `every archived chat, ${countOf(records.length, 'chat')}` };
    }
  }
}

/** "451 messages and 3 pictures", with the chats when there are several. */
function summaryText(totals: ExportTotals): string {
  const what = `${countOf(totals.messages, 'message')}${totals.pictures > 0 ? ` and ${countOf(totals.pictures, 'picture')}` : ''}`;
  return totals.conversations > 1 ? `${what} from ${countOf(totals.conversations, 'chat')}` : what;
}

function progress(update: ExportProgress): void {
  const several = update.conversations > 1;
  status(`Writing ${formatNumber(update.messages)} messages${several ? `, chat ${update.conversation} of ${update.conversations}` : ''}…`);
  const bar = byId('save-progress');
  bar.hidden = !several;
  if (several) {
    const percent = Math.round(((update.conversation - 1) / update.conversations) * 100);
    byId('save-progress-fill').style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(percent));
    bar.setAttribute('aria-valuetext', `Chat ${update.conversation} of ${update.conversations}`);
  }
}

/** Waits until the pictures of a page have loaded (or failed), at most `timeoutMs`. */
function picturesLoaded(doc: Document, timeoutMs = 15_000): Promise<void> {
  const pending = Array.from(doc.images).filter((img) => !img.complete);
  const loaded = Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        }),
    ),
  );
  return Promise.race([loaded.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

async function download(repository: ArchiveRepository, job: Job): Promise<string> {
  const outcome = await runExport(repository, job.request, progress);
  byId('save-progress').hidden = true;
  if (outcome.messages === 0) throw new NothingToSave('No archived messages are in that period, so no file was saved.');
  downloadBlob(outcome.fileName, outcome.blob);
  const archived = (await repository.listConversations()).map((record) => record.conversationKey);
  if (isFullBackup(job.request, archived)) {
    await recordBackup({ at: new Date().toISOString(), conversations: outcome.conversations, messages: outcome.messages }).catch(() => undefined);
  }
  status(`Saved ${outcome.fileName}: ${summaryText(outcome)}. It is in the browser’s downloads.`);
  return outcome.fileName;
}

/** Writes the printable page into the preview, pictures as object URLs, and opens the print dialog for it. */
async function print(repository: ArchiveRepository, job: Job): Promise<void> {
  const frame = byId<HTMLIFrameElement>('save-preview');
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) throw new Error('The page to print could not be prepared.');
  const urls: string[] = [];
  window.addEventListener('pagehide', () => urls.forEach((url) => URL.revokeObjectURL(url)), { once: true });
  doc.open();
  const totals = await writePrintable(
    repository,
    job.request,
    (text) => doc.write(text),
    (image) => {
      const url = URL.createObjectURL(new Blob([image.data], { type: image.mimeType }));
      urls.push(url);
      return url;
    },
    progress,
  );
  doc.close();
  byId('save-progress').hidden = true;
  if (totals.messages === 0) throw new NothingToSave('No archived messages are in that period, so there is nothing to print.');
  frame.hidden = false;
  await picturesLoaded(doc);
  status(`${summaryText(totals)} are ready. In the print dialog, choose “Save as PDF” as the printer.`);
  const again = byId<HTMLButtonElement>('btn-print-again');
  again.hidden = false;
  again.onclick = () => win.print();
  win.focus();
  win.print();
}

async function main(): Promise<void> {
  const target = parseSaveTarget(location.hash);
  if (!target) {
    byId('save-title').textContent = 'Nothing to save';
    status('Choose a file to save in the popup, or on a chat’s page in the archive.');
    return;
  }
  try {
    const repository = await ArchiveRepository.open();
    const job = await jobOf(repository, target);
    const title = job.record ? conversationLabel(job.record) : 'All archived chats';
    byId('save-title').textContent = title;
    // The PDF is offered under the chat's name.
    document.title = job.choices.format === 'pdf' ? title : `${title} · ${APP_NAME}`;
    const what = byId('save-what');
    what.textContent = `${FORMAT_NAMES[job.choices.format]} · ${job.period}`;
    what.hidden = false;
    const link = byId<HTMLAnchorElement>('link-archive');
    if (job.record) {
      link.href = `archive.html${routeHash({ view: 'conversation', key: job.record.conversationKey })}`;
      link.textContent = 'Open this chat in the archive';
    }
    byId('save-actions').hidden = false;
    status('Preparing the file…');
    const fileName = job.choices.format === 'pdf' ? (await print(repository, job), null) : await download(repository, job);
    if (target.kind === 'session') await recordLastSave({ sessionId: target.sessionId, fileName, problem: null }).catch(() => undefined);
  } catch (error) {
    const problem = error instanceof NothingToSave ? error.message : `The file could not be saved: ${errorText(error)}`;
    status(problem, !(error instanceof NothingToSave));
    byId('save-progress').hidden = true;
    byId('save-actions').hidden = false;
    if (target.kind === 'session') await recordLastSave({ sessionId: target.sessionId, fileName: null, problem }).catch(() => undefined);
  }
}

void main();
