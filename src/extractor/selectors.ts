/**
 * DOM selector profile for Microsoft Teams Web (the "new Teams" client).
 *
 * Teams ships UI changes frequently, so every field lists several candidates in priority
 * order: stable `data-tid` test ids first, Fluent UI static class names next, generic ARIA
 * fallbacks last. Users can replace any field from the archive page (Settings, Advanced,
 * selector overrides) without rebuilding the extension.
 */

export interface AttributeIdRule {
  /** Selector for the element carrying the id (the scope element itself is included). */
  selector: string;
  attribute: string;
  /** Optional regular expression; capture group 1 is the id. */
  pattern?: string;
}

export interface SelectorProfile {
  version: number;
  /** Element that contains the rendered message items. */
  messageList: string[];
  /** Scrollable viewport of the message list (falls back to the nearest scrollable ancestor). */
  scrollContainer: string[];
  /** One rendered item. The first candidate that matches anything is used. */
  messageItem: string[];
  /** Rules that read the Teams message id from an item. */
  messageId: AttributeIdRule[];
  author: string[];
  timestamp: string[];
  body: string[];
  /** An item matching (or containing a match) is a message sent by the signed-in user. */
  selfMessage: string[];
  /** System / control messages ("X added Y to the chat"). */
  systemMessage: string[];
  dateDivider: string[];
  reply: {
    container: string[];
    author: string[];
    preview: string[];
    time: string[];
    idRules: AttributeIdRule[];
  };
  attachments: {
    container: string[];
    item: string[];
    name: string[];
    image: string[];
    card: string[];
    linkPreview: string[];
    /** Inline images that are emoji, not attachments. */
    emojiImage: string[];
  };
  mention: string[];
  /** One reaction under a message (a pill with an emoji and a count). */
  reaction: string[];
  edited: string[];
  /** Case-insensitive regular expressions matching the body text of deleted messages. */
  deletedPatterns: string[];
  /** Subtrees removed from message bodies before serialising (UI chrome inside the body). */
  excludeFromBody: string[];
  loadingIndicator: string[];
  chatTitle: string[];
  /** The highlighted entry in the chat list; its attributes are scanned for the thread id. */
  selectedChatItem: string[];
  /**
   * Other elements whose attributes may contain the thread id. Teams Web shows it in the id of
   * the chat header (`chat-header-19:…`) and in the value of the header's Chat tab.
   */
  threadIdHints: string[];
}

