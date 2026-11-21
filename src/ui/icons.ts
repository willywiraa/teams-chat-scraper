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
