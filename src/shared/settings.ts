/**
 * User-configurable scraping settings, stored in chrome.storage.local under SETTINGS_STORAGE_KEY.
 */

export type DateOrderSetting = 'auto' | 'MDY' | 'DMY' | 'YMD';

export interface ScrapeSettings {
  /** Minimum delay between scroll steps while capturing new history (ms). */
  scrollIntervalMs: number;
  /** Minimum delay between scroll steps while passing through already-archived ranges (ms). */
  seekIntervalMs: number;
  /** Scroll step as a fraction of the message viewport height. Reduced automatically if gaps appear. */
  scrollStepRatio: number;
  /** Each scroll step is animated over this long (ms) for smooth scrolling; 0 jumps instead. */
  scrollAnimationMs: number;
  /** The DOM must be free of mutations for this long before content counts as rendered (ms). */
  settleQuietMs: number;
  /** Upper bound for waiting on rendering after a scroll step (ms). */
  settleTimeoutMs: number;
  /** How long to wait for Teams to load older history once the top of the list is reached (ms). */
  topLoadTimeoutMs: number;
  /** Consecutive attempts at the top without new messages before history is considered complete. */
  maxNoProgressPasses: number;
  /** Consecutive passes without any new message (anywhere) before the run stops as stuck. */
  maxStallPasses: number;
  /** Hard cap on scroll steps per session (infinite-loop guard). */
  maxSteps: number;
  /** Hard cap on session duration in minutes (infinite-loop guard). */
  maxDurationMinutes: number;
  /** Already-archived messages that must be re-observed before an incremental update stops. */
  incrementalOverlap: number;
  /** An update re-reads the archive this many days back from the last update (late edits and replies). */
  updateOverlapDays: number;
  /** Pause automatically while the Teams tab is hidden (background tabs are throttled by the browser). */
  pauseWhenHidden: boolean;
  /** Save the images displayed in messages (the copy Teams already shows) into the archive. */
  saveImages: boolean;
  /** Images larger than this many megabytes are not saved (their name and link still are). */
  maxImageMB: number;
  /** Your display name, used as the sender of your own messages (Teams does not render it). */
  selfDisplayName: string;
  /** Order of numeric dates shown by Teams, used only when a precise timestamp is unavailable. */
  dateOrder: DateOrderSetting;
  /** JSON object overriding entries of the DOM selector profile (see extractor/selectors.ts). */
  selectorOverrides: string;
}

export const SETTINGS_STORAGE_KEY = 'settings.v1';

/**
 * Stored with the settings. Settings saved under an older revision still holding a default of
 * that time get the current default instead (revision 2 made scrolling faster).
 */
export const SETTINGS_REVISION = 2;

const REPLACED_DEFAULTS: ReadonlyArray<{ before: number; key: NumericKey; value: number }> = [
  { before: 2, key: 'scrollIntervalMs', value: 1200 },
];

export const DEFAULT_SETTINGS: Readonly<ScrapeSettings> = Object.freeze({
  scrollIntervalMs: 600,
  seekIntervalMs: 300,
  scrollStepRatio: 0.8,
  scrollAnimationMs: 250,
  settleQuietMs: 350,
  settleTimeoutMs: 6000,
  topLoadTimeoutMs: 8000,
  maxNoProgressPasses: 3,
  maxStallPasses: 25,
  maxSteps: 50000,
  maxDurationMinutes: 360,
  incrementalOverlap: 8,
  updateOverlapDays: 2,
  pauseWhenHidden: true,
  saveImages: true,
  maxImageMB: 10,
  selfDisplayName: '',
  dateOrder: 'auto',
  selectorOverrides: '',
});

type NumericKey = {
  [K in keyof ScrapeSettings]: ScrapeSettings[K] extends number ? K : never;
}[keyof ScrapeSettings];

/** Allowed ranges for user-entered values. Tests may bypass these by constructing settings directly. */
export const SETTING_LIMITS: Readonly<Record<NumericKey, readonly [number, number]>> = Object.freeze({
  scrollIntervalMs: [250, 60000],
  seekIntervalMs: [100, 60000],
  scrollStepRatio: [0.2, 3],
  scrollAnimationMs: [0, 2000],
  settleQuietMs: [100, 10000],
  settleTimeoutMs: [500, 120000],
  topLoadTimeoutMs: [1000, 120000],
  maxNoProgressPasses: [1, 20],
  maxStallPasses: [3, 500],
  maxSteps: [1, 1000000],
  maxDurationMinutes: [1, 1440],
  incrementalOverlap: [1, 500],
  updateOverlapDays: [0, 30],
  maxImageMB: [1, 50],
});

const DATE_ORDERS: readonly DateOrderSetting[] = ['auto', 'MDY', 'DMY', 'YMD'];

function clampNumber(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** Coerces arbitrary (possibly stale or hand-edited) input into valid settings. */
export function normalizeSettings(input: unknown): ScrapeSettings {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const result: ScrapeSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(SETTING_LIMITS) as NumericKey[]) {
    result[key] = clampNumber(source[key], SETTING_LIMITS[key], DEFAULT_SETTINGS[key]);
  }
  const revision = typeof source.revision === 'number' ? source.revision : 1;
  for (const { before, key, value } of REPLACED_DEFAULTS) {
    if (revision < before && result[key] === value) result[key] = DEFAULT_SETTINGS[key];
  }
  for (const key of ['maxNoProgressPasses', 'maxStallPasses', 'maxSteps', 'incrementalOverlap', 'updateOverlapDays'] as const) {
    result[key] = Math.round(result[key]);
  }
  if (typeof source.pauseWhenHidden === 'boolean') result.pauseWhenHidden = source.pauseWhenHidden;
  if (typeof source.saveImages === 'boolean') result.saveImages = source.saveImages;
  if (typeof source.selfDisplayName === 'string') result.selfDisplayName = source.selfDisplayName.trim().slice(0, 200);
  if (typeof source.dateOrder === 'string' && DATE_ORDERS.includes(source.dateOrder as DateOrderSetting)) {
    result.dateOrder = source.dateOrder as DateOrderSetting;
  }
  if (typeof source.selectorOverrides === 'string') result.selectorOverrides = source.selectorOverrides;
  return result;
}

/** What is written to storage: the settings plus the revision they were saved under. */
export function settingsForStorage(settings: ScrapeSettings): ScrapeSettings & { revision: number } {
  return { ...settings, revision: SETTINGS_REVISION };
}
