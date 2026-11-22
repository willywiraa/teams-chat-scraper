/** Small line icons, built as SVG elements (no markup is parsed). Each is 16 × 16 and takes the text colour. */

const PATHS = {
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
} as const;

export type IconName = keyof typeof PATHS;

const SVG = 'http://www.w3.org/2000/svg';

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon');
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
