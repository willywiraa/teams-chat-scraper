/**
 * Coverage bookkeeping: which stretches of a conversation's timeline (in sort-key space)
 * have been captured without gaps. Used for incremental updates and for resuming.
 */
import type { CoverageRange } from '../shared/types';

export function isValidRange(range: CoverageRange | null | undefined): range is CoverageRange {
  return (
    !!range &&
    Number.isFinite(range.oldest) &&
    Number.isFinite(range.newest) &&
    range.oldest <= range.newest &&
    typeof range.reachedBeginning === 'boolean'
  );
}

/**
 * Whether two overlapping ranges joined reach the beginning: only if the one that goes further
 * back does. A message older than a range marked as reaching the beginning shows that the mark
 * was wrong (a run that took Teams' slow loading for the beginning), so it is dropped.
 */
function joinedBeginning(a: CoverageRange, b: CoverageRange): boolean {
  if (a.oldest === b.oldest) return a.reachedBeginning || b.reachedBeginning;
  return a.oldest < b.oldest ? a.reachedBeginning : b.reachedBeginning;
}

/** Adds a range, merging every range it overlaps or touches. Result is sorted oldest first. */
export function mergeCoverage(ranges: readonly CoverageRange[], addition: CoverageRange): CoverageRange[] {
  if (!isValidRange(addition)) return ranges.filter(isValidRange).map((range) => ({ ...range }));
  let merged: CoverageRange = { ...addition };
  const untouched: CoverageRange[] = [];
  for (const range of ranges) {
    if (!isValidRange(range)) continue;
    if (range.oldest <= merged.newest && range.newest >= merged.oldest) {
      merged = {
        oldest: Math.min(range.oldest, merged.oldest),
        newest: Math.max(range.newest, merged.newest),
        reachedBeginning: joinedBeginning(range, merged),
      };
    } else {
      untouched.push({ ...range });
    }
  }
  return normalizeCoverage([...untouched, merged]);
}

export function mergeAllCoverage(ranges: readonly CoverageRange[], additions: readonly CoverageRange[]): CoverageRange[] {
  return additions.reduce<CoverageRange[]>((acc, range) => mergeCoverage(acc, range), ranges.map((range) => ({ ...range })));
}

/** Sorts ranges oldest first and merges any that overlap or touch. */
export function normalizeCoverage(ranges: readonly CoverageRange[]): CoverageRange[] {
  const sorted = ranges.filter(isValidRange).sort((a, b) => a.oldest - b.oldest);
  const result: CoverageRange[] = [];
  for (const range of sorted) {
    const last = result[result.length - 1];
    if (last && range.oldest <= last.newest) {
      last.newest = Math.max(last.newest, range.newest);
      last.reachedBeginning = joinedBeginning(last, range);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}

export function findRange(ranges: readonly CoverageRange[], sortKey: number): CoverageRange | null {
  return ranges.find((range) => sortKey >= range.oldest && sortKey <= range.newest) ?? null;
}

/**
 * Whether the archive is gap-free from `continuesFrom` (where it was up to date before a run;
 * null when nothing was archived) to `newest` (the newest message the run reached), so the run
 * brought it up to date. Reaching the beginning of the chat counts as well.
 */
export function caughtUp(ranges: readonly CoverageRange[], newest: number | null, continuesFrom: number | null): boolean {
  if (newest === null || !Number.isFinite(newest)) return false;
  if (continuesFrom !== null && continuesFrom > newest) return false;
  const range = findRange(ranges.filter(isValidRange), newest);
  if (!range) return false;
  return continuesFrom === null || range.reachedBeginning || range.oldest <= continuesFrom;
}

export type CoverageStatus = 'empty' | 'complete' | 'partial';

/** Complete when one gap-free range runs from the beginning of the chat to the newest archived message. */
export function coverageStatus(ranges: readonly CoverageRange[], newestSortKey: number | null): CoverageStatus {
  if (ranges.length === 0) return 'empty';
  const complete = ranges.some((range) => range.reachedBeginning && (newestSortKey === null || range.newest >= newestSortKey));
  return complete ? 'complete' : 'partial';
}
