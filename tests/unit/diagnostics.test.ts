import { afterEach, describe, expect, it } from 'vitest';
import { detectConversation } from '../../src/extractor/conversation';
import { runDiagnostics, skeletonOf } from '../../src/extractor/diagnostics';
import { buildSelectorProfile } from '../../src/extractor/selectors';
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

    expect(report.conversation).toEqual({ detected: true, keySource: 'dom', type: 'group', hasThreadId: true, titleLength: 'Secret Project'.length });
    expect(report.page).toMatchObject({ origin: 'https://teams.microsoft.com', path: '/l/chat/19:<id>@thread.v2/0' });
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
});

describe('skeletonOf', () => {
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
