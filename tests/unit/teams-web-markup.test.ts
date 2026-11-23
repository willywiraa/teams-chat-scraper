/**
 * Reads Teams Web as it was in November 2026, a 1:1 chat and a group chat (see
 * tests/helpers/teams-web-page.ts): the chat id in the header, and each part of a message found
 * on screen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { detectConversation } from '../../src/extractor/conversation';
import { parseRenderedConversation } from '../../src/extractor/page-parser';
import { buildSelectorProfile } from '../../src/extractor/selectors';
import type { ConversationIdentity } from '../../src/shared/types';
import {
  GROUP_THREAD,
  mention,
  ONE_ON_ONE_THREAD,
  OTHER_NAME,
  quotedReply,
  renderTeamsWebPage,
  SELF_NAME,
  sentPicture,
  teamsWebDivider,
  teamsWebHeader,
  teamsWebMessage,
} from '../helpers/teams-web-page';

const profile = buildSelectorProfile();
const URL = 'https://teams.cloud.microsoft/';
const REFERENCE = Date.UTC(2024, 0, 17, 12);

afterEach(() => {
  document.body.innerHTML = '';
});

function detect(): ConversationIdentity {
  const conversation = detectConversation(document, URL, profile);
  if (!conversation) throw new Error('no conversation detected');
  return conversation;
}

function parse() {
  return parseRenderedConversation(document, { profile, conversation: detect(), selfDisplayName: null, referenceMs: REFERENCE, dateOrder: 'DMY' });
}

/** The 1:1 chat: a message with your reaction, a day divider, a picture, and a reply of yours. */
function renderOneOnOne(): void {
  renderTeamsWebPage(teamsWebHeader(ONE_ON_ONE_THREAD, OTHER_NAME), [
    teamsWebMessage({
      id: '1705314600000',
      time: '2024-01-15T10:30:00.000Z',
      author: OTHER_NAME,
      body: '<p>Lunch at noon?</p>',
      reactions: [{ emoji: '👍🏼', itemId: 'yes-tone2', messageId: '1705314600000', text: '1 Like reaction.', pressed: true }],
    }),
    teamsWebDivider('Monday'),
    teamsWebMessage({ id: '1705400000000', time: '2024-01-16T10:13:20.000Z', author: OTHER_NAME, body: sentPicture('menu', ONE_ON_ONE_THREAD) }),
    teamsWebMessage({
      id: '1705400060000',
      time: '2024-01-16T10:14:20.000Z',
      author: SELF_NAME,
      self: true,
      body: quotedReply(OTHER_NAME, '15/01/2024 10:30', 'Lunch at noon?') + '<p>Yes, see you there</p>',
    }),
  ]);
}

/** The group chat: an edited reply of yours quoting two messages, with a picture and a reaction. */
function renderGroup(): void {
  renderTeamsWebPage(teamsWebHeader(GROUP_THREAD, 'Design review'), [
    teamsWebMessage({ id: '1705314600000', time: '2024-01-15T10:30:00.000Z', author: OTHER_NAME, body: `<p>${mention(SELF_NAME)} can you check the draft?</p>` }),
    teamsWebMessage({ id: '1705314660000', time: '2024-01-15T10:31:00.000Z', author: OTHER_NAME, body: '<p>And the cover page</p>' }),
    teamsWebMessage({
      id: '1705400000000',
      time: '2024-01-16T10:13:20.000Z',
      author: SELF_NAME,
      self: true,
      edited: true,
      body:
        quotedReply(OTHER_NAME, '15/01/2024 10:30', 'can you check the draft?') +
        '<p>OK</p>' +
        quotedReply(OTHER_NAME, '15/01/2024 10:31', 'And the cover page') +
        '<p>Both are done</p>' +
        sentPicture('cover', GROUP_THREAD),
      reactions: [{ emoji: '👍', itemId: 'yes', messageId: '1705400000000', text: '1 Like reaction.', pressed: false }],
    }),
  ]);
}

describe('the open chat', () => {
  it('is identified by the chat id in the chat header', () => {
    renderOneOnOne();
    expect(detect()).toMatchObject({ conversationKey: `teams:${ONE_ON_ONE_THREAD}`, threadId: ONE_ON_ONE_THREAD, title: OTHER_NAME, type: 'one-on-one', keySource: 'dom', typeSource: 'thread-id' });
    renderGroup();
    expect(detect()).toMatchObject({ conversationKey: `teams:${GROUP_THREAD}`, type: 'group', title: 'Design review' });
  });

  it('is identified by the header’s Chat tab when the header block has no id', () => {
    renderTeamsWebPage(teamsWebHeader(GROUP_THREAD, 'Design review', { headerId: false }), [teamsWebDivider('Monday')]);
    expect(detect()).toMatchObject({ threadId: GROUP_THREAD, type: 'group' });
  });
});

describe('messages', () => {
  it('reads each item once, not the avatar block that Teams also marks as an item', () => {
    renderOneOnOne();
    const result = parse();
    expect(document.querySelectorAll('[data-tid="chat-pane-item"]')).toHaveLength(6);
    expect(result).toMatchObject({ itemCount: 4, dividers: 1, skipped: 0 });
    expect(result.messages.map((m) => [m.messageId, m.sender.name, m.sender.isSelf, m.timestampSource])).toEqual([
      ['1705314600000', OTHER_NAME, false, 'datetime-attr'],
      ['1705400000000', OTHER_NAME, false, 'datetime-attr'],
      ['1705400060000', SELF_NAME, true, 'datetime-attr'],
    ]);
    expect(result.messages[0]?.text).toBe('Lunch at noon?');
    expect(result.messages[0]?.key).toBe(`teams:${ONE_ON_ONE_THREAD}#1705314600000`);
  });

  it('reads a sent picture as one picture, and nothing of the avatar', () => {
    renderOneOnOne();
    const picture = parse().messages[1];
    expect(picture?.text).toBe('');
    expect(picture?.attachments).toEqual([{ kind: 'image', name: 'image', url: null }]);
  });

  it('reads the sender, time and words of quoted messages, and keeps them out of the text', () => {
    renderOneOnOne();
    expect(parse().messages[2]).toMatchObject({
      text: 'Yes, see you there',
      replyTo: { messageId: null, senderName: OTHER_NAME, timestampRaw: '15/01/2024 10:30', preview: 'Lunch at noon?', resolution: 'unresolved' },
    });

    renderGroup();
    const reply = parse().messages[2];
    // Teams quotes two messages here; the first is recorded, and neither one's words are in the text.
    expect(reply?.text).toBe('OK\n\nBoth are done');
    expect(reply?.replyTo).toMatchObject({ senderName: OTHER_NAME, preview: 'can you check the draft?' });
    expect(reply?.attachments.map((attachment) => attachment.kind)).toEqual(['image']);
  });

  it('reads reactions: the emoji from its picture, the count from the pill’s words, and whether it is yours', () => {
    renderOneOnOne();
    expect(parse().messages[0]?.reactions).toEqual([{ emoji: '👍🏼', count: 1, mine: true }]);
    renderGroup();
    expect(parse().messages[2]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });

  it('marks edited messages and reads mentions', () => {
    renderGroup();
    const [first, second, mine] = parse().messages;
    expect(mine?.isEdited).toBe(true);
    expect(mine?.text).not.toContain('Edited');
    expect([first?.isEdited, second?.isEdited]).toEqual([false, false]);
    expect(first?.mentions).toEqual([{ name: SELF_NAME, id: null }]);
    expect(first?.text).toBe(`${SELF_NAME} can you check the draft?`);
  });
});
