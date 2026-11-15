/**
 * Sprint 040: /rest/api/3 wire transform — the same routers serve v2 and v3;
 * this middleware converts ADF ⇄ markdown at the boundary (D6: canonical
 * store stays markdown, ADF is wire format only).
 *
 * Inbound : any {type:'doc'} node in the request body → markdown string.
 * Outbound: issue `fields.description|environment`, comment `body` → ADF doc;
 *           `expand=renderedFields` adds sanitized HTML renderings.
 * Losses  : unsupported inbound nodes surface via x-trackforge-adf-losses
 *           (non-production only — never silent).
 */
import type { NextFunction, Request, Response } from 'express';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { adfToMarkdown } from '../import/adfToMarkdown.js';
import { markdownToAdf, isAdfDoc } from './markdownToAdf.js';

marked.setOptions({ gfm: true, breaks: false });
const renderMd = (md: string) =>
  sanitizeHtml(marked.parse(md) as string, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'details', 'summary']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt', 'title'] },
  });

/** Recursively convert every ADF doc node in a body to markdown. */
function inbound(node: unknown, losses: string[]): unknown {
  if (isAdfDoc(node)) return adfToMarkdown(node, (m) => losses.push(m));
  if (Array.isArray(node)) return node.map((v) => inbound(v, losses));
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = inbound(v, losses);
    return out;
  }
  return node;
}

const looksComment = (o: Record<string, unknown>) =>
  typeof o.body === 'string' && ('author' in o || 'updateAuthor' in o || 'jsdPublic' in o);

/** Outbound: markdown strings → ADF docs; renderedFields on expand. */
function outbound(node: unknown, rendered: boolean): unknown {
  if (Array.isArray(node)) return node.map((v) => outbound(v, rendered));
  if (!node || typeof node !== 'object') return node;
  const o = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = outbound(v, rendered);

  // issue-shaped node: has fields{}
  const fields = out.fields as Record<string, unknown> | undefined;
  if (fields && typeof fields === 'object') {
    const rf: Record<string, unknown> = {};
    for (const name of ['description', 'environment'] as const) {
      if (typeof fields[name] === 'string') {
        const md = fields[name] as string;
        fields[name] = markdownToAdf(md);
        if (rendered) rf[name] = renderMd(md);
      }
    }
    if (rendered && Object.keys(rf).length && !out.renderedFields) out.renderedFields = rf;
  }
  // comment-shaped node
  if (looksComment(out)) {
    const md = out.body as string;
    out.body = markdownToAdf(md);
    if (rendered && !out.renderedBody) out.renderedBody = renderMd(md);
  }
  return out;
}

export function adfWire(req: Request, res: Response, next: NextFunction): void {
  const rendered = String(req.query.expand ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes('renderedFields');
  // inbound ADF → markdown before the v2 handlers see the body
  if (req.body && typeof req.body === 'object') {
    const losses: string[] = [];
    req.body = inbound(req.body, losses);
    if (losses.length && process.env.NODE_ENV !== 'production') {
      res.setHeader('x-trackforge-adf-losses', losses.join(' | ').slice(0, 800));
    }
  }
  const origJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400) return origJson(body);
    try {
      return origJson(outbound(body, rendered));
    } catch {
      return origJson(body);
    } // never let the wire transform break a response
  };
  next();
}
