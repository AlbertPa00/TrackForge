/**
 * Sprint 040: markdown → ADF (the wire direction; canonical store stays
 * markdown per D6). Mirrors adfToMarkdown's supported node set so
 * md → ADF → md round-trips for: paragraphs, headings, bullet/ordered
 * lists, codeBlock, blockquote, rule, tables, hardBreak, bold/italic/
 * strike/code/link marks, mentions ([~accountId:] → mention node).
 */

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}
interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

const para = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const text = (t: string, marks?: AdfMark[]): AdfNode => ({
  type: 'text',
  text: t,
  ...(marks?.length ? { marks } : {}),
});

/** Strip the markdown escapes adfToMarkdown writes (\* \_ \[ \~ …). */
const unescape = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');

/** Parse inline markdown into ADF text/mention/hardBreak nodes with marks. */
function inline(s: string): AdfNode[] {
  const out: AdfNode[] = [];
  // tokens: [~acct:] mention | [text](url) link | `code` | **bold** | *italic* | ~~strike~~
  const re =
    /\[~([^\]]+)\]|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|(  +(?=\n)|\\n)/g;
  let last = 0;
  const push = (t: string) => {
    if (t) out.push(text(unescape(t)));
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    push(s.slice(last, m.index));
    if (m[1] !== undefined) out.push({ type: 'mention', attrs: { id: m[1].replace(/^accountId:/, '') } });
    else if (m[2] !== undefined) out.push(text(unescape(m[2]), [{ type: 'link', attrs: { href: m[3] } }]));
    else if (m[4] !== undefined) out.push(text(m[4], [{ type: 'code' }]));
    else if (m[5] !== undefined) out.push(text(unescape(m[5]), [{ type: 'strong' }]));
    else if (m[6] !== undefined) out.push(text(unescape(m[6]), [{ type: 'em' }]));
    else if (m[7] !== undefined) out.push(text(unescape(m[7]), [{ type: 'strike' }]));
    else out.push({ type: 'hardBreak' });
    last = m.index + m[0].length;
  }
  push(s.slice(last));
  return out;
}

/** | a | b | table rows → ADF table (header row auto-detected on ---). */
function table(lines: string[]): AdfNode {
  const rows: AdfNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].replace(/^\||\|$/g, '').split('|');
    const isHeader = i === 0 && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '');
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i]) && i > 0) continue; // separator
    rows.push({
      type: 'tableRow',
      content: cells.map((c) => ({
        type: isHeader ? 'tableHeader' : 'tableCell',
        content: [para(...inline(c.trim()))],
      })),
    });
  }
  return { type: 'table', content: rows };
}

/** markdown text → ADF doc node. */
export function markdownToAdf(md: string | null | undefined): AdfNode {
  if (!md || !md.trim()) return { type: 'doc', version: 1, content: [para()] };
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const content: AdfNode[] = [];
  let i = 0;
  const isFence = (l: string) => /^```/.test(l.trim());
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    if (isFence(line)) {
      const lang = t.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      content.push({ type: 'codeBlock', attrs: lang ? { language: lang } : {}, content: [text(buf.join('\n'))] });
      continue;
    }
    if (/^(---+|\*\*\*+|___+)\s*$/.test(t)) {
      content.push({ type: 'rule' });
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      content.push({ type: 'heading', attrs: { level: h[1].length }, content: inline(h[2]) });
      i++;
      continue;
    }
    if (/^>\s?/.test(t)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) buf.push(lines[i++].trim().replace(/^>\s?/, ''));
      content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inline(buf.join('  \n')) }] });
      continue;
    }
    if (/^[-*+]\s+/.test(t)) {
      const items: AdfNode[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push({ type: 'listItem', content: [para(...inline(lines[i++].trim().replace(/^[-*+]\s+/, '')))] });
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      const items: AdfNode[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push({ type: 'listItem', content: [para(...inline(lines[i++].trim().replace(/^\d+[.)]\s+/, '')))] });
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }
    if (isTableRow(line)) {
      const buf: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) buf.push(lines[i++]);
      content.push(table(buf));
      continue;
    }
    // paragraph: consume until blank/structural line; '  ' EOL → hardBreak
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFence(lines[i]) &&
      !isTableRow(lines[i]) &&
      !/^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|---+\s*$)/.test(lines[i].trim())
    )
      buf.push(lines[i++]);
    content.push(para(...inline(buf.join('  \n'))));
  }
  return { type: 'doc', version: 1, content: content.length ? content : [para()] };
}

/** True if `v` looks like an ADF doc ({type:'doc', content:[...]}). */
export function isAdfDoc(v: unknown): v is AdfNode {
  return !!v && typeof v === 'object' && (v as AdfNode).type === 'doc' && Array.isArray((v as AdfNode).content);
}
