/**
 * 043 — Prisma client compat shim for the compiled (Node ESM) runtime.
 *
 * `@prisma/client`'s entry is CJS (`module.exports = {...require('.prisma/client/default')}`)
 * whose named exports Node's cjs-module-lexer cannot statically detect. That
 * means `import { PrismaClient } from '@prisma/client'` *typechecks* (the
 * .d.ts declares named exports) but throws `Named export not found` under
 * plain `node dist/`. tsx dev mode hides this by transpiling through esbuild's
 * interop helpers.
 *
 * Rule: `import type { Prisma }` (types, erased at emit) stays fine anywhere —
 * but any *runtime* value (PrismaClient, Prisma.sql/DbNull/JsonNull/…) must
 * come from this module.
 */
import { createRequire } from 'node:module';
import type * as PC from '@prisma/client';

const pkg = createRequire(import.meta.url)('@prisma/client') as typeof PC;

export const Prisma = pkg.Prisma;
export const PrismaClient = pkg.PrismaClient;
