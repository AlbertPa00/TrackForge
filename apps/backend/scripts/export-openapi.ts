// Docs site build — serialize the served OpenAPI doc to a static file so the
// public docs site can render it (Scalar at /api). Same source as
// GET /api/internal/docs/openapi.json — never a copy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '../src/lib/openapi.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, '../../../docs/public/openapi.json'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
console.log(`openapi → ${out}`);
