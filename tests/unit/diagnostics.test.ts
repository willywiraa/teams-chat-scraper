import { afterEach, describe, expect, it } from 'vitest';
import { detectConversation } from '../../src/extractor/conversation';
import { runDiagnostics, skeletonOf } from '../../src/extractor/diagnostics';
import { buildSelectorProfile } from '../../src/extractor/selectors';
import {
  HEADER_WITH_IDS,
  NEW_TEAMS_URL,
  ONE_ON_ONE_THREAD,
  PAGE_SECRETS,
  newTeamsMessageHtml,
  renderNewTeamsPage,
} from '../helpers/new-teams-page';
import { renderStaticChat, type FixtureMessage } from '../helpers/teams-dom';

const profile = buildSelectorProfile();
const URL = 'https://teams.microsoft.com/l/chat/19%3Aaaaa1111%40thread.v2/0?tenantId=123456';

afterEach(() => {
  document.body.innerHTML = '';
});

function diagnose() {
  return runDiagnostics(document, {
    profile,
    conversation: detectConversation(document, URL, profile),
    href: URL,
    selfDisplayName: null,
    dateOrder: 'MDY',
    referenceMs: Date.UTC(2024, 0, 17, 12),
    scrollContainer: document.querySelector<HTMLElement>('[data-tid="message-pane-list-viewport"]'),
  });
}

const chat: FixtureMessage[] = [
  { id: '1705314600000', author: 'Alice Andersen', time: '2024-01-15T10:30:00Z', paragraphs: ['Confidential budget numbers', 'Second paragraph'] },
  { id: '1705314660000', time: '2024-01-15T10:31:00Z', paragraphs: ['Follow-up'], attachments: [{ name: 'salaries.xlsx' }] },
  { divider: 'Today' },
  { id: '1705400000000', self: true, time: '2024-01-16T10:13:20Z', paragraphs: ['My reply'], reply: { id: '1705314600000', author: 'Alice Andersen', preview: 'Confidential budget numbers' } },
];

describe('runDiagnostics', () => {
  it('summarises how the page was understood without revealing any content', () => {
    renderStaticChat(chat, { title: 'Secret Project' });
    const report = diagnose();

    expect(report.reportVersion).toBe(3);
    expect(report.conversation).toEqual({ detected: true, keySource: 'dom', type: 'group', hasThreadId: true, titleLength: 'Secret Project'.length });
    expect(report.page).toMatchObject({ origin: 'https://teams.microsoft.com', path: '/l/chat/<thread:v2>/0' });
    expect(report.messageList.found).toBe(true);
    expect(report.parse).toMatchObject({ messages: 3, dividers: 1, withMessageId: 3, senderExplicit: 1, senderInferred: 1, senderSelf: 1, withAttachments: 1, withReply: 1 });
    expect(report.samples[0]).toMatchObject({ hasMessageId: true, senderSource: 'explicit', timestampSource: 'datetime-attr', paragraphs: 2 });
    expect(report.samples[1]?.attachments).toEqual(['file']);

    const json = JSON.stringify(report);
    for (const secret of ['Secret Project', 'Alice Andersen', 'Confidential', 'Follow-up', 'My reply', 'salaries', '1705314600000', 'aaaa1111']) {
      expect(json).not.toContain(secret);
    }
  });

  it('explains what is missing on pages it cannot read', () => {
    document.body.innerHTML = '<div data-tid="app-shell"><p>Calendar</p></div>';
    const report = runDiagnostics(document, { profile, conversation: null, href: 'not a url', selfDisplayName: null, dateOrder: 'MDY', referenceMs: 0 });
    expect(report.messageList.found).toBe(false);
    expect(report.warnings.join(' ')).toMatch(/Message list not found.*Conversation could not be identified/);
    expect(report.skeleton).toBeNull();
  });

  it('warns when messages carry no ids or timestamps', () => {
    renderStaticChat([
      { id: null, author: 'Alice Andersen', time: null, paragraphs: ['a'] },
      { id: null, time: null, paragraphs: ['b'] },
    ]);
    const warnings = diagnose().warnings.join(' ');
    expect(warnings).toMatch(/No Teams message ids found/);
    expect(warnings).toMatch(/No timestamps found/);
  });

  it('warns when reactions are shown in markup the reaction selectors do not match', () => {
    renderStaticChat(chat);
    expect(diagnose().warnings.join(' ')).toContain('Reaction markup was found ([data-tid*="reaction"]), but the reaction selectors match none of it.');
  });
});

