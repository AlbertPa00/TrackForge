import { describe, it, expect } from 'vitest';
import { adfToMarkdown } from '../../src/import/adfToMarkdown.js';

const doc = (content: unknown[]) => ({ type: 'doc', version: 1, content });
const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, marks });

describe('adfToMarkdown', () => {
  it('converts paragraphs and text marks', () => {
    const md = adfToMarkdown(doc([
      { type: 'paragraph', content: [
        text('Hello '),
        text('bold', [{ type: 'strong' }]),
        text(' and '),
        text('em', [{ type: 'em' }]),
        text(' and '),
        text('gone', [{ type: 'strike' }]),
      ] },
      { type: 'paragraph', content: [text('second')] },
    ]));
    expect(md).toBe('Hello **bold** and *em* and ~~gone~~\n\nsecond');
  });

  it('converts headings, lists, code, quote, rule, hardBreak', () => {
    const md = adfToMarkdown(doc([
      { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [text('one')] }] },
        { type: 'listItem', content: [
          { type: 'paragraph', content: [text('two')] },
          { type: 'bulletList', content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [text('nested')] }] },
          ] },
        ] },
      ] },
      { type: 'orderedList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [text('a')] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [text('b')] }] },
      ] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const x = 1;')] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [text('quoted')] }] },
      { type: 'rule' },
      { type: 'paragraph', content: [text('line'), { type: 'hardBreak' }, text('break')] },
    ]));
    expect(md).toContain('## Title');
    expect(md).toContain('- one\n- two\n  - nested');
    expect(md).toContain('1. a\n1. b');
    expect(md).toContain('```ts\nconst x = 1;\n```');
    expect(md).toContain('> quoted');
    expect(md).toContain('---');
    expect(md).toContain('line  \nbreak');
  });

  it('converts links and mentions', () => {
    const md = adfToMarkdown(doc([
      { type: 'paragraph', content: [
        text('see docs', [{ type: 'link', attrs: { href: 'https://x.test' } }]),
        text(' by '),
        { type: 'mention', attrs: { id: 'abc123' } },
      ] },
    ]));
    expect(md).toBe('[see docs](https://x.test) by [~accountId:abc123]');
  });

  it('converts tables to GFM', () => {
    const md = adfToMarkdown(doc([
      { type: 'table', content: [
        { type: 'tableRow', content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [text('H1')] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [text('H2')] }] },
        ] },
        { type: 'tableRow', content: [
          { type: 'tableCell', content: [{ type: 'paragraph', content: [text('a|b')] }] },
          { type: 'tableCell', content: [{ type: 'paragraph', content: [text('c')] }] },
        ] },
      ] },
    ]));
    expect(md).toBe('| H1 | H2 |\n| --- | --- |\n| a\\|b | c |');
  });

  it('degrades unsupported nodes to text with warnings', () => {
    const warnings: string[] = [];
    const md = adfToMarkdown(doc([
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'f1' } }] },
      { type: 'unknownBlock', content: [{ type: 'paragraph', content: [text('kept')] }] },
      { type: 'paragraph', content: [
        text('color', [{ type: 'textColor', attrs: { color: '#f00' } }]),
      ] },
    ]), (m) => warnings.push(m));
    expect(md).toContain('[media — attachment not yet imported (sprint 018)]');
    expect(md).toContain('kept');
    expect(md).toContain('color');
    expect(warnings.some((w) => w.includes('media'))).toBe(true);
    expect(warnings.some((w) => w.includes('unknownBlock'))).toBe(true);
    expect(warnings.some((w) => w.includes('textColor'))).toBe(true);
  });

  it('handles task lists, panels and expands', () => {
    const md = adfToMarkdown(doc([
      { type: 'taskList', content: [
        { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('did')] },
        { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('todo')] },
      ] },
      { type: 'panel', attrs: { panelType: 'warning' }, content: [
        { type: 'paragraph', content: [text('careful')] },
      ] },
      { type: 'expand', attrs: { title: 'More' }, content: [
        { type: 'paragraph', content: [text('inside')] },
      ] },
    ]));
    expect(md).toContain('- [x] did');
    expect(md).toContain('- [ ] todo');
    expect(md).toContain('> **WARNING**');
    expect(md).toContain('> careful');
    expect(md).toContain('**More**');
    expect(md).toContain('inside');
  });

  it('passes through strings and null safely', () => {
    expect(adfToMarkdown('plain string')).toBe('plain string');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
  });
});