export const DEFAULT_SELECTOR_PROFILE: Readonly<SelectorProfile> = Object.freeze({
  version: 1,
  messageList: [
    '[data-tid="message-pane-list-runway"]',
    '[data-tid="message-pane-list"]',
    '[data-tid="message-pane-list-viewport"]',
    '#chat-pane-list',
    '[role="main"] [role="log"]',
    '[role="log"]',
  ],
  scrollContainer: [
    '[data-tid="message-pane-list-viewport"]',
    '[data-tid="message-pane-list"]',
    '[data-tid="message-pane-body"]',
  ],
  messageItem: [
    '[data-tid="chat-pane-item"]',
    '[data-tid="chat-pane-message"]',
    '.fui-ChatMessage, .fui-ChatMyMessage',
    '[role="listitem"]',
    '[role="article"]',
  ],
  messageId: [
    { selector: '[data-mid]', attribute: 'data-mid', pattern: '^(\\d{6,})$' },
    { selector: '[id^="message-body-"]', attribute: 'id', pattern: '^message-body-(\\d{6,})' },
    { selector: '[id^="content-"]', attribute: 'id', pattern: '^content-(\\d{6,})' },
    { selector: '[id^="timestamp-"]', attribute: 'id', pattern: '^timestamp-(\\d{6,})' },
    { selector: '[data-message-id]', attribute: 'data-message-id' },
    { selector: '[id^="message-"]', attribute: 'id', pattern: '^message-(\\d{6,})$' },
  ],
  author: [
    '[data-tid="message-author-name"]',
    '.fui-ChatMessage__author',
    '[data-tid="threadBodyDisplayName"]',
  ],
  timestamp: [
    'time[datetime]',
    '[data-tid="message-timestamp"]',
    '.fui-ChatMessage__timestamp',
    '.fui-ChatMyMessage__timestamp',
    '[id^="timestamp-"]',
    'time',
  ],
  body: [
    '[id^="content-"]',
    '[data-tid="message-body-content"]',
    '[data-tid="message-body"]',
    '[id^="message-body-"]',
    '.fui-ChatMessage__body',
    '.fui-ChatMyMessage__body',
  ],
  selfMessage: ['.fui-ChatMyMessage', '[data-tid="chat-pane-my-message"]', '[class*="ChatMyMessage"]'],
  systemMessage: [
    '[data-tid="control-message-renderer"]',
    '[data-tid*="control-message"]',
    '[data-tid*="system-message"]',
  ],
  dateDivider: [
    '[data-tid="message-pane-date-divider"]',
    '[data-tid*="date-divider"]',
    '[data-tid*="day-divider"]',
    '.fui-Divider',
    '[role="separator"]',
  ],
  reply: {
    container: [
      '[data-tid="quoted-reply-card"]',
      '[data-tid*="quoted-reply"]',
      '[itemtype="http://schema.skype.com/Reply"]',
      'blockquote[itemtype*="Reply"]',
    ],
    author: [
      '[itemprop="mri"]',
      '[data-tid="quoted-reply-author"]',
      '[data-tid*="quoted-reply-author"]',
      // Teams Web shows the quoted sender's name just before the quoted time, without a test id.
      'span:has(+ [data-tid="quoted-reply-timestamp"])',
      'strong',
    ],
    preview: [
      '[itemprop="preview"]',
      '[data-tid="quoted-reply-preview"]',
      '[data-tid="quoted-reply-preview-content"]',
      '[data-tid*="quoted-reply-preview"]',
      'p',
    ],
    time: ['[itemprop="time"]', 'time', '[data-tid*="quoted-reply-time"]'],
    idRules: [
      { selector: '[itemid]', attribute: 'itemid', pattern: '^(\\d{6,})$' },
      { selector: '[data-mid]', attribute: 'data-mid', pattern: '^(\\d{6,})$' },
      { selector: '[data-message-id]', attribute: 'data-message-id' },
    ],
  },
  attachments: {
    container: [
      '[data-tid="file-attachment-grid"]',
      '[data-tid="file-preview-root"]',
      '[data-tid*="attachment"]',
      '[data-tid*="file-card"]',
    ],
    item: ['[data-tid="file-attachment"]', '[data-tid*="file-card"]', '[data-tid*="attachment-item"]'],
    name: ['[data-tid*="file-name"]', '[data-tid*="filename"]'],
    image: ['img[itemtype*="AMSImage"]', 'img[data-gallery-src]', '[data-tid*="image-attachment"] img'],
    card: ['.ac-adaptiveCard', '[data-tid*="adaptive-card"]'],
    linkPreview: ['[data-tid*="url-preview"]', '[data-tid*="link-preview"]'],
    emojiImage: ['img[itemtype*="Emoji"]', 'img.emoji', '[data-tid*="emoji"] img', 'img[src*="emoji"]'],
  },
  mention: ['[itemtype="http://schema.skype.com/Mention"]', '[data-tid="mention"]', '[data-tid*="mention-"]'],
  reaction: ['[data-tid="diverse-reaction-pill-button"]', '[data-tid*="reaction-pill"]'],
  edited: ['[data-tid*="edited"]', '[id^="edited-"]'],
  deletedPatterns: [
    '^this message has been deleted\\.?$',
    '^this message was deleted\\.?$',
    '^message deleted\\.?$',
  ],
  excludeFromBody: [
    'button',
    '[data-tid*="reaction"]',
    '[data-tid*="message-actions"]',
    '[data-tid*="edited"]',
    '[id^="edited-"]',
    // Profile pictures, for example of the original sender in a forwarded message.
    'img[src*="/profilepicture"]',
    '.fui-Avatar',
    '[data-tid*="avatar"]',
  ],
  loadingIndicator: ['[role="progressbar"]', '.fui-Spinner', '[data-tid*="loading"]', '[data-tid*="spinner"]'],
  chatTitle: [
    '[data-tid="chat-header-title"]',
    '[data-tid="chat-title"]',
    '[data-tid*="chat-header"] h2',
    '[data-tid*="chat-header"] [role="heading"]',
    '[role="main"] h2',
  ],
  selectedChatItem: [
    '[data-tid="chat-list-item"][aria-selected="true"]',
    '[role="treeitem"][aria-selected="true"]',
    '[role="option"][aria-selected="true"]',
    '[role="treeitem"][aria-current="true"]',
    '[aria-current="page"]',
  ],
  threadIdHints: [
    '[id^="chat-header-"]',
    '[data-tid="tab-item-com.microsoft.chattabs.chat"]',
    '[data-tid*="chat-header"]',
    '[data-tid="message-pane-list-viewport"]',
    '[data-tid="message-pane-list-runway"]',
  ],
} satisfies SelectorProfile);

