/**
 * Line icons, built as SVG elements (no markup is parsed). Each takes the text colour and is
 * drawn with a 1.5 px line at any size.
 *
 * Two sets: the extension's own (16 × 16 grid), and icons from Lucide (24 × 24 grid; ISC licence,
 * src/ui/licenses/Lucide-ISC.txt), copied from the Claude Design prototype of this interface.
 * DESIGN.md says what each one stands for.
 */

/** A path's `d`, or a rectangle or circle with its attributes. */
type Shape = string | readonly ['rect' | 'circle', Readonly<Record<string, number | string>>];

const OWN = {
  /** A window with an arrow out of it: open the archive page. */
  open: ['M9 2.5h4.5V7', 'M13.5 2.5 7.5 8.5', 'M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3'],
  /** A window with a side column: open in the side panel. */
  panel: ['M2.5 3.5h11v9h-11z', 'M10 3.5v9'],
  /** An arrow to the left: back. */
  back: ['M13 8H3', 'M7 4 3 8l4 4'],
  /** A magnifier: search. */
  search: ['M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Z', 'M10.5 10.5 14 14'],
  /** A screen on a stand: the theme follows Windows. */
  'theme-system': ['M2.5 3h11v7.5h-11z', 'M5.5 13.5h5', 'M8 10.5v3'],
  /** A sun: the light theme. */
  'theme-light': [
    'M10.5 8a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0Z',
    'M8 1.5V3',
    'M8 13v1.5',
    'M1.5 8H3',
    'M13 8h1.5',
    'M3.4 3.4l1.1 1.1',
    'M11.5 11.5l1.1 1.1',
    'M3.4 12.6l1.1-1.1',
    'M11.5 4.5l1.1-1.1',
  ],
  /** A crescent moon: the dark theme. */
  'theme-dark': ['M13.5 9.6A5.5 5.5 0 1 1 6.4 2.5A6 6 0 0 0 13.5 9.6Z'],
} satisfies Record<string, readonly Shape[]>;

/** The outline and folded corner Lucide's file icons share. */
const FILE = 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z';
const FOLD = 'M14 2v5a1 1 0 0 0 1 1h5';
const FACE = ['circle', { cx: 12, cy: 12, r: 10 }] as const;

const LUCIDE = {
  'refresh-cw': ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
  'calendar-days': [
    'M8 2v3',
    'M16 2v3',
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
    'M3 9h18',
    'M8 13h.01',
    'M12 13h.01',
    'M16 13h.01',
    'M8 17h.01',
    'M12 17h.01',
    'M16 17h.01',
  ],
  'rotate-ccw-clock': ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  eye: ['M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0', ['circle', { cx: 12, cy: 12, r: 3 }]],
  download: ['M12 15V3', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5'],
  upload: ['M12 3v12', 'm17 8-5-5-5 5', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'],
  printer: [
    'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
    'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6',
    ['rect', { x: 6, y: 14, width: 12, height: 8, rx: 1 }],
  ],
  'file-text': [FILE, FOLD, 'M10 9H8', 'M16 13H8', 'M16 17H8'],
  'file-braces': [
    FILE,
    FOLD,
    'M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1',
    'M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1',
  ],
  'file-archive': [
    'M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5',
    FOLD,
    'M8 12v-1',
    'M8 18v-2',
    'M8 7V6',
    ['circle', { cx: 8, cy: 20, r: 2 }],
  ],
  'file-down': [FILE, FOLD, 'M12 18v-6', 'm9 15 3 3 3-3'],
  image: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['circle', { cx: 9, cy: 9, r: 2 }], 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21'],
  images: [
    'm22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16',
    'M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2',
    ['circle', { cx: 13, cy: 7, r: 1, fill: 'currentColor' }],
    ['rect', { x: 8, y: 2, width: 14, height: 14, rx: 2 }],
  ],
  paperclip: ['m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551'],
  reply: ['M20 18v-2a4 4 0 0 0-4-4H4', 'm9 17-5-5 5-5'],
  smile: ['M15 10V9', 'M16.472 15a6 6 0 01-8.943 0', 'M9 10V9', FACE],
  info: [FACE, 'M12 16v-4', 'M12 8h.01'],
  pencil: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ],
  'chevron-right': ['m9 18 6-6-6-6'],
  'circle-check': [FACE, 'm16 9-5.5 5.5L8 12'],
  'circle-alert': [FACE, 'M12 8v4', 'M12 16h.01'],
  pause: [
    ['rect', { x: 14, y: 3, width: 5, height: 18, rx: 1 }],
    ['rect', { x: 5, y: 3, width: 5, height: 18, rx: 1 }],
  ],
  play: ['M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z'],
  square: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }]],
  merge: ['m8 6 4-4 4 4', 'M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22', 'm20 22-5-5'],
  trash: ['M10 11v6', 'M14 11v6', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
} satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof OWN | keyof typeof LUCIDE;

const SVG = 'http://www.w3.org/2000/svg';

/** A decorative icon (hidden from screen readers: the control around it carries the name). */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const own = name in OWN;
  const shapes: readonly Shape[] = own ? OWN[name as keyof typeof OWN] : LUCIDE[name as keyof typeof LUCIDE];
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', own ? '0 0 16 16' : '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // ui.css draws every line 1.5 px wide on screen, whatever the grid and the size.
  svg.setAttribute('class', 'icon');
  for (const shape of shapes) {
    const [tag, attributes] = typeof shape === 'string' ? (['path', { d: shape }] as const) : shape;
    const element = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    svg.append(element);
  }
  return svg;
}

/** Every icon's name, to check the names written in the pages' markup. */
export const ICON_NAMES = [...Object.keys(OWN), ...Object.keys(LUCIDE)] as IconName[];

/**
 * Draws the icons the markup asks for: every element with `data-icon="<name>"` (and optionally
 * `data-icon-size`) gets that icon as its content.
 */
export function placeIcons(root: ParentNode = document): void {
  for (const holder of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = holder.dataset.icon as IconName;
    if (!ICON_NAMES.includes(name)) continue;
    holder.classList.add('icon-holder');
    holder.replaceChildren(icon(name, Number(holder.dataset.iconSize ?? 16)));
  }
}
