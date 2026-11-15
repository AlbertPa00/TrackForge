/**
 * Jira Atlassian Document Format (ADF) → Markdown, per sprint 017:
 * paragraphs, text marks, headings, lists, code, quote, rule, hardBreak,
 * links, mentions ([~accountId:]), tables. Unsupported nodes degrade to
 * their text content with a warning rather than being dropped silently.
 */

import { jiraDate } from '../lib/http.js';

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

export type AdfWarn = (message: string) => void;

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'blockquote',
  'rule',
  'mediaSingle',
  'mediaGroup',
  'panel',
  'expand',
  'table',
  'tableRow',
  'decisionList',
  'taskList',
]);

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!|>~])/g, '\\$1');
}

/** Render inline content (text + marks). */
function inline(node: AdfNode, warn: AdfWarn): string {
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'mention') {
    const id = String(node.attrs?.id ?? node.attrs?.accountId ?? '');
    return `[~accountId:${id}]`;
  }
  if (node.type === 'inlineCard') {
    const url = String(node.attrs?.url ?? '');
    warn(`inlineCard degraded to link`);
    return url ? `[${url}](${url})` : '';
  }
  if (node.type === 'emoji') {
    const short = String(node.attrs?.shortName ?? '');
    return short || '';
  }
  if (node.type === 'date') {
    const ts = String(node.attrs?.timestamp ?? '');
    return ts ? jiraDate(new Date(Number(ts))) : '';
  }
  if (node.type === 'status') {
    return `\`${escapeMd(String(node.attrs?.text ?? ''))}\``;
  }
  if (node.type === 'text' || node.text !== undefined) {
    let out = escapeMd(node.text ?? '');
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case 'strong':
          out = `**${out}**`;
          break;
        case 'em':
          out = `*${out}*`;
          break;
        case 'code':
          out = `\`${node.text ?? ''}\``;
          break; // raw inside code
        case 'strike':
          out = `~~${out}~~`;
          break;
        case 'underline':
          out = `<u>${out}</u>`;
          break;
        case 'link': {
          const href = String(mark.attrs?.href ?? '');
          out = `[${node.text ?? ''}](${href})`;
          break;
        }
        case 'textColor':
        case 'subsup':
        case 'alignment':
        case 'indentation':
        case 'border':
        case 'backgroundColor':
          warn(`unsupported text mark '${mark.type}' dropped`);
          break;
        default:
          warn(`unknown text mark '${mark.type}' dropped`);
      }
    }
    return out;
  }
  // Non-text inline node we don't know — try its content, else text.
  if (node.content) return inlineAll(node.content, warn);
  warn(`unsupported inline node '${node.type ?? '?'}' dropped`);
  return '';
}

function inlineAll(nodes: AdfNode[], warn: AdfWarn): string {
  return nodes.map((n) => inline(n, warn)).join('');
}

/** Render block content, one markdown block per node. */
function block(node: AdfNode, warn: AdfWarn): string {
  switch (node.type) {
    case 'paragraph':
      return inlineAll(node.content ?? [], warn);
    case 'heading':
      return `${'#'.repeat(Math.min(6, Number(node.attrs?.level ?? 1)))} ${inlineAll(node.content ?? [], warn)}`;
    case 'bulletList':
      return listItems(node, warn, '-');
    case 'orderedList':
      return listItems(node, warn, '1.');
    case 'codeBlock': {
      const lang = String(node.attrs?.language ?? '');
      const code = (node.content ?? []).map((c) => c.text ?? '').join('');
      return '```' + lang + '\n' + code + '\n```';
    }
    case 'blockquote':
      return blocks(node.content ?? [], warn)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'rule':
      return '---';
    case 'mediaSingle':
    case 'mediaGroup':
      warn(`media node not yet supported (sprint 018) — placeholder kept`);
      return `[media — attachment not yet imported (sprint 018)]`;
    case 'panel': {
      const t = String(node.attrs?.panelType ?? 'info').toUpperCase();
      return (
        `> **${t}**\n>\n` +
        blocks(node.content ?? [], warn)
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n')
      );
    }
    case 'expand':
    case 'nestedExpand': {
      const title = String(node.attrs?.title ?? 'Details');
      return `**${escapeMd(title)}**\n\n` + blocks(node.content ?? [], warn);
    }
    case 'table':
      return table(node, warn);
    case 'taskList':
    case 'decisionList': {
      warn(`${node.type} converted to bullet list`);
      return listItems(node, warn, '-');
    }
    case 'listItem': // nested lists handled by listItems; stray item → paragraph
      return blocks(node.content ?? [], warn);
    default:
      if (node.content) {
        warn(`unsupported block '${node.type ?? '?'}' degraded to text`);
        return blocks(node.content, warn);
      }
      warn(`unsupported block '${node.type ?? '?'}' dropped`);
      return '';
  }
}

function listItems(node: AdfNode, warn: AdfWarn, marker: string): string {
  const lines: string[] = [];
  for (const item of node.content ?? []) {
    if (item.type !== 'listItem' && item.type !== 'taskItem' && item.type !== 'decisionItem') continue;
    let check = '';
    if (item.type === 'taskItem') check = item.attrs?.state === 'DONE' ? '[x] ' : '[ ] ';
    let first = true;
    for (const child of item.content ?? []) {
      // taskItem/decisionItem carry inline text children rather than blocks
      const rendered = (BLOCK_TYPES.has(child.type ?? '') ? block(child, warn) : inline(child, warn)).trimEnd();
      if (!rendered) continue;
      const isList = child.type === 'bulletList' || child.type === 'orderedList';
      if (first && !isList) {
        lines.push(`${marker} ${check}${rendered}`);
        first = false;
      } else {
        // nested list or continuation paragraph — indent under parent
        for (const l of rendered.split('\n')) lines.push(`  ${l}`);
      }
    }
  }
  return lines.join('\n');
}

function table(node: AdfNode, warn: AdfWarn): string {
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return '';
  const cellText = (cell: AdfNode) =>
    blocks(cell.content ?? [], warn)
      .replace(/\n+/g, ' ')
      .trim();
  const grid = rows.map((r) =>
    (r.content ?? []).filter((c) => c.type === 'tableCell' || c.type === 'tableHeader').map(cellText)
  );
  const cols = Math.max(...grid.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill('')];
  const [head, ...body] = grid.map(pad);
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

function blocks(nodes: AdfNode[], warn: AdfWarn): string {
  return nodes
    .map((n) => block(n, warn))
    .filter((s) => s !== '')
    .join('\n\n');
}

/**
 * Convert a Jira ADF document (or plain string, for v2-style fields) to Markdown.
 * Returns the input unchanged if it's already a string; '' for null/undefined.
 */
export function adfToMarkdown(doc: unknown, warn: AdfWarn = () => {}): string {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc;
  const node = doc as AdfNode;
  if (node.type === 'doc') return blocks(node.content ?? [], warn);
  if (BLOCK_TYPES.has(node.type ?? '')) return block(node, warn);
  if (node.text !== undefined) return inline(node, warn);
  warn(`unrecognized ADF payload (type '${node.type ?? typeof doc}')`);
  return '';
}
