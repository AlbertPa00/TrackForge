// JQL engine unit tests — lexer/parser AST + error positions.
// Corpus style: each [input, expectation] pair is a test case.

import { describe, it, expect } from 'vitest';
import { parseJql, JqlParseError } from '../../src/jql/parser.js';
import { tokenize } from '../../src/jql/lexer.js';
import type { JqlClauseCondition, JqlQuery } from '../../src/jql/ast.js';

function cond(q: JqlQuery): JqlClauseCondition {
  if (q.where?.type !== 'condition') throw new Error(`not a condition: ${JSON.stringify(q.where)}`);
  return q.where;
}

describe('lexer', () => {
  const cases: [string, string[]][] = [
    ['project = TF', ['WORD', 'OP', 'WORD', 'EOF']],
    ['status = "In Progress"', ['WORD', 'OP', 'STRING', 'EOF']],
    ['assignee != EMPTY', ['WORD', 'OP', 'WORD', 'EOF']],
    ['created >= -7d', ['WORD', 'OP', 'RELDATE', 'EOF']],
    ['key in (TF-1, TF-2)', ['WORD', 'WORD', 'LPAREN', 'WORD', 'COMMA', 'WORD', 'RPAREN', 'EOF']],
    ['a ~ "x" AND NOT b IS EMPTY', ['WORD', 'OP', 'STRING', 'WORD', 'WORD', 'WORD', 'WORD', 'WORD', 'EOF']],
    ['updated >= "2026-11-01 14:00"', ['WORD', 'OP', 'STRING', 'EOF']],
    ['f = fn(1, "x")', ['WORD', 'OP', 'WORD', 'LPAREN', 'NUMBER', 'COMMA', 'STRING', 'RPAREN', 'EOF']],
    ['summary !~ "bug"', ['WORD', 'OP', 'STRING', 'EOF']],
    ["p = 'v'", ['WORD', 'OP', 'STRING', 'EOF']],
  ];
  for (const [input, types] of cases) {
    it(`tokenizes ${input}`, () => {
      expect(tokenize(input).map((t) => t.type)).toEqual(types);
    });
  }
  it('unclosed quote errors', () => {
    expect(() => tokenize('summary ~ "oops')).toThrow(/Unclosed quote/);
  });
});

