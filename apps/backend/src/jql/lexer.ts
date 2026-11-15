// JQL lexer — tokens with 1-based column positions for Jira-style error messages.

export type TokenType =
  | 'WORD' // unquoted identifier / value (may include -, ., @, :, digits)
  | 'STRING' // "..." or '...'
  | 'NUMBER'
  | 'RELDATE' // -7d, 2w, -1h ...
  | 'OP' // = != > >= < <= ~ !~
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'EOF';

export interface Token {
  type: TokenType;
  /** raw text of the token */
  raw: string;
  /** decoded value for strings; raw otherwise */
  value: string;
  /** 1-based column where the token starts */
  position: number;
}

const RELDATE = /^[+-]?\d+[smhdwMy]/;

export class JqlSyntaxError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'empty',
  'null',
  'order',
  'by',
  'asc',
  'desc',
  'was',
  'changed',
  'from',
  'to',
  'before',
  'after',
  'on',
  'during',
]);

export function isReserved(word: string): boolean {
  return KEYWORDS.has(word.toLowerCase());
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    const start = i + 1; // 1-based column

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', raw: '(', value: '(', position: start });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', raw: ')', value: ')', position: start });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'COMMA', raw: ',', value: ',', position: start });
      i++;
      continue;
    }
    // operators
    if (ch === '!' && input[i + 1] === '~') {
      tokens.push({ type: 'OP', raw: '!~', value: '!~', position: start });
      i += 2;
      continue;
    }
    if (ch === '!' && input[i + 1] === '=') {
      tokens.push({ type: 'OP', raw: '!=', value: '!=', position: start });
      i += 2;
      continue;
    }
    if (ch === '=' || ch === '~') {
      tokens.push({ type: 'OP', raw: ch, value: ch, position: start });
      i++;
      continue;
    }
    if (ch === '>' || ch === '<') {
      const op = input[i + 1] === '=' ? ch + '=' : ch;
      tokens.push({ type: 'OP', raw: op, value: op, position: start });
      i += op.length;
      continue;
    }
    // quoted strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < n && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < n) {
          value += input[j + 1];
          j += 2;
          continue;
        }
        value += input[j];
        j++;
      }
      if (j >= n) {
        throw new JqlSyntaxError(`Unclosed quote starting at position ${start}.`, start);
      }
      const raw = input.slice(i, j + 1);
      tokens.push({ type: 'STRING', raw, value, position: start });
      i = j + 1;
      continue;
    }
    // relative dates must be tried before generic words/numbers
    const rel = RELDATE.exec(input.slice(i));
    if (rel) {
      tokens.push({ type: 'RELDATE', raw: rel[0], value: rel[0], position: start });
      i += rel[0].length;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?/.exec(input.slice(i));
      if (m) {
        tokens.push({ type: 'NUMBER', raw: m[0], value: m[0], position: start });
        i += m[0].length;
        continue;
      }
    }
    // words: letters, digits and the characters Jira allows bare in values
    const m = /^[^\s(),"'=<>!~]+/.exec(input.slice(i));
    if (m) {
      tokens.push({ type: 'WORD', raw: m[0], value: m[0], position: start });
      i += m[0].length;
      continue;
    }
    throw new JqlSyntaxError(`Unexpected character '${ch}'.`, start);
  }

  tokens.push({ type: 'EOF', raw: '', value: '', position: n + 1 });
  return tokens;
}
