import { describe, expect, it } from 'vitest';
import { serializeContent } from '../../src/extractor/content-serializer';
import { DEFAULT_SELECTOR_PROFILE } from '../../src/extractor/selectors';

function serialize(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return serializeContent(root, {
    exclude: [...DEFAULT_SELECTOR_PROFILE.excludeFromBody, ...DEFAULT_SELECTOR_PROFILE.reply.container],
    mentionSelectors: DEFAULT_SELECTOR_PROFILE.mention,
    emojiImageSelectors: DEFAULT_SELECTOR_PROFILE.attachments.emojiImage,
  });
}

describe('serializeContent', () => {
  it('keeps paragraphs separated by a blank line and collapses insignificant whitespace', () => {
    const result = serialize('<p>First paragraph</p>\n   <p>Second   paragraph\n   with a wrap</p>');
    expect(result.text).toBe('First paragraph\n\nSecond paragraph with a wrap');
  });

  it('turns line breaks and line-level blocks into newlines', () => {
    expect(serialize('<div>Line 1</div><div>Line 2<br>Line 3</div>').text).toBe('Line 1\nLine 2\nLine 3');
    expect(serialize('<p>a<br><br>b</p>').text).toBe('a\n\nb');
  });

  it('renders nested and ordered lists', () => {
    const result = serialize('<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul><ol><li>A</li><li>B</li></ol>');
    expect(result.text).toBe('- One\n- Two\n  - Nested\n\n1. A\n2. B');
  });

  it('preserves whitespace in code blocks', () => {
    expect(serialize('<pre><code>line 1\n    indented</code></pre>').text).toBe('line 1\n    indented');
  });

  it('drops quoted replies, reactions and buttons from the text', () => {
    const result = serialize(
      '<div data-tid="quoted-reply-card"><strong>Bob</strong><p>quoted</p></div><p>Actual reply</p><button>Like</button><div data-tid="message-reactions">👍 3</div>',
    );
    expect(result.text).toBe('Actual reply');
  });

  it('records mentions and links', () => {
    const result = serialize(
      '<p>Hi <span itemtype="http://schema.skype.com/Mention" itemid="0">Alice Smith</span>, see <a href="https://example.com/doc">the doc</a> and <a href="javascript:alert(1)">this</a></p>',
    );
    expect(result.text).toBe('Hi Alice Smith, see the doc and this');
    expect(result.mentions).toEqual([{ name: 'Alice Smith', id: null }]);
    expect(result.links).toEqual([{ href: 'https://example.com/doc', text: 'the doc' }]);
  });

  it('uses emoji alt text but records real images as attachments', () => {
    const result = serialize('<p>Great <img class="emoji" alt="😀" src="https://x/e.png"> job</p><img src="https://x/diagram.png" alt="diagram.png">');
    expect(result.text).toBe('Great 😀 job');
    expect(result.images.map((image) => image.attachment)).toEqual([{ kind: 'image', name: 'diagram.png', url: 'https://x/diagram.png' }]);
    expect(result.images[0]?.element.getAttribute('alt')).toBe('diagram.png');
  });

  it('ignores hidden elements', () => {
    expect(serialize('<p>Visible</p><p hidden>Hidden</p><p style="display: none">Gone</p>').text).toBe('Visible');
  });

  it('produces sanitised HTML without scripts, handlers or unsafe URLs', () => {
    const result = serialize('<p onclick="evil()" style="color:red" class="x">Hi <script>alert(1)</script><a href="javascript:alert(1)">x</a> <b>bold</b></p>');
    expect(result.html).toBe('<p>Hi <a>x</a> <b>bold</b></p>');
    expect(result.text).toBe('Hi x bold');
  });

  it('separates table cells', () => {
    expect(serialize('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>').text).toBe('a | b\nc | d');
  });
});
