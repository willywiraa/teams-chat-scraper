import { afterEach, describe, expect, it } from 'vitest';
import { findIdentifiers, probeIdentifiers, redactIdentifiers } from '../../src/extractor/id-probe';
import { findMessageList } from '../../src/extractor/page-parser';
import { buildSelectorProfile } from '../../src/extractor/selectors';
import {
  GROUP_THREAD,
  HEADER_WITH_IDS,
  NEW_TEAMS_URL,
  ONE_ON_ONE_THREAD,
  OTHER_PERSON,
  PAGE_SECRETS,
  SELF_PERSON,
  renderNewTeamsPage,
} from '../helpers/new-teams-page';

const profile = buildSelectorProfile();

afterEach(() => {
  document.body.innerHTML = '';
});

function probe(maxElements?: number) {
  return probeIdentifiers(document, { profile, list: findMessageList(document, profile), href: NEW_TEAMS_URL, maxElements });
}

describe('findIdentifiers', () => {
  it('recognises thread, person, bot, e-mail and GUID shapes, also when URL-encoded', () => {
    const value = [
      `chat-header-${encodeURIComponent(ONE_ON_ONE_THREAD)}`,
      `8%253Aorgid%253A${OTHER_PERSON}`,
      'alice.andersen@contoso.example',
      GROUP_THREAD,
      '48:notes',
      `28:${SELF_PERSON}`,
      `x-${SELF_PERSON}`,
    ].join(' ');
    const { matches, redacted } = findIdentifiers(value);

    expect(matches.map((match) => match.kind).sort()).toEqual(['bot', 'email', 'guid', 'person:orgid', 'thread:notes', 'thread:unq', 'thread:v2']);
    expect(redacted).toBe('chat-header-<thread:unq> <person:orgid> <email> <thread:v2> <thread:notes> <bot> x-<guid>');
  });

  it('reads the GUIDs inside a 1:1 thread id as part of the thread id, not separately', () => {
    expect(findIdentifiers(ONE_ON_ONE_THREAD).matches.map((match) => match.kind)).toEqual(['thread:unq']);
  });

  it('gives an identifier the same value whether it is encoded or not', () => {
    const plain = findIdentifiers(`8:orgid:${OTHER_PERSON}`).matches[0];
    const encoded = findIdentifiers(encodeURIComponent(`8:orgid:${OTHER_PERSON.toUpperCase()}`)).matches[0];
    expect(encoded?.value).toBe(plain?.value);
  });
});

describe('redactIdentifiers', () => {
  it('replaces identifiers with their kind and long numbers with <n>', () => {
    const url = `/l/chat/${encodeURIComponent(GROUP_THREAD)}/0?tenantId=${SELF_PERSON}&messageId=1705314600000`;
    expect(redactIdentifiers(url)).toBe('/l/chat/<thread:v2>/0?tenantId=<guid>&messageId=<n>');
  });
});

describe('probeIdentifiers', () => {
  it('shows where identifiers are on the page, and which places share one, without revealing them', () => {
    renderNewTeamsPage({ header: HEADER_WITH_IDS });
    const result = probe();

    expect(result.regions).toEqual({
      selectedEntry: 'div[data-tid="chat-list-item"][role="treeitem"]',
      chatHeader: 'div[data-tid="title-bar"]',
      messageList: 'div[data-tid="message-pane-list-runway"]',
    });
    expect(result.url).toEqual({ kinds: [], values: [] });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        { region: 'chat-header', element: 'div#chat-header-<thread:unq>', attribute: 'id', kind: 'thread:unq', count: 1, values: ['T1'], distinct: 1 },
        { region: 'chat-header', element: 'span#chat-topic-person-<person:orgid>', attribute: 'id', kind: 'person:orgid', count: 1, values: ['P1'], distinct: 1 },
        { region: 'chat-header', element: 'span#chat-topic-person-<person:orgid>', attribute: 'title', kind: 'email', count: 1, values: ['E1'], distinct: 1 },
        { region: 'message-list', element: 'img[data-tid="message-avatar"]', attribute: 'src', kind: 'person:orgid', count: 1, values: ['P1'], distinct: 1 },
        { region: 'elsewhere', element: 'div[data-tid="chat-list-item"][role="treeitem"]', attribute: 'data-item-id', kind: 'thread:v2', count: 1, values: ['T2'], distinct: 1 },
      ]),
    );
    expect(result.findings).toHaveLength(5);
    expect(result.distinct.thread).toEqual({ 'chat-header': 1, elsewhere: 1 });
    expect(result.distinct.person).toEqual({ 'chat-header': 1, 'message-list': 1 });
    expect(result.distinct.guid).toEqual({});
    expect(result.highlighted).toEqual([
      { element: 'div[data-tid="chat-list-item"][role="treeitem"]', region: 'selected-entry', selectorIndex: 0, identifiers: [] },
    ]);

    const json = JSON.stringify(result);
    for (const secret of PAGE_SECRETS) expect(json).not.toContain(secret);
  });

  it('reports a highlighted chat-list entry that the selectors miss, with the identifiers it carries', () => {
    renderNewTeamsPage({ entry: `<div role="option" aria-current="true" data-item-id="${ONE_ON_ONE_THREAD}"><span>Alice Andersen</span></div>` });
    const result = probe();

    expect(result.regions.selectedEntry).toBeNull();
    expect(result.highlighted).toEqual([
      { element: 'div[role="option"]', region: 'elsewhere', selectorIndex: null, identifiers: [{ where: 'self', attribute: 'data-item-id', kind: 'thread:unq', value: 'T1' }] },
    ]);
  });

  it('finds identifiers inside or around a highlighted entry', () => {
    renderNewTeamsPage({
      entry: `<div data-item-key="${ONE_ON_ONE_THREAD}"><div role="treeitem" aria-selected="true"><img src="https://teams.microsoft.com/api/mt/beta/users/8:orgid:${OTHER_PERSON}/profilepicturev2"></div></div>`,
    });
    const [entry] = probe().highlighted;

    expect(entry?.identifiers).toEqual([
      { where: 'inside', attribute: 'src', kind: 'person:orgid', value: 'P1' },
      { where: 'parent 1', attribute: 'data-item-key', kind: 'thread:unq', value: 'T1' },
    ]);
  });

  it('lists the test ids in each region with identifiers and odd values removed', () => {
    renderNewTeamsPage({ header: `<div data-tid="title-bar"><h2 data-tid="Alice Andersen heading">Alice Andersen</h2><div data-tid="header-avatar-8:orgid:${OTHER_PERSON}"></div></div>` });
    const result = probe();

    expect(result.dataTids.chatHeader).toEqual([
      { value: '<other>', count: 1 },
      { value: 'header-avatar-<person:orgid>', count: 1 },
      { value: 'title-bar', count: 1 },
    ]);
    expect(result.dataTids.messageList).toEqual(expect.arrayContaining([{ value: 'chat-pane-message', count: 1 }, { value: 'message-avatar', count: 1 }]));
    expect(result.dataTids.selectedEntry).toEqual([{ value: 'chat-list-item', count: 1 }]);
    expect(JSON.stringify(result)).not.toContain(OTHER_PERSON);
  });

  it('stops at the element limit on very large pages', () => {
    renderNewTeamsPage();
    expect(probe(5)).toMatchObject({ scannedElements: 5, truncated: true });
    expect(probe()).toMatchObject({ truncated: false });
  });
});
