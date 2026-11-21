/**
 * The message view reads a chat in pages: all its message keys in timeline order, then the
 * messages of one page by key. Other chats' messages never appear, and keys that are no longer
 * archived are skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ArchiveRepository } from '../../src/storage/repository';
import { earlierPage } from '../../src/ui/view-models';
import { exportFixture } from '../helpers/export-fixture';
import { openTestRepository } from '../helpers/fixtures';

const repositories: ArchiveRepository[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

async function seeded(): Promise<{ repository: ArchiveRepository; alpha: Awaited<ReturnType<typeof exportFixture>>; design: Awaited<ReturnType<typeof exportFixture>> }> {
  const repository = await openTestRepository();
  repositories.push(repository);
  const alpha = await exportFixture();
  const design = await exportFixture('title:design review', 'Design review', 10);
  await repository.importConversation(alpha.record, alpha.messages);
  await repository.importConversation(design.record, design.messages);
  return { repository, alpha, design };
}

describe('message pages', () => {
  it('lists one chat’s message keys in timeline order', async () => {
    const { repository, alpha, design } = await seeded();
    const keys = await repository.messageKeys(alpha.record.conversationKey);
    expect(keys).toEqual((await repository.getMessages(alpha.record.conversationKey)).map((message) => message.key));
    expect(keys).toHaveLength(alpha.messages.length);
    expect(await repository.messageKeys(design.record.conversationKey)).toHaveLength(design.messages.length);
    expect(await repository.messageKeys('teams:19:nothing-here')).toEqual([]);
  });

  it('reads a page of messages by key, in the order asked, skipping keys no longer archived', async () => {
    const { repository, alpha } = await seeded();
    const keys = await repository.messageKeys(alpha.record.conversationKey);
    const newest = earlierPage(keys, keys.length, 2);
    const page = await repository.getMessagesByKey(newest.keys);
    expect(page.map((message) => message.key)).toEqual(keys.slice(-2));
    const earlier = await repository.getMessagesByKey(earlierPage(keys, newest.from, 2).keys);
    expect(earlier.map((message) => message.key)).toEqual(keys.slice(-4, -2));
    expect(await repository.getMessagesByKey([keys[0] as string, 'gone#1', keys[1] as string])).toHaveLength(2);
    expect(await repository.getMessagesByKey([])).toEqual([]);
  });
});