export class SelectorOverrideError extends Error {}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

function isRuleArray(value: unknown): value is AttributeIdRule[] {
  return (
    Array.isArray(value) &&
    value.every(
      (rule) =>
        rule &&
        typeof rule === 'object' &&
        typeof (rule as AttributeIdRule).selector === 'string' &&
        typeof (rule as AttributeIdRule).attribute === 'string' &&
        ((rule as AttributeIdRule).pattern === undefined || typeof (rule as AttributeIdRule).pattern === 'string'),
    )
  );
}

function mergeLevel(base: Record<string, unknown>, overrides: Record<string, unknown>, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = base[key];
    const where = path ? `${path}.${key}` : key;
    if (current === undefined) throw new SelectorOverrideError(`Unknown selector field "${where}"`);
    if (key === 'version') continue;
    if (Array.isArray(current)) {
      const rules = current.length > 0 && typeof current[0] === 'object';
      if (rules ? !isRuleArray(value) : !isStringArray(value)) {
        throw new SelectorOverrideError(
          rules
            ? `"${where}" must be an array of {selector, attribute, pattern?} objects`
            : `"${where}" must be an array of non-empty selector strings`,
        );
      }
      result[key] = value;
    } else if (current && typeof current === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SelectorOverrideError(`"${where}" must be an object`);
      }
      result[key] = mergeLevel(current as Record<string, unknown>, value as Record<string, unknown>, where);
    }
  }
  return result;
}

/**
 * Builds the effective profile from the defaults and a JSON override object.
 * Each overridden field replaces the default list for that field.
 */
export function buildSelectorProfile(overridesJson?: string | null): SelectorProfile {
  const base = structuredClone(DEFAULT_SELECTOR_PROFILE) as SelectorProfile;
  if (!overridesJson || overridesJson.trim() === '') return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(overridesJson);
  } catch (error) {
    throw new SelectorOverrideError(`Selector overrides are not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SelectorOverrideError('Selector overrides must be a JSON object');
  }
  return mergeLevel(base as unknown as Record<string, unknown>, parsed as Record<string, unknown>, '') as unknown as SelectorProfile;
}

/** Returns the selectors in a profile that the given document cannot parse. */
export function findInvalidSelectors(profile: SelectorProfile, doc: Document): string[] {
  const invalid: string[] = [];
  const probe = doc.createDocumentFragment();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      try {
        probe.querySelector(value);
      } catch {
        invalid.push(value);
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      const rule = value as Partial<AttributeIdRule>;
      if (typeof rule.selector === 'string' && typeof rule.attribute === 'string') {
        visit(rule.selector);
        if (rule.pattern) {
          try {
            new RegExp(rule.pattern);
          } catch {
            invalid.push(`pattern ${rule.pattern}`);
          }
        }
      } else {
        Object.entries(value).forEach(([key, child]) => {
          if (key !== 'deletedPatterns') visit(child);
        });
      }
    }
  };
  visit(profile);
  for (const pattern of profile.deletedPatterns) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      invalid.push(`pattern ${pattern}`);
    }
  }
  return invalid;
}
