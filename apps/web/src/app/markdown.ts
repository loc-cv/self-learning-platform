// Content Markdown (tickets, hints, debriefs) to HTML. The content is this repository's own,
// validated by `npm run content:check`; raw HTML in it is escaped all the same.

import { Marked } from 'marked';

const md = new Marked({ gfm: true, breaks: false, async: false });
md.use({
  renderer: {
    html: ({ text }) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  },
});

export function renderMarkdown(text: string): string {
  return md.parse(text) as string;
}

/** One line of Markdown without a paragraph: check titles. */
export function renderInline(text: string): string {
  return md.parseInline(text) as string;
}
