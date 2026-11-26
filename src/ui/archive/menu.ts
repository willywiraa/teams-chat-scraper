/**
 * A button with three dots and the menu it opens: actions that would crowd a row of buttons. It
 * opens on a click, Enter or Space (on the first item) and on the arrow keys; the arrow keys, Home
 * and End move through its items. Escape closes it and returns to the button; a click elsewhere,
 * or Tab, closes it too. Disabled items are shown but skipped.
 */
import { el } from '../common';
import { icon, type IconName } from '../icons';

export interface MenuItem {
  icon: IconName;
  label: string;
  /** Drawn in the danger colour: an action that removes something. */
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}

let menus = 0;

/** The button and its menu. `groups` are drawn in order, with a rule between them. */
export function actionMenu(label: string, groups: MenuItem[][]): HTMLDivElement {
  const id = `action-menu-${++menus}`;
  const button = el(
    'button',
    { type: 'button', className: 'menu-button', id: `${id}-button`, 'aria-label': label, title: label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id },
    icon('ellipsis'),
  );
  const items: HTMLButtonElement[] = [];
  const children: HTMLElement[] = [];
  groups.forEach((group, i) => {
    if (i > 0) children.push(el('div', { className: 'menu-separator', role: 'separator' }));
    for (const item of group) {
      const element = el(
        'button',
        { type: 'button', role: 'menuitem', tabindex: '-1', className: item.danger ? 'menu-item danger' : 'menu-item', disabled: Boolean(item.disabled) },
        el('span', { className: 'icon-holder' }, icon(item.icon)),
        item.label,
      );
      element.addEventListener('click', () => {
        close(true);
        item.action();
      });
      items.push(element);
      children.push(element);
    }
  });
  const list = el('div', { className: 'menu-list', role: 'menu', id, 'aria-labelledby': button.id, hidden: true }, ...children);
  const menu = el('div', { className: 'menu' }, button, list);

  const enabled = (): HTMLButtonElement[] => items.filter((item) => !item.disabled);
  const isOpen = (): boolean => !list.hidden;

  function open(focus: 'first' | 'last'): void {
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const choices = enabled();
    (focus === 'first' ? choices[0] : choices.at(-1))?.focus();
    document.addEventListener('pointerdown', onPointerDown, true);
  }

  function close(returnFocus: boolean): void {
    if (!isOpen()) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onPointerDown, true);
    if (returnFocus) button.focus();
  }

  function onPointerDown(event: Event): void {
    if (!menu.contains(event.target as Node)) close(false);
  }

  button.addEventListener('click', () => (isOpen() ? close(true) : open('first')));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 'first' : 'last');
    } else if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close(true);
    }
  });
  list.addEventListener('keydown', (event) => {
    const choices = enabled();
    const at = choices.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = choices[(at + 1) % choices.length];
        break;
      case 'ArrowUp':
        next = choices[(at - 1 + choices.length) % choices.length];
        break;
      case 'Home':
        next = choices[0];
        break;
      case 'End':
        next = choices.at(-1);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        return;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  });
  // Focus leaving the menu (to the page, or another window) closes it.
  menu.addEventListener('focusout', (event) => {
    if (isOpen() && !menu.contains(event.relatedTarget as Node | null)) close(false);
  });
  return menu;
}