describe('parser — conditions', () => {
  it('single equality', () => {
    const c = cond(parseJql('project = TF'));
    expect(c.field.name).toBe('project');
    expect(c.operator).toBe('=');
    expect(c.operand).toMatchObject({ kind: 'string', value: 'TF' });
  });
  it('quoted value keeps case+spaces', () => {
    const c = cond(parseJql('status = "In Progress"'));
    expect(c.operand).toMatchObject({ kind: 'string', value: 'In Progress' });
  });
  it('alias resolution: type → issuetype', () => {
    expect(cond(parseJql('type = Bug')).field.name).toBe('issuetype');
  });
  it('alias: issuekey → key', () => {
    expect(cond(parseJql('issuekey = TF-1')).field.name).toBe('key');
  });
  it('alias: due → duedate', () => {
    expect(cond(parseJql('due <= -1d')).field.name).toBe('duedate');
  });
  it('label alias → labels', () => {
    expect(cond(parseJql('label = x')).field.name).toBe('labels');
  });
  it('!= operator', () => {
    expect(cond(parseJql('status != Done')).operator).toBe('!=');
  });
  it('> >= < <= operators', () => {
    for (const op of ['>', '>=', '<', '<='] as const) {
      expect(cond(parseJql(`created ${op} -1d`)).operator).toBe(op);
    }
  });
  it('~ and !~ on text fields', () => {
    expect(cond(parseJql('summary ~ "crash"')).operator).toBe('~');
    expect(cond(parseJql('text !~ "boring"')).operator).toBe('!~');
  });
  it('IN list', () => {
    const c = cond(parseJql('status IN ("To Do", "In Progress")'));
    expect(c.operator).toBe('IN');
    expect(c.operand).toMatchObject({ kind: 'list' });
    expect((c.operand as { items: unknown[] }).items).toHaveLength(2);
  });
  it('NOT IN list', () => {
    expect(cond(parseJql('priority NOT IN (High, Highest)')).operator).toBe('NOT IN');
  });
  it('IS EMPTY', () => {
    const c = cond(parseJql('assignee IS EMPTY'));
    expect(c.operator).toBe('IS');
    expect(c.operand.kind).toBe('empty');
  });
  it('IS NOT EMPTY', () => {
    expect(cond(parseJql('duedate IS NOT EMPTY')).operator).toBe('IS NOT');
  });
  it('IS NULL alias', () => {
    expect(cond(parseJql('reporter IS NULL')).operator).toBe('IS');
  });
  it('IS NOT NULL alias', () => {
    expect(cond(parseJql('resolution IS NOT NULL')).operator).toBe('IS NOT');
  });
  it('= EMPTY operand', () => {
    expect(cond(parseJql('assignee = EMPTY')).operand.kind).toBe('empty');
  });
  it('number operand', () => {
    expect(cond(parseJql('priority = 3')).operand).toMatchObject({ kind: 'number', value: 3 });
  });
  it('relative date operand', () => {
    const c = cond(parseJql('created >= -7d'));
    expect(c.operand).toMatchObject({ kind: 'relative', amount: -7, unit: 'd' });
  });
  it('positive relative date', () => {
    expect(cond(parseJql('duedate <= 2w')).operand).toMatchObject({ kind: 'relative', amount: 2, unit: 'w' });
  });
  it('function operand currentUser()', () => {
    const c = cond(parseJql('assignee = currentUser()'));
    expect(c.operand).toMatchObject({ kind: 'function', name: 'currentuser' });
  });
  it('function with arg startOfDay(-1)', () => {
    const c = cond(parseJql('created >= startOfDay(-1)'));
    expect(c.operand).toMatchObject({ kind: 'function', name: 'startofday', args: ['-1'] });
  });
  it('EMPTY inside IN list', () => {
    const c = cond(parseJql('assignee IN (ada, EMPTY)'));
    expect((c.operand as { items: { kind: string }[] }).items.map((i) => i.kind)).toEqual(['string', 'empty']);
  });
  it('issue key value', () => {
    expect(cond(parseJql('parent = TF-12')).operand).toMatchObject({ kind: 'string', value: 'TF-12' });
  });
});

describe('parser — boolean logic', () => {
  it('AND', () => {
    const q = parseJql('project = TF AND status = Done');
    expect(q.where?.type).toBe('and');
    expect((q.where as { clauses: unknown[] }).clauses).toHaveLength(2);
  });
  it('OR', () => {
    const q = parseJql('status = "To Do" OR status = Done');
    expect(q.where?.type).toBe('or');
  });
  it('implicit precedence: a OR b AND c → a OR (b AND c)', () => {
    const q = parseJql('status = A OR status = B AND priority = High');
    expect(q.where?.type).toBe('or');
    const right = (q.where as { clauses: { type: string }[] }).clauses[1];
    expect(right.type).toBe('and');
  });
  it('NOT binds tighter than AND: NOT a AND b', () => {
    const q = parseJql('NOT status = Done AND priority = High');
    expect(q.where?.type).toBe('and');
    const first = (q.where as { clauses: { type: string }[] }).clauses[0];
    expect(first.type).toBe('not');
  });
  it('parenthesised groups', () => {
    const q = parseJql('(status = A OR status = B) AND priority = High');
    expect(q.where?.type).toBe('and');
    const left = (q.where as { clauses: { type: string }[] }).clauses[0];
    expect(left.type).toBe('or');
  });
  it('NOT (a OR b)', () => {
    const q = parseJql('NOT (status = A OR status = B)');
    expect(q.where?.type).toBe('not');
  });
  it('double NOT', () => {
    const q = parseJql('NOT NOT status = Done');
    expect(q.where?.type).toBe('not');
    expect((q.where as { clause: { type: string } }).clause.type).toBe('not');
  });
  it('deep nesting', () => {
    const q = parseJql('a1 = 1 AND (b1 = 2 OR (c1 = 3 AND d1 = 4))'.replace(/a1|b1|c1|d1/g, 'status'));
    expect(q.where?.type).toBe('and');
  });
  it('three-way OR chain', () => {
    const q = parseJql('status = A OR status = B OR status = C');
    expect((q.where as { clauses: unknown[] }).clauses).toHaveLength(3);
  });
  it('mixed case keywords', () => {
    const q = parseJql('project = TF and status = Done Or priority = High');
    expect(q.where?.type).toBe('or');
  });
  it('single clause only → condition, not and()', () => {
    expect(parseJql('status = Done').where?.type).toBe('condition');
  });
});

