// JQL AST — Sprint 010 real JQL engine.
// Clause-level types mirror Jira's structure so /jql/parse can serialise them.

export type JqlOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | '~'
  | '!~'
  | 'IN'
  | 'NOT IN'
  | 'IS'
  | 'IS NOT'
  | 'WAS'
  | 'WAS NOT'
  | 'CHANGED';

export interface JqlStringValue {
  kind: 'string';
  value: string;
  /** raw text as typed (unquoted values keep original case) */
  raw: string;
  position: number;
}

export interface JqlNumberValue {
  kind: 'number';
  value: number;
  raw: string;
  position: number;
}

/** Relative date like `-7d`, `2w`, `-1h` — resolved against the caller's clock. */
export interface JqlRelativeDate {
  kind: 'relative';
  amount: number; // signed
  unit: 's' | 'm' | 'h' | 'd' | 'w' | 'M' | 'y';
  raw: string;
  position: number;
}

export interface JqlFunctionValue {
  kind: 'function';
  name: string; // lower-cased
  args: string[];
  raw: string;
  position: number;
}

export interface JqlEmptyValue {
  kind: 'empty';
  position: number;
}

export type JqlOperand = JqlStringValue | JqlNumberValue | JqlRelativeDate | JqlFunctionValue | JqlEmptyValue;

export interface JqlListOperand {
  kind: 'list';
  items: JqlOperand[];
  position: number;
}

export interface JqlField {
  /** canonical field name (aliases resolved), e.g. `issuetype` */
  name: string;
  /** raw field text as typed */
  raw: string;
  position: number;
}

export interface JqlHistoryPredicate {
  /** from | to | before | after | on | during | by */
  kind: 'from' | 'to' | 'before' | 'after' | 'on' | 'during' | 'by';
  operands: JqlOperand[];
  position: number;
}

export interface JqlClauseCondition {
  type: 'condition';
  field: JqlField;
  operator: JqlOperator;
  operand: JqlOperand | JqlListOperand;
  /** 032 US2 — WAS/CHANGED predicate list (FROM/TO/BEFORE/AFTER/ON/DURING/BY) */
  history?: JqlHistoryPredicate[];
  position: number;
}

export interface JqlAnd {
  type: 'and';
  clauses: JqlClause[];
  position: number;
}

export interface JqlOr {
  type: 'or';
  clauses: JqlClause[];
  position: number;
}

export interface JqlNot {
  type: 'not';
  clause: JqlClause;
  position: number;
}

export type JqlClause = JqlClauseCondition | JqlAnd | JqlOr | JqlNot;

export interface JqlOrderItem {
  field: JqlField;
  direction: 'asc' | 'desc';
}

export interface JqlQuery {
  where: JqlClause | null;
  orderBy: JqlOrderItem[];
}
