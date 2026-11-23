/** What the parts of the archive page share: the archive, the status line and navigation. */
import type { ArchiveRepository } from '../../storage/repository';
import type { Route } from '../view-models';

export type MessageKind = 'notice' | 'error' | 'success';

export interface AppContext {
  repository(): Promise<ArchiveRepository>;
  /**
   * Shows a message in the page's status line (read out by screen readers). It stays until the
   * next navigation, or past it with `carry` (for a message about the action that navigates).
   */
  notify(text: string, kind?: MessageKind, options?: { carry?: boolean }): void;
  /** Goes to a route (through the address, so Back works). */
  go(route: Route): void;
  /** Draws the current view again, after the archive changed. */
  refresh(): Promise<void>;
}

/**
 * Runs an action of a button, showing its error in the status line instead of losing it. A click
 * while the action is still running is ignored, so a double click does not run it twice.
 */
export function guarded(app: AppContext, action: () => Promise<unknown>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    action()
      .catch((error: unknown) => app.notify(error instanceof Error ? error.message : String(error), 'error'))
      .finally(() => {
        running = false;
      });
  };
}
