// JQL parser — recursive descent producing the AST in ast.ts.
// Errors mimic Jira wording: "Error in the JQL Query: ... (line 1, character N)".

import { tokenize, type Token, JqlSyntaxError, isReserved } from './lexer.js';
import { lookupField, ORDERABLE_FIELDS } from './fields.js';
import type { JqlClause, JqlField, JqlOperand, JqlListOperand, JqlOperator, JqlOrderItem, JqlQuery } from './ast.js';

export class JqlParseError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(`Error in the JQL Query: ${message} (line 1, character ${position})`);
    this.position = position;
  }
}

const KW = (t: Token, kw: string) => t.type === 'WORD' && t.value.toLowerCase() === kw;
const isKw = (t: Token) => t.type === 'WORD' && isReserved(t.value);

class Parser {
  private tokens: Token[];
  private pos = 0;
  private depth = 0;
  private clauseCount = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private at(type: Token['type']): boolean {
    return this.peek().type === type;
  }
  private atKw(kw: string): boolean {
    return KW(this.peek(), kw);
  }
  private expect(type: Token['type'], what: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new JqlParseError(`Expecting ${what} but got '${t.raw || 'EOF'}'.`, t.position);
    }
    return this.next();
  }

  parse(): JqlQuery {
    if (this.at('EOF')) {
      throw new JqlParseError('The JQL query is empty.', 1);
    }
    const where = this.atKw('order') ? null : this.parseOr();
    const orderBy: JqlOrderItem[] = [];
    if (this.atKw('order')) {
      this.next();
      const by = this.peek();
      if (!KW(by, 'by')) {
        throw new JqlParseError(`Expecting 'BY' but got '${by.raw || 'EOF'}'.`, by.position);
      }
      this.next();
      for (;;) {
        const t = this.peek();
        if (
          t.type === 'STRING' ||
          (t.type === 'WORD' && (/^cf\[\d+\]$/i.test(t.value) || /^customfield_\d+$/i.test(t.value)))
        ) {
          // cf[10042] / "Risk Level" — orderability validated by the compiler.
          this.next();
          const f: JqlField = { name: 'cf', raw: t.value, position: t.position };
          let direction: 'asc' | 'desc' = 'asc';
          if (this.atKw('asc')) {
            this.next();
          } else if (this.atKw('desc')) {
            this.next();
            direction = 'desc';
          }
          orderBy.push({ field: f, direction });
          if (!this.at('COMMA')) break;
          this.next();
          continue;
        }
        if (t.type !== 'WORD') {
          throw new JqlParseError(`Expecting a field name but got '${t.raw || 'EOF'}'.`, t.position);
        }
        this.next();
        const canonical = ORDERABLE_FIELDS.get(t.value.toLowerCase());
        if (!canonical) {
          if (lookupField(t.value)) {
            throw new JqlParseError(`Field '${t.value}' cannot be used in ORDER BY.`, t.position);
          }
          throw new JqlParseError(
            `Field '${t.value}' does not exist or you do not have permission to view it.`,
            t.position
          );
        }
        const f: JqlField = { name: canonical, raw: t.value, position: t.position };
        let direction: 'asc' | 'desc' = 'asc';
        if (this.atKw('asc')) {
          this.next();
        } else if (this.atKw('desc')) {
          this.next();
          direction = 'desc';
        }
        orderBy.push({ field: f, direction });
        if (!this.at('COMMA')) break;
        this.next();
      }
    }
    const t = this.peek();
    if (t.type !== 'EOF') {
      throw new JqlParseError(`Expecting 'AND' or 'OR' but got '${t.raw}'.`, t.position);
    }
    return { where, orderBy };
  }

  private parseOr(): JqlClause | null {
    const first = this.parseAnd();
    const clauses = [first];
    while (this.atKw('or')) {
      this.next();
      if (++this.clauseCount > MAX_CLAUSES) {
        throw new JqlParseError(`JQL exceeds the ${MAX_CLAUSES}-clause limit.`, this.peek().position);
      }
      clauses.push(this.parseAnd());
    }
    if (clauses.length === 1) return first;
    return { type: 'or', clauses, position: first?.position ?? 1 };
  }

  private parseAnd(): JqlClause {
    const first = this.parseNot();
    const clauses = [first];
    while (this.atKw('and')) {
      this.next();
      if (++this.clauseCount > MAX_CLAUSES) {
        throw new JqlParseError(`JQL exceeds the ${MAX_CLAUSES}-clause limit.`, this.peek().position);
      }
      clauses.push(this.parseNot());
    }
    if (clauses.length === 1) return first;
    return { type: 'and', clauses, position: first.position };
  }

  private parseNot(): JqlClause {
    if (this.atKw('not')) {
      const t = this.next();
      return { type: 'not', clause: this.parseNot(), position: t.position };
    }
    if (this.at('LPAREN')) {
      const open = this.next();
      // 064 US6 — recursion budget: deep nesting `((((…))))` must fail fast.
      if (++this.depth > MAX_DEPTH) {
        throw new JqlParseError(`JQL exceeds the ${MAX_DEPTH}-level nesting limit.`, open.position);
      }
      // look ahead: is this a clause group or an operand list?
      // operand lists only appear after IN — parseOr handles clauses.
      const clause = this.parseOr();
      this.depth--;
      this.expect('RPAREN', "')'");
      if (clause === null) {
        throw new JqlParseError('Empty parentheses are not allowed.', open.position);
      }
      return clause;
    }
    return this.parseCondition();
  }

  private parseFieldName(context: string): JqlField {
    const t = this.peek();
    // Quoted field names resolve at compile time (custom fields like "Risk Level").
    if (t.type === 'STRING') {
      this.next();
      return { name: 'cf', raw: t.value, position: t.position };
    }
    if (t.type !== 'WORD') {
      throw new JqlParseError(`Expecting a field name but got '${t.raw || 'EOF'}'.`, t.position);
    }
    this.next();
    if (isKw(t) && !KW(t, 'empty') && !KW(t, 'null')) {
      throw new JqlParseError(`Expecting a field name but got '${t.value}'.`, t.position);
    }
    // cf[10042] → custom-field reference resolved by the compiler.
    if (/^cf\[\d+\]$/i.test(t.value) || /^customfield_\d+$/i.test(t.value)) {
      return { name: 'cf', raw: t.value, position: t.position };
    }
    const def = lookupField(t.value);
    if (!def) {
      // 032 US3 — unknown names defer to the compiler's CF-name/alias resolution
      // ("Flagged", "Risk Level" unquoted); it throws the same not-found error.
      if (context === 'WHERE') {
        return { name: 'cf', raw: t.value, position: t.position };
      }
      throw new JqlParseError(
        `Field '${t.value}' does not exist or you do not have permission to view it.`,
        t.position
      );
    }
    if (context === 'ORDER BY' && !def.orderable) {
      // defer: caller also checks ORDERABLE_FIELDS map for aliases like rank
    }
    return { name: def.name, raw: t.value, position: t.position };
  }

  private parseCondition(): JqlClause {
    const field = this.parseFieldName('WHERE');
    // cf references defer operator/nullable validation to the compiler (per-type).
    const def = field.name === 'cf' ? null : lookupField(field.raw)!;
    const t = this.peek();

    // IS [NOT] EMPTY|NULL
    if (KW(t, 'is')) {
      this.next();
      let negated = false;
      if (KW(this.peek(), 'not')) {
        this.next();
        negated = true;
      }
      const v = this.peek();
      if (!KW(v, 'empty') && !KW(v, 'null')) {
        throw new JqlParseError(`Expecting 'EMPTY' or 'NULL' but got '${v.raw || 'EOF'}'.`, v.position);
      }
      this.next();
      if (def && !def.nullable) {
        throw new JqlParseError(
          `The field '${def.name}' does not support the 'IS ${negated ? 'NOT ' : ''}EMPTY' operator.`,
          t.position
        );
      }
      return {
        type: 'condition',
        field,
        operator: negated ? 'IS NOT' : 'IS',
        operand: { kind: 'empty', position: v.position },
        position: field.position,
      };
    }

    // 032 US2 — history operators: WAS [NOT] [IN] operand [predicates] / CHANGED [predicates]
    if (KW(t, 'was') || KW(t, 'changed')) {
      this.next();
      let operator: JqlOperator;
      let operand: JqlOperand | JqlListOperand = { kind: 'empty', position: t.position };
      if (KW(t, 'was')) {
        let negated = false;
        if (KW(this.peek(), 'not')) {
          this.next();
          negated = true;
        }
        operator = negated ? 'WAS NOT' : 'WAS';
        if (KW(this.peek(), 'in')) {
          this.next();
          operand = this.parseOperand('IN', field.position);
        } else {
          operand = this.parseSingleOperand();
        }
      } else {
        operator = 'CHANGED';
      }
      if (def && !def.operators.includes(operator)) {
        throw new JqlParseError(`The operator '${operator}' is not supported by the '${def.name}' field.`, t.position);
      }
      const history = this.parseHistoryPredicates(operator);
      return { type: 'condition', field, operator, operand, history, position: field.position };
    }

    // comparison operators
    let operator: JqlOperator | null = null;
    if (t.type === 'OP') {
      this.next();
      operator = t.value as JqlOperator;
    } else if (KW(t, 'in')) {
      this.next();
      operator = 'IN';
    } else if (KW(t, 'not')) {
      this.next();
      const nt = this.peek();
      if (!KW(nt, 'in')) {
        throw new JqlParseError(`Expecting 'IN' after 'NOT' but got '${nt.raw || 'EOF'}'.`, nt.position);
      }
      this.next();
      operator = 'NOT IN';
    } else {
      throw new JqlParseError(`Expecting operator but got '${t.raw || 'EOF'}'.`, t.position);
    }

    if (def && !def.operators.includes(operator)) {
      throw new JqlParseError(`The operator '${operator}' is not supported by the '${def.name}' field.`, t.position);
    }

    const operand = this.parseOperand(operator, field.position);
    return {
      type: 'condition',
      field,
      operator,
      operand,
      position: field.position,
    };
  }

  private parseHistoryPredicates(operator: JqlOperator) {
    const preds: import('./ast.js').JqlHistoryPredicate[] = [];
    const saw = new Set<string>();
    for (;;) {
      const p = this.peek();
      const kind = KW(p, 'from')
        ? 'from'
        : KW(p, 'to')
          ? 'to'
          : KW(p, 'before')
            ? 'before'
            : KW(p, 'after')
              ? 'after'
              : KW(p, 'on')
                ? 'on'
                : KW(p, 'during')
                  ? 'during'
                  : KW(p, 'by')
                    ? 'by'
                    : null;
      if (!kind) break;
      this.next();
      if (operator !== 'CHANGED' && (kind === 'from' || kind === 'to')) {
        throw new JqlParseError(
          `The '${kind.toUpperCase()}' predicate is not supported for the '${operator}' operator.`,
          p.position
        );
      }
      if (saw.has(kind)) {
        throw new JqlParseError(`The '${kind.toUpperCase()}' predicate was already specified.`, p.position);
      }
      saw.add(kind);
      if (kind === 'during') {
        this.expect('LPAREN', "'('");
        const a = this.parseSingleOperand();
        this.expect('COMMA', "','");
        const b = this.parseSingleOperand();
        this.expect('RPAREN', "')'");
        preds.push({ kind, operands: [a, b], position: p.position });
      } else {
        preds.push({ kind, operands: this.parsePredicateValues(), position: p.position });
      }
    }
    return preds;
  }

  private parsePredicateValues(): JqlOperand[] {
    if (this.at('LPAREN')) {
      const open = this.next();
      const items: JqlOperand[] = [];
      if (this.at('RPAREN')) {
        throw new JqlParseError('Empty value list is not allowed.', open.position);
      }
      for (;;) {
        items.push(this.parseSingleOperand());
        if (this.at('COMMA')) {
          this.next();
          if (this.at('RPAREN')) {
            throw new JqlParseError(`Expecting a value but got ')'.`, this.peek().position);
          }
          continue;
        }
        break;
      }
      this.expect('RPAREN', "')'");
      return items;
    }
    return [this.parseSingleOperand()];
  }

  private parseOperand(operator: JqlOperator, fieldPos: number): JqlOperand | JqlListOperand {
    if ((operator === 'IN' || operator === 'NOT IN') && this.at('LPAREN')) {
      const open = this.next();
      const items: JqlOperand[] = [];
      if (this.at('RPAREN')) {
        throw new JqlParseError('Empty value list is not allowed.', open.position);
      }
      for (;;) {
        items.push(this.parseSingleOperand());
        if (items.length > MAX_LIST_ITEMS) {
          throw new JqlParseError(`JQL value list exceeds the ${MAX_LIST_ITEMS}-item limit.`, open.position);
        }
        if (this.at('COMMA')) {
          this.next();
          if (this.at('RPAREN')) {
            throw new JqlParseError(`Expecting a value but got ')'.`, this.peek().position);
          }
          continue;
        }
        break;
      }
      this.expect('RPAREN', "')'");
      return { kind: 'list', items, position: open.position };
    }
    if (this.at('LPAREN')) {
      // Jira allows = (a, b) as a list for = too
      const open = this.next();
      const items: JqlOperand[] = [];
      if (this.at('RPAREN')) {
        throw new JqlParseError('Empty value list is not allowed.', open.position);
      }
      for (;;) {
        items.push(this.parseSingleOperand());
        if (items.length > MAX_LIST_ITEMS) {
          throw new JqlParseError(`JQL value list exceeds the ${MAX_LIST_ITEMS}-item limit.`, open.position);
        }
        if (this.at('COMMA')) {
          this.next();
          continue;
        }
        break;
      }
      this.expect('RPAREN', "')'");
      return { kind: 'list', items, position: open.position };
    }
    void fieldPos;
    return this.parseSingleOperand();
  }

  private parseSingleOperand(): JqlOperand {
    const t = this.peek();
    switch (t.type) {
      case 'STRING':
        this.next();
        return { kind: 'string', value: t.value, raw: t.raw, position: t.position };
      case 'NUMBER':
        this.next();
        return { kind: 'number', value: Number(t.value), raw: t.raw, position: t.position };
      case 'RELDATE': {
        this.next();
        const m = /^([+-]?\d+)([smhdwMy])$/.exec(t.value)!;
        return {
          kind: 'relative',
          amount: Number(m[1]),
          unit: m[2] as 's' | 'm' | 'h' | 'd' | 'w' | 'M' | 'y',
          raw: t.raw,
          position: t.position,
        };
      }
      case 'WORD': {
        this.next();
        // function call?
        if (this.at('LPAREN')) {
          this.next();
          const args: string[] = [];
          if (!this.at('RPAREN')) {
            for (;;) {
              const a = this.next();
              if (a.type === 'COMMA' || a.type === 'RPAREN' || a.type === 'EOF') {
                throw new JqlParseError(`Expecting a function argument but got '${a.raw || 'EOF'}'.`, a.position);
              }
              args.push(a.value);
              if (this.at('COMMA')) {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expect('RPAREN', "')'");
          return {
            kind: 'function',
            name: t.value.toLowerCase(),
            args,
            raw: `${t.value}(${args.join(',')})`,
            position: t.position,
          };
        }
        if (isKw(t) && !KW(t, 'empty') && !KW(t, 'null')) {
          throw new JqlParseError(
            `'${t.value}' is a reserved JQL word. Quote it (e.g. "${t.value}") to use it as a value.`,
            t.position
          );
        }
        if (KW(t, 'empty') || KW(t, 'null')) {
          return { kind: 'empty', position: t.position };
        }
        return { kind: 'string', value: t.value, raw: t.raw, position: t.position };
      }
      default:
        throw new JqlParseError(`Expecting a value but got '${t.raw || 'EOF'}'.`, t.position);
    }
  }
}

/** 064 US6 — complexity budgets: bound input size before lexing so a giant
 * `in (...)` or deeply-nested expression can't fan out into unbounded DB work
 * or parser recursion. */
const MAX_JQL_LEN = 10_000;
const MAX_CLAUSES = 500;
const MAX_DEPTH = 50;
const MAX_LIST_ITEMS = 500;

export function parseJql(input: string): JqlQuery {
  if (input.length > MAX_JQL_LEN) {
    throw new JqlParseError(`JQL exceeds the ${MAX_JQL_LEN}-character limit.`, 0);
  }
  try {
    return new Parser(input).parse();
  } catch (err) {
    if (err instanceof JqlParseError) throw err;
    if (err instanceof JqlSyntaxError) {
      throw new JqlParseError(err.message, err.position);
    }
    throw err;
  }
}
