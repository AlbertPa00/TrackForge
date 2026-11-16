import 'dotenv/config';
import { PrismaClient } from './lib/pc.js';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 — the client no longer reads the datasource url; connections go
// through a driver adapter. dotenv keeps `tsx dev`/scripts picking up .env the
// way prisma-client-js's auto-load used to (vitest sets DATABASE_URL itself;
// dotenv never overrides existing vars).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

export const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });
