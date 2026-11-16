/**
 * 043 — single import surface for Prisma runtime values + types.
 *
 * Prisma 7's `prisma-client` generator emits the client as ESM TypeScript
 * under `src/generated/prisma/` — the v5 `.prisma/client` CJS entry this shim
 * existed to work around no longer exists at all. App code keeps one stable
 * specifier (`lib/pc.js`) for runtime values (PrismaClient, Prisma, enums,
 * DbNull/JsonNull) and model types alike.
 */
export * from '../generated/prisma/client.js';
