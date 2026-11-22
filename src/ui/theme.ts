/**
 * The interface theme: System (follows the operating system), Light or Dark.
 *
 * The choice is a display preference of this browser profile, kept in the extension's
 * localStorage so it can be read synchronously: `theme.js` runs in each page's <head> and sets
 * `data-theme` before anything is drawn, so a page never flashes in the other theme. Pages that
 * are open when the choice changes follow it through the `storage` event.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ui.theme';
/** In the order the popup's theme button steps through them. */
export const THEME_CHOICES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'Same as Windows' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function normalizeTheme(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function themeLabel(theme: ThemeChoice): string {
  return THEME_CHOICES.find((choice) => choice.value === theme)?.label ?? theme;
}

/** The choice after this one: Same as Windows, then Light, then Dark, then Same as Windows again. */
export function nextTheme(theme: ThemeChoice): ThemeChoice {
  const index = THEME_CHOICES.findIndex((choice) => choice.value === theme);
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length]!.value;
}

/** Sets the page's theme: `data-theme` for Light and Dark; none for System, where the stylesheet follows the operating system. */
export function applyTheme(theme: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function readTheme(storage: Pick<Storage, 'getItem'> = localStorage): ThemeChoice {
  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function saveTheme(theme: ThemeChoice, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
  applyTheme(theme);
}

/** Applies the stored theme now, and again whenever another page of the extension changes it. */
export function followTheme(): void {
  applyTheme(readTheme());
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) applyTheme(normalizeTheme(event.newValue));
  });
}
