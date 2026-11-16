import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Lazy: env('DATABASE_URL') throws at config-load when unset, which breaks
    // `prisma generate` in image builds (no DB needed to generate the client).
    url: process.env.DATABASE_URL,
  },
});
