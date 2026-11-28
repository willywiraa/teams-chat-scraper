import { describe, expect, it } from 'vitest';
import { buildSelectorProfile, DEFAULT_SELECTOR_PROFILE, findInvalidSelectors, SelectorOverrideError } from '../../src/extractor/selectors';
import { DEFAULT_SETTINGS, normalizeSettings, settingsForStorage } from '../../src/shared/settings';

describe('selector overrides', () => {
  it('starts from an independent copy of the defaults', () => {
    const profile = buildSelectorProfile('  ');
    expect(profile).toEqual(DEFAULT_SELECTOR_PROFILE);
    profile.author.push('.changed');
    expect(DEFAULT_SELECTOR_PROFILE.author).not.toContain('.changed');
  });

  it('replaces only the overridden lists, including nested ones', () => {
    const profile = buildSelectorProfile(
      JSON.stringify({ version: 3, author: ['[data-qa="sender"]'], reply: { container: ['.quote'] }, messageId: [{ selector: '[data-msg]', attribute: 'data-msg', pattern: '^(\\d+)$' }] }),
    );
    expect(profile.author).toEqual(['[data-qa="sender"]']);
    expect(profile.reply.container).toEqual(['.quote']);
    expect(profile.reply.author).toEqual(DEFAULT_SELECTOR_PROFILE.reply.author);
    expect(profile.messageId).toEqual([{ selector: '[data-msg]', attribute: 'data-msg', pattern: '^(\\d+)$' }]);
    expect(profile.body).toEqual(DEFAULT_SELECTOR_PROFILE.body);
  });

  it('rejects malformed overrides with a helpful message', () => {
    expect(() => buildSelectorProfile('{oops')).toThrow(SelectorOverrideError);
    expect(() => buildSelectorProfile('[]')).toThrow(/must be a JSON object/);
    expect(() => buildSelectorProfile('{"authr": ["x"]}')).toThrow(/Unknown selector field "authr"/);
    expect(() => buildSelectorProfile('{"author": "x"}')).toThrow(/"author" must be an array of non-empty selector strings/);
    expect(() => buildSelectorProfile('{"author": [""]}')).toThrow(SelectorOverrideError);
    expect(() => buildSelectorProfile('{"reply": ["x"]}')).toThrow(/"reply" must be an object/);
    expect(() => buildSelectorProfile('{"messageId": ["x"]}')).toThrow(/selector, attribute, pattern/);
    expect(() => buildSelectorProfile('{"reply": {"nope": ["x"]}}')).toThrow(/"reply.nope"/);
  });

  it('reports selectors and patterns the browser cannot parse', () => {
    expect(findInvalidSelectors(buildSelectorProfile(), document)).toEqual([]);
    const profile = buildSelectorProfile(
      JSON.stringify({ author: ['[[broken'], deletedPatterns: ['('], messageId: [{ selector: '[data-x]', attribute: 'data-x', pattern: '[' }] }),
    );
    const invalid = findInvalidSelectors(profile, document);
    expect(invalid).toHaveLength(3);
    expect(invalid).toEqual(expect.arrayContaining(['[[broken', 'pattern [', 'pattern (']));
  });
});

describe('settings', () => {
  it('uses the defaults for missing or unusable input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ scrollStepRatio: 'abc', settleQuietMs: Number.NaN, pauseWhenHidden: 'yes', dateOrder: 'XYZ' })).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps numbers into their allowed range and accepts numeric strings', () => {
    const settings = normalizeSettings({ scrollIntervalMs: 10, seekIntervalMs: '450', scrollStepRatio: 9, maxSteps: 12.7, maxNoProgressPasses: 0 });
    expect(settings).toMatchObject({ scrollIntervalMs: 250, seekIntervalMs: 450, scrollStepRatio: 3, maxSteps: 13, maxNoProgressPasses: 1 });
  });

  it('moves settings saved with the old scroll interval to the faster default, once', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ scrollIntervalMs: 600, scrollAnimationMs: 250 });
    // Saved before revision 2 with the then-default interval: the new default applies.
    expect(normalizeSettings({ scrollIntervalMs: 1200, selfDisplayName: 'Jordan Lee' })).toMatchObject({ scrollIntervalMs: 600, selfDisplayName: 'Jordan Lee' });
    // A value someone chose themselves is kept.
    expect(normalizeSettings({ scrollIntervalMs: 2000 }).scrollIntervalMs).toBe(2000);
    // Saved under the current revision, 1200 is a deliberate choice.
    expect(normalizeSettings(settingsForStorage({ ...DEFAULT_SETTINGS, scrollIntervalMs: 1200 })).scrollIntervalMs).toBe(1200);
    expect(normalizeSettings({ scrollAnimationMs: 0 }).scrollAnimationMs).toBe(0);
    expect(normalizeSettings({ scrollAnimationMs: 99_999 }).scrollAnimationMs).toBe(2000);
  });

  it('moves settings saved with the old waits at the top to the longer defaults, once', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ topLoadTimeoutMs: 20_000, maxNoProgressPasses: 6 });
    expect(normalizeSettings({ revision: 2, topLoadTimeoutMs: 8000, maxNoProgressPasses: 3 })).toMatchObject({ topLoadTimeoutMs: 20_000, maxNoProgressPasses: 6 });
    expect(normalizeSettings({ revision: 2, topLoadTimeoutMs: 30_000, maxNoProgressPasses: 4 })).toMatchObject({ topLoadTimeoutMs: 30_000, maxNoProgressPasses: 4 });
    expect(normalizeSettings(settingsForStorage({ ...DEFAULT_SETTINGS, topLoadTimeoutMs: 8000, maxNoProgressPasses: 3 }))).toMatchObject({ topLoadTimeoutMs: 8000, maxNoProgressPasses: 3 });
  });

  it('normalises the image settings', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ saveImages: true, maxImageMB: 10 });
    expect(normalizeSettings({ saveImages: false, maxImageMB: '25' })).toMatchObject({ saveImages: false, maxImageMB: 25 });
    expect(normalizeSettings({ saveImages: 'no', maxImageMB: 0 })).toMatchObject({ saveImages: true, maxImageMB: 1 });
    expect(normalizeSettings({ maxImageMB: 500 }).maxImageMB).toBe(50);
    expect(normalizeSettings({ maxImageMB: 'lots' }).maxImageMB).toBe(10);
  });

  it('keeps valid strings, booleans and enum values', () => {
    const settings = normalizeSettings({ selfDisplayName: '  Jordan Lee  ', dateOrder: 'DMY', pauseWhenHidden: false, selectorOverrides: '{"author":["x"]}' });
    expect(settings).toMatchObject({ selfDisplayName: 'Jordan Lee', dateOrder: 'DMY', pauseWhenHidden: false, selectorOverrides: '{"author":["x"]}' });
  });
});
