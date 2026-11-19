import { afterEach, describe, expect, it } from 'vitest';
import { conversationTypeFromThreadId, detectConversation, extractThreadId } from '../../src/extractor/conversation';
import { buildSelectorProfile } from '../../src/extractor/selectors';
import { shellHtml } from '../helpers/teams-dom';

const profile = buildSelectorProfile();
const PLAIN_URL = 'https://teams.microsoft.com/v2/';

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('thread ids', () => {
  it('finds thread ids in attribute values and encoded URLs', () => {
    expect(extractThreadId('chat-list-item_19:abc-DEF_123@thread.v2')).toBe('19:abc-DEF_123@thread.v2');
    expect(extractThreadId('https://teams.microsoft.com/l/chat/19%3Aaaaa_bbbb%40unq.gbl.spaces/0?tenantId=x')).toBe('19:aaaa_bbbb@unq.gbl.spaces');
    expect(extractThreadId(PLAIN_URL)).toBeNull();
    expect(extractThreadId('%E0%A4%A 19:x@thread.v2')).toBe('19:x@thread.v2'); // malformed escapes are tolerated
    expect(extractThreadId(null)).toBeNull();
  });

  it('classifies conversations by their thread id', () => {
    expect(conversationTypeFromThreadId('19:a_b@unq.gbl.spaces')).toBe('one-on-one');
    expect(conversationTypeFromThreadId('48:notes')).toBe('one-on-one');
    expect(conversationTypeFromThreadId('19:abc@thread.v2')).toBe('group');
    expect(conversationTypeFromThreadId('19:meeting_NjA2ZTc@thread.v2')).toBe('meeting');
    expect(conversationTypeFromThreadId('19:abc@thread.tacv2')).toBe('channel');
  });
});

describe('detectConversation', () => {
  it('prefers the thread id of the selected chat over a stale URL', () => {
    document.body.innerHTML = shellHtml({ threadId: '19:aaaa1111@thread.v2', title: 'Project Alpha' });
    expect(detectConversation(document, 'https://teams.microsoft.com/l/chat/19%3Astale0000%40thread.v2/0', profile)).toEqual({
      conversationKey: 'teams:19:aaaa1111@thread.v2',
      threadId: '19:aaaa1111@thread.v2',
      title: 'Project Alpha',
      type: 'group',
      keySource: 'dom',
      typeSource: 'thread-id',
    });
  });

  it('falls back to the URL, then to the chat title', () => {
    document.body.innerHTML = shellHtml({ threadId: '19:unused@thread.v2', threadIdInList: false, title: 'Alice Andersen' });
    expect(detectConversation(document, 'https://teams.microsoft.com/l/chat/19%3Aaaaa1111_bbbb2222%40unq.gbl.spaces/0', profile)).toMatchObject({
      conversationKey: 'teams:19:aaaa1111_bbbb2222@unq.gbl.spaces',
      type: 'one-on-one',
      keySource: 'url',
    });
    expect(detectConversation(document, PLAIN_URL, profile)).toEqual({
      conversationKey: 'title:alice andersen',
      threadId: null,
      title: 'Alice Andersen',
      type: 'unknown',
      keySource: 'title',
      typeSource: 'unknown',
    });
  });

  it('uses the browser tab title when the page shows no chat title', () => {
    document.body.innerHTML = '<div role="tree"><div role="treeitem" data-tid="chat-list-item" aria-selected="true"></div></div>';
    document.title = '(3) Chat | Weekly sync | Microsoft Teams';
    expect(detectConversation(document, PLAIN_URL, profile)?.conversationKey).toBe('title:weekly sync');
  });

  it('returns null when nothing identifies a conversation', () => {
    document.body.innerHTML = '<div data-tid="app-shell"><p>Activity</p></div>';
    document.title = 'Microsoft Teams';
    expect(detectConversation(document, PLAIN_URL, profile)).toBeNull();
  });
});
