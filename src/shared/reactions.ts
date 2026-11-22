/**
 * Reactions under a message: checking records read from an import, comparing two lists, and
 * the one line that every view and export shows ("👍 2 · ❤️ 1 (yours: 👍)").
 */
import type { Reaction } from './types';

/** Longer emoji names are cut; an emoji character is at most a few code units. */
export const MAX_REACTION_NAME = 40;
export const MAX_REACTIONS = 50;

/**
 * Reactions as stored or imported, made whole: entries without an emoji or with an invalid
 * count are dropped, an emoji is kept once (its first entry), and `mine` defaults to false.
 */
export function normalizeReactions(value: unknown): Reaction[] {
  if (!Array.isArray(value)) return [];
  const reactions: Reaction[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { emoji, count, mine } = entry as Partial<Record<keyof Reaction, unknown>>;
    if (typeof emoji !== 'string' || !emoji.trim()) continue;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) continue;
    const name = emoji.trim().slice(0, MAX_REACTION_NAME);
    if (reactions.some((reaction) => reaction.emoji === name)) continue;
    reactions.push({ emoji: name, count: Math.floor(count), mine: mine === true });
    if (reactions.length >= MAX_REACTIONS) break;
  }
  return reactions;
}

export function sameReactions(a: readonly Reaction[] | undefined, b: readonly Reaction[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((reaction, i) => {
    const other = right[i] as Reaction;
    return reaction.emoji === other.emoji && reaction.count === other.count && reaction.mine === other.mine;
  });
}

/** "👍 2 · ❤️ 1 (yours: 👍)", or '' when there are none. */
export function reactionsText(reactions: readonly Reaction[] | undefined): string {
  const list = reactions ?? [];
  if (list.length === 0) return '';
  const mine = list.filter((reaction) => reaction.mine).map((reaction) => reaction.emoji);
  return `${list.map((reaction) => `${reaction.emoji} ${reaction.count}`).join(' · ')}${mine.length > 0 ? ` (yours: ${mine.join(' ')})` : ''}`;
}