describe('parser — ORDER BY', () => {
  it('single field default asc', () => {
    const q = parseJql('project = TF ORDER BY created');
    expect(q.orderBy.map((o) => [o.field.name, o.direction])).toEqual([['created', 'asc']]);
  });
  it('DESC', () => {
    expect(parseJql('project = TF ORDER BY updated DESC').orderBy[0].direction).toBe('desc');
  });
  it('ASC explicit', () => {
    expect(parseJql('project = TF ORDER BY created ASC').orderBy[0].direction).toBe('asc');
  });
  it('multi-field', () => {
    const q = parseJql('status = Done ORDER BY priority DESC, updated ASC, key');
    expect(q.orderBy.map((o) => [o.field.name, o.direction])).toEqual([
      ['priority', 'desc'],
      ['updated', 'asc'],
      ['key', 'asc'],
    ]);
  });
  it('rank is orderable', () => {
    expect(parseJql('project = TF ORDER BY rank').orderBy[0].field.name).toBe('rank');
  });
  it('ORDER BY without clause', () => {
    const q = parseJql('ORDER BY created DESC');
    expect(q.where).toBeNull();
    expect(q.orderBy[0].field.name).toBe('created');
  });
  it('rejects non-orderable field', () => {
    expect(() => parseJql('status = Done ORDER BY description')).toThrow(/cannot be used in ORDER BY/);
  });
  it('rejects unknown ORDER BY field', () => {
    expect(() => parseJql('x = 1 ORDER BY bogus')).toThrow(/does not exist/);
  });
  it('ORDER without BY errors', () => {
    expect(() => parseJql('status = Done ORDER created')).toThrow(/Expecting 'BY'/);
  });
});

describe('parser — errors', () => {
  const bad: [string, RegExp][] = [
    ['', /empty/i],
    ['   ', /empty/i],
    ['1 = 1', /Expecting a field name/], // unknown names parse as cf refs; existence is checked at compile time
    ['status', /Expecting operator/],
    ['status =', /Expecting a value/],
    ['status = Done extra', /Expecting 'AND' or 'OR'/],
    ['status Done', /Expecting operator/],
    ['status = = x', /Expecting a value/],
    ['status IN ()', /Empty value list/],
    ['status IN (a,)', /Expecting a value/],
    ['status IN', /Expecting a value/],
    ['(status = Done', /Expecting '\)'/],
    ['status = Done)', /Expecting 'AND' or 'OR'/],
    ['NOT', /Expecting a field name/],
    ['status = Done AND', /Expecting a field name/],
    ['status > Done', /operator '>' is not supported by the 'status' field/],
    ['summary = x', /operator '=' is not supported by the 'summary' field/],
    ['created ~ x', /operator '~' is not supported/],
    ['status IS EMPTY', /does not support the 'IS EMPTY'/],
    ['created IS EMPTY', /does not support/],
    ['project IS EMPTY', /does not support/],
    ['status = AND', /reserved JQL word/],
    ['status = OR', /reserved JQL word/],
    ['status WOULD "Done"', /Expecting operator/], // WAS is a valid operator (032); WOULD is not
    ['status = f(', /Expecting/],
    ['key = ', /Expecting a value/],
    ['AND status = Done', /Expecting a field name/],
    ['OR status = Done', /Expecting a field name/],
    ['status ~ x', /operator '~' is not supported by the 'status' field/],
    ['project = TF, MOB', /Expecting 'AND' or 'OR'/],
  ];
  for (const [input, re] of bad) {
    it(`rejects: ${JSON.stringify(input)}`, () => {
      expect(() => parseJql(input)).toThrow(re);
    });
  }
  it('error carries position', () => {
    try {
      parseJql('status = Done bogus');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JqlParseError);
      const e = err as JqlParseError;
      expect(e.position).toBe(15);
      expect(e.message).toContain('line 1, character 15');
    }
  });
  it('error for bad operator includes position', () => {
    try {
      parseJql('project = TF garbage = x');
    } catch (err) {
      const e = err as JqlParseError;
      expect(e.position).toBeGreaterThan(0);
    }
  });
  it('reserved-word value error suggests quoting', () => {
    try {
      parseJql('status = AND');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('Quote it');
    }
  });
});

