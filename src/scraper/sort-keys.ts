/**
 * Assigns a timeline position to every message of one extraction pass.
 *
 * Messages with a Teams id or timestamp already carry a reliable sort key. Others are
 * interpolated between their rendered neighbours, or ordered by observation when nothing
 * reliable is known. Assignments are remembered for the session so a message keeps the
 * same position when it is seen again in a later pass.
 */
import { isReliableSortSource, type ExtractedMessage, type SortKeySource } from '../shared/types';

export interface AssignedSortKey {
  sortKey: number;
  source: SortKeySource;
}

/** Offset used to place a message immediately next to a known neighbour (ms). */
const NEIGHBOUR_OFFSET = 0.01;
/** Spacing used when nothing at all is known about message times (ms). */
const OBSERVED_SPACING = 1000;

export function isReliable(message: Pick<ExtractedMessage, 'sortKeySource'>): boolean {
  return isReliableSortSource(message.sortKeySource);
}

/** Mutates `messages` (in DOM order, oldest first) so every one has a sort key. */
export function assignSortKeys(messages: ExtractedMessage[], session: Map<string, AssignedSortKey>, nowMs: number): void {
  for (const message of messages) {
    if (message.sortKey === null) {
      const previous = session.get(message.key);
      if (previous) {
        message.sortKey = previous.sortKey;
        message.sortKeySource = previous.source;
      }
    }
  }

  const known = messages.map((message, index) => (message.sortKey !== null ? index : -1)).filter((index) => index >= 0);
  if (known.length === 0) {
    const count = messages.length;
    messages.forEach((message, index) => {
      message.sortKey = nowMs - (count - 1 - index) * OBSERVED_SPACING;
      message.sortKeySource = 'observed-order';
    });
  } else {
    const keys = messages.map((message) => message.sortKey);
    const sources = messages.map((message) => message.sortKeySource);
    let cursor = 0;
    messages.forEach((message, index) => {
      if (keys[index] !== null) return;
      while (cursor < known.length && (known[cursor] as number) < index) cursor++;
      const prevIndex = cursor > 0 ? known[cursor - 1] : undefined;
      const nextIndex = cursor < known.length ? known[cursor] : undefined;
      const prevKey = prevIndex !== undefined ? (keys[prevIndex] as number) : null;
      const nextKey = nextIndex !== undefined ? (keys[nextIndex] as number) : null;
      let value: number;
      if (prevKey !== null && nextKey !== null && prevIndex !== undefined && nextIndex !== undefined) {
        value = nextKey > prevKey
          ? prevKey + ((nextKey - prevKey) * (index - prevIndex)) / (nextIndex - prevIndex)
          : prevKey + NEIGHBOUR_OFFSET * (index - prevIndex);
      } else if (prevKey !== null && prevIndex !== undefined) {
        value = prevKey + NEIGHBOUR_OFFSET * (index - prevIndex);
      } else {
        value = (nextKey as number) - NEIGHBOUR_OFFSET * ((nextIndex as number) - index);
      }
      const neighbourSources = [prevIndex, nextIndex].filter((i): i is number => i !== undefined).map((i) => sources[i]);
      message.sortKey = value;
      message.sortKeySource = neighbourSources.includes('observed-order') ? 'observed-order' : 'interpolated';
    });
  }

  for (const message of messages) {
    if (message.sortKey !== null && message.sortKeySource !== null && !session.has(message.key)) {
      session.set(message.key, { sortKey: message.sortKey, source: message.sortKeySource });
    }
  }
}
