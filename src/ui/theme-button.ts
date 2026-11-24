/**
 * The theme button in the header of the popup, the side panel and the archive page. It shows the
 * theme in use (a screen for Same as Windows, a sun, a moon) and a click moves to the next one.
 * Kept apart from theme.ts, which every page loads in its <head> and which draws nothing.
 */
import { icon } from './icons';
import { nextTheme, readTheme, saveTheme, THEME_STORAGE_KEY, themeLabel } from './theme';

export function wireThemeButton(button: HTMLElement): void {
  const render = (): void => {
    const theme = readTheme();
    button.replaceChildren(icon(`theme-${theme}`));
    button.setAttribute('aria-label', `Theme: ${themeLabel(theme)}`);
    button.title = `Theme: ${themeLabel(theme)}. Click for ${themeLabel(nextTheme(theme))}.`;
  };
  render();
  button.addEventListener('click', () => {
    saveTheme(nextTheme(readTheme()));
    render();
  });
  // Another page of the extension may change the theme while this one is open.
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) render();
  });
}