describe('parser — corpus of real-world JQL', () => {
  const valid: string[] = [
    'project = TF',
    'project IN (TF, MOB, OPS)',
    'assignee = currentUser()',
    'assignee != currentUser()',
    'assignee IS EMPTY',
    'assignee IS NOT EMPTY',
    'reporter = ada@trackforge.local',
    'status = "In Progress" AND priority = High',
    'statusCategory = Done',
    'statusCategory != Done',
    'resolution = Unresolved',
    'resolution IS EMPTY',
    'labels = frontend',
    'labels IN (bug, regression)',
    'labels IS EMPTY',
    'parent = TF-1',
    'parent IS EMPTY',
    'key = TF-42',
    'key IN (TF-1, TF-2, MOB-7)',
    'summary ~ "login timeout"',
    'description ~ crash',
    'text ~ "connection refused"',
    'comment ~ workaround',
    'summary !~ stale',
    'created >= -7d',
    'created >= "2026-11-01"',
    'updated < "2026-10-15 09:30"',
    'resolved >= startOfWeek()',
    'duedate <= endOfMonth()',
    'duedate IS NOT EMPTY AND duedate <= 7d',
    'created >= -1h',
    'created >= -2w',
    'issuetype = Sub-task',
    'issuetype IN (Bug, Story, Task)',
    'priority IN (High, Highest) AND statusCategory = "In Progress"',
    'project = TF AND assignee = currentUser() AND status != Done ORDER BY priority DESC',
    'status = "To Do" OR status = "In Progress" AND assignee = EMPTY',
    '(status = A OR status = B) AND (assignee = x OR assignee IS EMPTY)'.replace(/ = A| = B| = x/g, ' = "v"'),
    'NOT status = Done',
    'NOT (status = Done AND resolution = "Won\'t Fix")',
    'project = TF AND text ~ "panic" ORDER BY created DESC',
    'assignee = currentUser() OR reporter = currentUser()',
    'key > TF-10 AND key <= TF-20',
    'project = TF ORDER BY key',
    'ORDER BY updated DESC',
    'status = Done ORDER BY resolved DESC',
    'project = TF AND summary ~ bug AND labels IS NOT EMPTY',
    'type = Epic AND statusCategory != Done',
    'duedate < now() AND statusCategory != Done',
    'created >= startOfMonth(-1) AND created < startOfMonth()',
    'updated >= endOfDay(-1)',
    'assignee IN (ada, grace, currentUser())',
    'project != MOB AND statusCategory = "To Do"',
    'project NOT IN (MOB, OPS)',
    'parent IN (TF-1, TF-2)',
  ];
  for (const jql of valid) {
    it(`parses: ${jql}`, () => {
      expect(() => parseJql(jql)).not.toThrow();
    });
  }
});
