import { describe, expect, it } from 'vitest';
import { parseItem, type ItemParseContext, type RawMessage } from '../../src/extractor/message-parser';
import { buildSelectorProfile } from '../../src/extractor/selectors';
import { itemElement, type FixtureMessage } from '../helpers/teams-dom';

const ctx: ItemParseContext = {
  profile: buildSelectorProfile(),
  referenceMs: new Date(2024, 0, 17, 12, 0).getTime(),
  dateOrder: 'MDY',
  dateContext: null,
};

function parseMessage(fixture: FixtureMessage, context: Partial<ItemParseContext> = {}): RawMessage {
  const parsed = parseItem(itemElement(fixture), { ...ctx, ...context });
  if (parsed.type !== 'message') throw new Error(`expected a message, got ${parsed.type}`);
  return parsed.message;
}

describe('parseItem', () => {
  it('extracts id, author, exact timestamp and a multi-paragraph body', () => {
    const message = parseMessage({
      id: '1705314612345',
      author: 'Alice Smith',
      time: '2024-01-15T10:30:12.345Z',
      paragraphs: ['First paragraph.', 'Second paragraph with more words.', 'Third.'],
    });
    expect(message.messageId).toBe('1705314612345');
    expect(message.authorName).toBe('Alice Smith');
    expect(message.isSelf).toBe(false);
    expect(message.kind).toBe('message');
    expect(message.timestampSource).toBe('datetime-attr');
    expect(message.timestampMs).toBe(Date.UTC(2024, 0, 15, 10, 30, 12, 345));
    expect(message.content.text).toBe('First paragraph.\n\nSecond paragraph with more words.\n\nThird.');
    expect(message.content.text).not.toContain('Alice Smith');
    expect(message.content.text).not.toContain('👍');
  });

  it('recognises your own messages', () => {
    const message = parseMessage({ id: '1705314612346', self: true, time: '2024-01-15T10:31:00Z', paragraphs: ['Mine'] });
    expect(message.isSelf).toBe(true);
    expect(message.authorName).toBeNull();
  });

  it('parses system messages', () => {
    const message = parseMessage({ system: 'Alice added Bob to the chat.', id: '1705314612400', time: '2024-01-15T10:40:00Z' });
    expect(message.kind).toBe('system');
    expect(message.content.text).toBe('Alice added Bob to the chat.');
    expect(message.messageId).toBe('1705314612400');
  });

  it('reports date dividers separately', () => {
    expect(parseItem(itemElement({ divider: 'Yesterday' }), ctx)).toEqual({ type: 'divider', text: 'Yesterday' });
  });

  it('skips list items that are not messages', () => {
    const element = document.createElement('div');
    element.setAttribute('data-tid', 'chat-pane-item');
    element.innerHTML = '<div class="unread-line">New messages</div>';
    expect(parseItem(element, ctx).type).toBe('skip');
  });

  it('extracts a quoted reply with the referenced id, without leaking it into the message', () => {
    const message = parseMessage({
      id: '1705314699999',
      author: 'Bob',
      time: '2024-01-15T11:00:00Z',
      reply: { id: '1705314612345', author: 'Alice Smith', preview: 'First paragraph.' },
      paragraphs: ['Agreed!'],
    });
    expect(message.messageId).toBe('1705314699999');
    expect(message.content.text).toBe('Agreed!');
    expect(message.replyTo).toEqual({
      messageId: '1705314612345',
      senderName: 'Alice Smith',
      timestampRaw: null,
      preview: 'First paragraph.',
      resolvedKey: null,
      resolution: 'message-id',
    });
  });

  it('keeps an unresolved reply when the quote has no id', () => {
    const message = parseMessage({ id: '1705314700000', author: 'Bob', reply: { author: 'Alice Smith', preview: 'Lunch at noon?' }, paragraphs: ['Yes'] });
    expect(message.replyTo?.messageId).toBeNull();
    expect(message.replyTo?.resolution).toBe('unresolved');
    expect(message.replyTo?.preview).toBe('Lunch at noon?');
  });

  it('extracts file and image attachments separately from the text', () => {
    const message = parseMessage({
      id: '1705314700001',
      author: 'Carol',
      paragraphs: ['Here are the files'],
      attachments: [
        { name: 'Budget 2024.xlsx', url: 'https://contoso.sharepoint.com/budget.xlsx' },
        { name: 'notes.docx' },
        { name: 'whiteboard.png', kind: 'image', url: 'https://example.invalid/wb.png' },
      ],
    });
    expect(message.content.text).toBe('Here are the files');
    expect(message.attachments).toEqual([
      { kind: 'file', name: 'Budget 2024.xlsx', url: 'https://contoso.sharepoint.com/budget.xlsx' },
      { kind: 'file', name: 'notes.docx', url: null },
      { kind: 'image', name: 'whiteboard.png', url: 'https://example.invalid/wb.png' },
    ]);
  });

  it('does not take the profile picture in a forwarded message for a picture in the message', () => {
    // Shape of a forwarded message in new Teams: a header with the original sender's picture,
    // name and a link to the original, then the forwarded content (here one pasted image).
    const avatar = 'https://teams.example.invalid/api/mt/apac/beta/users/u1/profilepicturev2/8:orgid:u2?size=HR64x64';
    const message = parseMessage({
      id: '1705314700010',
      author: 'Carol',
      html:
        `<div><div><span class="fui-Avatar"><img class="fui-Avatar__image" src="${avatar}"></span><span>Dan Original</span>` +
        '<a href="https://teams.example.invalid/l/message/19:abc@unq.gbl.spaces/1705314600000"><span>1/15/2024 10:00 AM</span></a></div>' +
        '<div><p><span itemtype="http://schema.skype.com/AMSImage"><img alt="image" src="blob:https://teams.example.invalid/1b2c"></span></p></div></div>',
    });
    expect(message.attachments).toEqual([{ kind: 'image', name: 'image', url: null }]);
    expect(message.imageElements.map((element) => element?.getAttribute('alt'))).toEqual(['image']);
  });

  it('handles an attachment-only message', () => {
    const message = parseMessage({ id: '1705314700002', author: 'Carol', attachments: [{ name: 'slides.pptx' }] });
    expect(message.content.text).toBe('');
    expect(message.attachments).toHaveLength(1);
  });

  it('reads the reactions under a message: emoji, count and whether you chose it', () => {
    const message = parseMessage({
      id: '1705314700010',
      author: 'Alice Andersen',
      paragraphs: ['Lunch at noon?'],
      reactionsHtml:
        '<div data-tid="diverse-reaction-summary">' +
        '<button data-tid="diverse-reaction-pill-button" aria-pressed="true"><span>👍</span><span>3</span></button>' +
        '<button data-tid="diverse-reaction-pill-button" aria-pressed="false"><span>❤️</span><span>1</span></button>' +
        '<button data-tid="diverse-reaction-pill-button"><span>👍🏽</span> 2</button>' +
        '<button data-tid="diverse-reaction-pill-button"><img alt="😂" src="https://example.invalid/laugh.png"><span>4</span></button>' +
        '</div>',
    });
    expect(message.reactions).toEqual([
      { emoji: '👍', count: 3, mine: true },
      { emoji: '❤️', count: 1, mine: false },
      { emoji: '👍🏽', count: 2, mine: false },
      { emoji: '😂', count: 4, mine: false },
    ]);
    expect(message.content.text).toBe('Lunch at noon?');
    // The emoji picture of a reaction is not an attachment.
    expect(message.attachments).toEqual([]);
  });

  it('reads a reaction known only by name, and skips the add-reaction button and repeats', () => {
    const message = parseMessage({
      id: '1705314700011',
      author: 'Bob Brown',
      paragraphs: ['Done'],
      reactionsHtml:
        '<button data-tid="diverse-reaction-pill-button" aria-label="Like reaction, 5 people"><span>5</span></button>' +
        '<button data-tid="diverse-reaction-pill-button" aria-label="Add reaction"><span>+</span></button>' +
        '<button data-tid="diverse-reaction-pill-button"><span>🎉</span></button>' +
        '<button data-tid="diverse-reaction-pill-button"><span>🎉</span><span>9</span></button>',
    });
    expect(message.reactions).toEqual([
      { emoji: 'Like', count: 5, mine: false },
      { emoji: '🎉', count: 1, mine: false },
    ]);
  });

  it('leaves out reactions shown inside a quoted reply, and has none when none are shown', () => {
    const quoted = parseMessage({
      id: '1705314700012',
      author: 'Bob Brown',
      html: '<div data-tid="quoted-reply-card" itemid="1705314700000"><strong>Alice Andersen</strong><p>Original</p><button data-tid="diverse-reaction-pill-button">👍 2</button></div><p>Reply</p>',
    });
    expect(quoted.reactions).toEqual([]);
    expect(parseMessage({ id: '1705314700013', author: 'Bob Brown', paragraphs: ['Plain'] }).reactions).toEqual([]);
  });

  it('detects edited and deleted messages', () => {
    expect(parseMessage({ id: '1705314700003', author: 'Dan', edited: true, paragraphs: ['Fixed typo'] }).isEdited).toBe(true);
    expect(parseMessage({ id: '1705314700004', author: 'Dan', paragraphs: ['Not edited'] }).isEdited).toBe(false);
    const deleted = parseMessage({ id: '1705314700005', author: 'Dan', paragraphs: ['This message has been deleted.'] });
    expect(deleted.isDeleted).toBe(true);
  });

  it('tolerates missing id, author and timestamp', () => {
    const message = parseMessage({ id: null, author: null, time: null, paragraphs: ['Orphan message'] });
    expect(message.messageId).toBeNull();
    expect(message.authorName).toBeNull();
    expect(message.timestampMs).toBeNull();
    expect(message.timestampSource).toBe('none');
    expect(message.content.text).toBe('Orphan message');
  });

  it('falls back to the title attribute and to the visible label for times', () => {
    const fromTitle = parseMessage({ id: '1705314700006', author: 'Eve', timeWithoutDatetime: true, time: 'x', timeTitle: 'January 15, 2024 10:30 AM', timeText: '10:30 AM', paragraphs: ['t'] });
    expect(fromTitle.timestampSource).toBe('title-attr');
    expect(fromTitle.timestampMs).toBe(new Date(2024, 0, 15, 10, 30).getTime());

    const fromText = parseMessage(
      { id: '1705314700007', author: 'Eve', timeWithoutDatetime: true, time: 'x', timeText: '9:05 PM', paragraphs: ['t'] },
      { dateContext: 'Yesterday' },
    );
    expect(fromText.timestampSource).toBe('visible-text');
    expect(fromText.timestampMs).toBe(new Date(2024, 0, 16, 21, 5).getTime());

    const unparseable = parseMessage({ id: '1705314700008', author: 'Eve', timeWithoutDatetime: true, time: 'x', timeText: 'a while ago', paragraphs: ['t'] });
    expect(unparseable.timestampSource).toBe('none');
    expect(unparseable.timestampRaw).toBe('a while ago');
  });
});
