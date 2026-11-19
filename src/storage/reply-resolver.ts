/**
 * Links quoted replies to the archived message they quote when Teams did not expose the
 * quoted message id: same sender (when known), earlier in the timeline, text starting with
 * the quoted preview. The closest earlier match wins.
 */
import type { ReplyReference } from '../shared/types';

export interface ReplyCandidate {
  key: string;
  senderName: string | null;
  sortKey: number;
  /** normalizeForMatch(text), possibly truncated. */
  textNorm: string;
}

export const CANDIDATE_TEXT_LIMIT = 600;

export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(…|\.\.\.)$/, '')
    .trim();
}

/** `candidates` must be sorted by sortKey ascending. */
export function findReplyTarget(
  reply: ReplyReference,
  replyKey: string,
  replySortKey: number,
  candidates: readonly ReplyCandidate[],
): string | null {
  const preview = normalizeForMatch(reply.preview ?? '');
  if (preview.length < 2) return null;
  const sender = reply.senderName ? normalizeForMatch(reply.senderName) : null;
  let best: ReplyCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.sortKey >= replySortKey) break;
    if (candidate.key === replyKey || !candidate.textNorm) continue;
    if (sender && candidate.senderName && normalizeForMatch(candidate.senderName) !== sender) continue;
    const matches =
      candidate.textNorm === preview ||
      candidate.textNorm.startsWith(preview) ||
      (candidate.textNorm.length >= 10 && preview.startsWith(candidate.textNorm));
    if (matches) best = candidate;
  }
  return best?.key ?? null;
}
