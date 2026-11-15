-- 069 — track provider-reported spend: OpenRouter returns `usage.cost` on
-- chat/embeddings/transcriptions responses; 0 when the provider doesn't say.
ALTER TABLE "AiUsage" ADD COLUMN "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
