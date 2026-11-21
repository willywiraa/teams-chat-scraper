/**
 * Identifier probe for Diagnostics: where do chat and person identifiers appear in the rendered
 * Teams page? Only attribute values of rendered elements are read, nothing else.
 *
 * Nothing identifying reaches the report. Each identifier is replaced by its kind ("thread:v2",
 * "person:orgid", ...) and a neutral label (T1, P1, E1, G1). Equal values get equal labels, so a
 * report shows where an identifier is and which places agree, but never the identifier itself.
 * Elements are described by tag, test id, role and id, with identifiers and long numbers removed.
 */
import { safeMatches, safeQueryAll } from './dom';
import type { SelectorProfile } from './selectors';

export type IdFamily = 'thread' | 'person' | 'email' | 'guid';
export type ProbeRegion = 'selected-entry' | 'chat-header' | 'message-list' | 'main' | 'elsewhere';

export interface IdMatch {
  kind: string;
  family: IdFamily;
  /** The identifier in lower case, used to compare places. Never put into a report. */
  value: string;
}

interface IdShape {
  kind: string;
  family: IdFamily;
  pattern: RegExp;
}

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const THREAD = '19:[A-Za-z0-9._-]+';

/** Tried in this order; each match is replaced before the next shape is tried. */
const ID_SHAPES: readonly IdShape[] = [
  { kind: 'thread:meeting', family: 'thread', pattern: /19:meeting_[A-Za-z0-9._-]+@thread\.v2/gi },
  { kind: 'thread:unq', family: 'thread', pattern: new RegExp(`${THREAD}@unq\\.gbl\\.spaces`, 'gi') },
  { kind: 'thread:p2p', family: 'thread', pattern: new RegExp(`${THREAD}@p2p\\.thread\\.skype`, 'gi') },
  { kind: 'thread:tacv2', family: 'thread', pattern: new RegExp(`${THREAD}@thread\\.tacv2`, 'gi') },
  { kind: 'thread:skype', family: 'thread', pattern: new RegExp(`${THREAD}@thread\\.skype`, 'gi') },
  { kind: 'thread:v2', family: 'thread', pattern: new RegExp(`${THREAD}@thread\\.v2`, 'gi') },
  { kind: 'thread:notes', family: 'thread', pattern: /48:notes/gi },
  { kind: 'person:orgid', family: 'person', pattern: new RegExp(`8:orgid:${GUID}`, 'gi') },
  { kind: 'person:live', family: 'person', pattern: /8:live:[A-Za-z0-9._-]+/gi },
  { kind: 'person:visitor', family: 'person', pattern: /8:teamsvisitor:[A-Za-z0-9._-]+/gi },
  { kind: 'person:other', family: 'person', pattern: /8:(?:sfb|gid|acs|tel|dynamics):[A-Za-z0-9._+-]+/gi },
  { kind: 'bot', family: 'person', pattern: new RegExp(`28:${GUID}`, 'gi') },
  { kind: 'email', family: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { kind: 'guid', family: 'guid', pattern: new RegExp(GUID, 'gi') },
];

/** Cheap test whether a raw attribute value can contain any of the shapes (also URL-encoded). */
const MAYBE_ID = /19(?::|%3a)|8(?::|%3a)|@|%40|%25|[0-9a-f]{8}-[0-9a-f]{4}-/i;
const ASCII_ESCAPE = /%([0-7][0-9a-f])/gi;

/** Decodes URL-encoded ASCII characters (twice, for doubly encoded links); tolerates stray "%". */
function decodeAscii(value: string): string {
  let current = value;
  for (let round = 0; round < 2 && /%[0-7][0-9a-f]/i.test(current); round++) {
    current = current.replace(ASCII_ESCAPE, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return current;
}

/** Finds identifier-shaped parts of a value; `redacted` is the value with each replaced by `<kind>`. */
export function findIdentifiers(raw: string): { matches: IdMatch[]; redacted: string } {
  let text = decodeAscii(raw);
  const matches: IdMatch[] = [];
  for (const shape of ID_SHAPES) {
    text = text.replace(shape.pattern, (found) => {
      matches.push({ kind: shape.kind, family: shape.family, value: found.toLowerCase() });
      return `<${shape.kind}>`;
    });
  }
  return { matches, redacted: text };
}

/** Replaces identifiers with their kind and runs of four or more digits (message ids) with `<n>`. */
export function redactIdentifiers(raw: string): string {
  return findIdentifiers(raw).redacted.replace(/\d{4,}/g, '<n>');
}

const TOKEN = /^[\w.:<>-]{1,64}$/;

/** A test id, role or element id fit for a report: identifiers removed, anything unusual elided. */
export function reportToken(value: string): string {
  const redacted = redactIdentifiers(value).trim();
  return TOKEN.test(redacted) ? redacted : '<other>';
}

/** Tag, test id, role and id of an element, for example `div[data-tid="chat-list-item"][role="treeitem"]`. */
export function describeElement(el: Element): string {
  let out = el.localName;
  const testId = el.getAttribute('data-tid');
  if (testId !== null) out += `[data-tid="${reportToken(testId)}"]`;
  const role = el.getAttribute('role');
  if (role !== null) out += `[role="${reportToken(role)}"]`;
  if (el.id) out += `#${reportToken(el.id)}`;
  return out;
}

const SKIPPED_ATTRIBUTES = new Set(['class', 'd', 'points', 'viewbox']);
const MAX_VALUE_LENGTH = 4096;

function attributeMatches(el: Element): Array<{ attribute: string; match: IdMatch }> {
  const found: Array<{ attribute: string; match: IdMatch }> = [];
  for (const attr of Array.from(el.attributes)) {
    const value = attr.value;
    if (SKIPPED_ATTRIBUTES.has(attr.name.toLowerCase()) || value.length < 8 || value.length > MAX_VALUE_LENGTH) continue;
    if (value.startsWith('data:') || !MAYBE_ID.test(value)) continue;
    for (const match of findIdentifiers(value).matches) found.push({ attribute: attr.name, match });
  }
  return found;
}

const LABEL_PREFIX: Record<IdFamily, string> = { thread: 'T', person: 'P', email: 'E', guid: 'G' };

/** Hands out T1, T2, ... per family: equal values get equal labels. */
class Labels {
  private readonly byFamily = new Map<IdFamily, Map<string, string>>();

  label(match: IdMatch): string {
    let values = this.byFamily.get(match.family);
    if (!values) {
      values = new Map();
      this.byFamily.set(match.family, values);
    }
    let label = values.get(match.value);
    if (!label) {
      label = `${LABEL_PREFIX[match.family]}${values.size + 1}`;
      values.set(match.value, label);
    }
    return label;
  }
}

export interface ProbeRegions {
  /** The chat-list entry the "selectedChatItem" selectors find. */
  selected: Element | null;
  header: Element | null;
  list: Element | null;
  main: Element | null;
}

const HEADER_LIKE = '[data-tid*="header"], header, [role="banner"]';

/**
 * The chat header: the largest element around the chat title that does not contain the message
 * list (without a message list, the nearest header-like element around the title).
 */
export function findChatHeader(doc: Document, profile: SelectorProfile, list: Element | null): Element | null {
  const outsideList = (el: Element): boolean => !list?.contains(el);
  let start: Element | null = null;
  for (const selector of profile.chatTitle) {
    start = safeQueryAll(doc, selector).find(outsideList) ?? null;
    if (start) break;
  }
  start ??= safeQueryAll(doc, '[data-tid*="chat-header"], [id^="chat-header-"]').find(outsideList) ?? null;
  if (!start) return null;
  if (!list) return start.parentElement?.closest(HEADER_LIKE) ?? start;
  const main = start.closest('[role="main"], main');
  let header = start;
  for (let el = start.parentElement; el && el !== main && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
    if (el.contains(list)) break;
    header = el;
  }
  return header;
}

export function locateRegions(doc: Document, profile: SelectorProfile, list: Element | null): ProbeRegions {
  let selected: Element | null = null;
  for (const selector of profile.selectedChatItem) {
    selected = safeQueryAll(doc, selector)[0] ?? null;
    if (selected) break;
  }
  return {
    selected,
    header: findChatHeader(doc, profile, list),
    list,
    main: list?.closest('[role="main"], main') ?? doc.querySelector('[role="main"], main'),
  };
}

function regionOf(el: Element, regions: ProbeRegions): ProbeRegion {
  if (regions.selected?.contains(el)) return 'selected-entry';
  if (regions.header?.contains(el)) return 'chat-header';
  if (regions.list?.contains(el)) return 'message-list';
  if (regions.main?.contains(el)) return 'main';
  return 'elsewhere';
}

export interface IdentifierFinding {
  region: ProbeRegion;
  element: string;
  attribute: string;
  kind: string;
  /** Occurrences of this kind of identifier in this attribute of such elements in the region. */
  count: number;
  /** Labels of the first distinct values; equal labels mean equal identifiers. */
  values: string[];
  distinct: number;
}

export interface HighlightedElement {
  element: string;
  region: ProbeRegion;
  /** Index of the first "selectedChatItem" selector that matches the element, or null. */
  selectorIndex: number | null;
  /** Identifiers on the element ("self"), in it ("inside") or on its ancestors ("parent 1" to "parent 3"). */
  identifiers: Array<{ where: string; attribute: string; kind: string; value: string }>;
}

export interface TestIdCount {
  value: string;
  count: number;
}

export interface IdentifierProbe {
  scannedElements: number;
  /** True when the page had more elements than were scanned. */
  truncated: boolean;
  /** The elements the regions were taken from (null when not found). */
  regions: { selectedEntry: string | null; chatHeader: string | null; messageList: string | null };
  url: { kinds: string[]; values: string[] };
  /** Distinct identifiers per family and region. */
  distinct: Record<IdFamily, Partial<Record<ProbeRegion, number>>>;
  findings: IdentifierFinding[];
  omittedFindings: number;
  /** Elements marked as selected or current (the highlighted chat-list entry among them). */
  highlighted: HighlightedElement[];
  /** Test ids (`data-tid`) per region, most frequent first. */
  dataTids: { chatHeader: TestIdCount[] | null; selectedEntry: TestIdCount[] | null; messageList: TestIdCount[] | null };
}

export interface ProbeOptions {
  profile: SelectorProfile;
  list: Element | null;
  href: string;
  /** Upper bound on the elements scanned (default 30,000). */
  maxElements?: number;
}

export interface ProbeResult {
  probe: IdentifierProbe;
  regions: ProbeRegions;
  /** The highlighted chat-list entry: the selected entry, or the most likely highlighted element. */
  entry: Element | null;
}

const DEFAULT_MAX_ELEMENTS = 30000;
const MAX_FINDINGS = 40;
const MAX_VALUES = 5;
const MAX_HIGHLIGHTED = 10;
const MAX_NEAR = 12;
const HIGHLIGHT_SELECTOR = '[aria-selected="true"], [aria-current]:not([aria-current="false"]), [data-selected="true"]';
const ENTRY_ROLES = new Set(['treeitem', 'option', 'listitem', 'row', 'gridcell']);
const FAMILY_ORDER: readonly IdFamily[] = ['thread', 'person', 'email', 'guid'];
const REGION_ORDER: readonly ProbeRegion[] = ['selected-entry', 'chat-header', 'message-list', 'main', 'elsewhere'];

interface FindingGroup {
  family: IdFamily;
  region: ProbeRegion;
  element: string;
  attribute: string;
  kind: string;
  count: number;
  labels: Set<string>;
}

function labelNumber(label: string): number {
  return Number(label.slice(1));
}

function identifiersNear(el: Element, labels: Labels): HighlightedElement['identifiers'] {
  const found: HighlightedElement['identifiers'] = [];
  const seen = new Set<string>();
  const add = (where: string, node: Element): void => {
    for (const { attribute, match } of attributeMatches(node)) {
      const value = labels.label(match);
      const key = `${where}|${attribute}|${match.kind}|${value}`;
      if (seen.has(key) || found.length >= MAX_NEAR) continue;
      seen.add(key);
      found.push({ where, attribute, kind: match.kind, value });
    }
  };
  add('self', el);
  const inside = el.getElementsByTagName('*');
  for (let i = 0; i < inside.length && i < 200; i++) add('inside', inside[i] as Element);
  let parent = el.parentElement;
  for (let level = 1; level <= 3 && parent && parent !== el.ownerDocument.body; level++) {
    add(`parent ${level}`, parent);
    parent = parent.parentElement;
  }
  return found;
}

function testIdCounts(root: Element | null, limit: number): TestIdCount[] | null {
  if (!root) return null;
  const counts = new Map<string, number>();
  for (const el of [root, ...Array.from(root.querySelectorAll('[data-tid]'))]) {
    const testId = el.getAttribute('data-tid');
    if (testId === null) continue;
    const value = reportToken(testId);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, limit);
}

export function probePage(doc: Document, options: ProbeOptions): ProbeResult {
  const regions = locateRegions(doc, options.profile, options.list);
  const labels = new Labels();
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;

  // The address first, then the selected entry and the header, so their identifiers get the first labels.
  const urlMatches = findIdentifiers(options.href).matches;
  const url = {
    kinds: [...new Set(urlMatches.map((match) => match.kind))],
    values: [...new Set(urlMatches.map((match) => labels.label(match)))],
  };

  const groups = new Map<string, FindingGroup>();
  const distinctSets = new Map<IdFamily, Map<ProbeRegion, Set<string>>>();
  const visited = new Set<Element>();
  let scanned = 0;
  let truncated = false;

  const visit = (el: Element): boolean => {
    if (visited.has(el)) return true;
    if (scanned >= maxElements) {
      truncated = true;
      return false;
    }
    visited.add(el);
    scanned++;
    const matches = attributeMatches(el);
    if (matches.length === 0) return true;
    const region = regionOf(el, regions);
    const element = describeElement(el);
    for (const { attribute, match } of matches) {
      const label = labels.label(match);
      const key = `${region}|${element}|${attribute}|${match.kind}`;
      let group = groups.get(key);
      if (!group) {
        group = { family: match.family, region, element, attribute, kind: match.kind, count: 0, labels: new Set() };
        groups.set(key, group);
      }
      group.count++;
      group.labels.add(label);
      let byRegion = distinctSets.get(match.family);
      if (!byRegion) {
        byRegion = new Map();
        distinctSets.set(match.family, byRegion);
      }
      let values = byRegion.get(region);
      if (!values) {
        values = new Set();
        byRegion.set(region, values);
      }
      values.add(label);
    }
    return true;
  };

  const scan = (root: Element | null): boolean => {
    if (!root) return true;
    if (!visit(root)) return false;
    const all = root.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      if (!visit(all[i] as Element)) return false;
    }
    return true;
  };
  // Each scan returns false once the limit is reached.
  if (scan(regions.selected) && scan(regions.header)) scan(doc.documentElement);

  const sorted = [...groups.values()].sort(
    (a, b) =>
      FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
      REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region) ||
      b.count - a.count ||
      (a.element < b.element ? -1 : a.element > b.element ? 1 : 0),
  );
  const findings: IdentifierFinding[] = sorted.slice(0, MAX_FINDINGS).map((group) => {
    const ordered = [...group.labels].sort((a, b) => labelNumber(a) - labelNumber(b));
    return {
      region: group.region,
      element: group.element,
      attribute: group.attribute,
      kind: group.kind,
      count: group.count,
      values: ordered.slice(0, MAX_VALUES),
      distinct: ordered.length,
    };
  });

  const distinct = Object.fromEntries(
    FAMILY_ORDER.map((family) => [
      family,
      Object.fromEntries([...(distinctSets.get(family) ?? new Map<ProbeRegion, Set<string>>())].map(([region, values]) => [region, values.size])),
    ]),
  ) as IdentifierProbe['distinct'];

  // Highlighted elements: those near a thread id first, then chat-list-like ones, then the rest.
  const candidates = safeQueryAll(doc, HIGHLIGHT_SELECTOR)
    .slice(0, 50)
    .map((el, order) => {
      const identifiers = identifiersNear(el, labels);
      const index = options.profile.selectedChatItem.findIndex((selector) => safeMatches(el, selector));
      const region = regionOf(el, regions);
      const score =
        (identifiers.some((id) => id.kind.startsWith('thread:')) ? 0 : 4) +
        (ENTRY_ROLES.has(el.getAttribute('role') ?? '') ? 0 : 2) +
        (region === 'elsewhere' || region === 'selected-entry' ? 0 : 1);
      return { el, order, score, info: { element: describeElement(el), region, selectorIndex: index >= 0 ? index : null, identifiers } };
    })
    .sort((a, b) => a.score - b.score || a.order - b.order);
  const entry = regions.selected ?? candidates.find((candidate) => !regions.main?.contains(candidate.el))?.el ?? null;

  return {
    probe: {
      scannedElements: scanned,
      truncated,
      regions: {
        selectedEntry: regions.selected ? describeElement(regions.selected) : null,
        chatHeader: regions.header ? describeElement(regions.header) : null,
        messageList: regions.list ? describeElement(regions.list) : null,
      },
      url,
      distinct,
      findings,
      omittedFindings: Math.max(0, sorted.length - MAX_FINDINGS),
      highlighted: candidates.slice(0, MAX_HIGHLIGHTED).map((candidate) => candidate.info),
      dataTids: {
        chatHeader: testIdCounts(regions.header, 30),
        selectedEntry: testIdCounts(regions.selected, 15),
        messageList: testIdCounts(regions.list, 50),
      },
    },
    regions,
    entry,
  };
}

export function probeIdentifiers(doc: Document, options: ProbeOptions): IdentifierProbe {
  return probePage(doc, options).probe;
}