describe('identifier probe in the report', () => {
  function diagnoseNewTeams() {
    return runDiagnostics(document, {
      profile,
      conversation: detectConversation(document, NEW_TEAMS_URL, profile),
      href: NEW_TEAMS_URL,
      selfDisplayName: null,
      dateOrder: 'DMY',
      referenceMs: Date.UTC(2024, 0, 17, 12),
    });
  }

  it('points to a thread id that is on the page but not read yet, and reveals nothing', () => {
    renderNewTeamsPage({ header: HEADER_WITH_IDS });
    const report = diagnoseNewTeams();

    expect(report.conversation).toMatchObject({ detected: true, hasThreadId: false, keySource: 'title' });
    expect(report.identifiers.findings).toContainEqual(expect.objectContaining({ region: 'chat-header', attribute: 'id', kind: 'thread:unq' }));
    expect(report.warnings.join(' ')).toMatch(/thread id is shown in the chat header \(id\)/);
    expect(report.skeletons.chatHeader).toContain('id="chat-header-<thread:unq>"');

    const json = JSON.stringify(report);
    for (const secret of PAGE_SECRETS) expect(json).not.toContain(secret);
  });

  it('says when the highlighted chat-list entry carries a thread id but the selectors miss it', () => {
    renderNewTeamsPage({ entry: `<div role="option" aria-current="true" data-item-id="${ONE_ON_ONE_THREAD}"><span>Alice Andersen</span></div>` });
    const report = diagnoseNewTeams();

    expect(report.warnings.join(' ')).toMatch(/highlighted chat-list entry \(div\[role="option"\]\) has a thread id \(data-item-id\).*"selectedChatItem"/);
    expect(report.skeletons.highlightedEntry).toContain('<div role="option" aria-current="true" [data-item-id]>');
  });

  it('says when no thread id for the chat is shown anywhere', () => {
    renderNewTeamsPage();
    expect(diagnoseNewTeams().warnings.join(' ')).toMatch(/No thread id for this chat is shown on the page/);
  });

  it('counts reply, reaction and image markup, and reads the reactions', () => {
    const reference = '<div data-tid="referencePreview" role="group" aria-label="Begin Reference, Alice Andersen, Original words"><p>Original words</p></div>';
    const extras = '<button data-tid="diverse-reaction-pill-button">👍 2</button><img data-tid="rich-file-preview-image" src="blob:https://teams.microsoft.com/0f0f">';
    renderNewTeamsPage({ items: newTeamsMessageHtml(reference + extras) });
    const report = diagnoseNewTeams();

    expect(report.probes['message.reply']).toContainEqual({ selector: '[data-tid="referencePreview"]', count: 1 });
    expect(report.probes['message.reply']).toContainEqual({ selector: '[role="group"][aria-label^="Begin Reference"]', count: 1 });
    expect(report.probes['message.reaction']).toContainEqual({ selector: '[data-tid="diverse-reaction-pill-button"]', count: 1 });
    expect(report.hits.reaction).toContainEqual({ selector: '[data-tid="diverse-reaction-pill-button"]', count: 1 });
    expect(report.parse.withReactions).toBe(1);
    expect(report.samples[0]?.reactions).toBe(1);
    expect(report.warnings.join(' ')).not.toMatch(/Reaction markup/);
    expect(report.probes['message.image']).toContainEqual({ selector: 'img[data-tid="rich-file-preview-image"]', count: 1 });
    expect(report.warnings.join(' ')).toMatch(/Quoted replies are shown as \[data-tid="referencePreview"\].*not recognise/);
    expect(report.skeletons.reply).toContain('<div data-tid="referencePreview" role="group" [aria-label]>');

    const json = JSON.stringify(report);
    for (const secret of PAGE_SECRETS) expect(json).not.toContain(secret);
  });
});

describe('skeletonOf', () => {
  it('drops person ids and GUIDs from ids and test ids', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span id="chat-topic-person-8:orgid:1a2b3c4d-0000-4e5f-8a9b-abcdefabcdef" data-tid="avatar-9f8e7d6c-1111-4b2a-9c3d-fedcbafedcba"></span>';
    const skeleton = skeletonOf(root);
    expect(skeleton).toContain('id="chat-topic-person-<person:orgid>"');
    expect(skeleton).toContain('data-tid="avatar-<guid>"');
    expect(skeleton).not.toMatch(/1a2b3c4d|9f8e7d6c/);
  });

  it('keeps structure and test ids but drops text and ids', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div data-tid="chat-pane-message" class="fui-ChatMessage custom-x" id="message-1705314600000" data-mid="1705314600000"><p>Private words</p></div>';
    const skeleton = skeletonOf(root);
    expect(skeleton).toContain('data-tid="chat-pane-message"');
    expect(skeleton).toContain('fui-ChatMessage');
    expect(skeleton).not.toContain('Private');
    expect(skeleton).not.toContain('1705314600000');
    expect(skeleton).not.toContain('custom-x');
  });
});
