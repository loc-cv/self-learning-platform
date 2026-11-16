import { expect, test } from 'vitest';
import { renderMarkdown } from './markdown.ts';

test('content Markdown renders; raw HTML is shown as text', () => {
  expect(renderMarkdown('**`web` is down** (namespace `shop`)')).toBe('<p><strong><code>web</code> is down</strong> (namespace <code>shop</code>)</p>\n');
  expect(renderMarkdown('- one\n- two')).toContain('<li>two</li>');
  expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
});
