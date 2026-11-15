-- Speech recognition model on the AI singleton — enables POST /ai/transcribe
-- (OpenAI-compatible /audio/transcriptions) and the copilot mic affordance.

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN "speechModel" TEXT NOT NULL DEFAULT '';
