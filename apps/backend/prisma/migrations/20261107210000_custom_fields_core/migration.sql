-- Sprint 014: custom fields core (D19 registry, D10 JSONB values).

CREATE TABLE "CustomField" (
    "id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "searcherType" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "systemManaged" BOOLEAN NOT NULL DEFAULT false,
    "alias" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomField_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomFieldContext" (
    "id" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,

    "isGlobal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CustomFieldContext_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomFieldContextProject" (
    "contextId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "CustomFieldContextProject_pkey" PRIMARY KEY ("contextId","projectId")
);

CREATE TABLE "CustomFieldOption" (
    "id" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "parentId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "disabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CustomFieldOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomFieldValue" (
    "issueId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("issueId","fieldId")
);

CREATE UNIQUE INDEX "CustomField_seq_key" ON "CustomField"("seq");
CREATE UNIQUE INDEX "CustomField_name_key" ON "CustomField"("name");
CREATE UNIQUE INDEX "CustomField_alias_key" ON "CustomField"("alias");
CREATE INDEX "CustomField_active_idx" ON "CustomField"("active");
CREATE INDEX "CustomFieldContext_fieldId_idx" ON "CustomFieldContext"("fieldId");
CREATE INDEX "CustomFieldOption_contextId_position_idx" ON "CustomFieldOption"("contextId", "position");
CREATE INDEX "CustomFieldValue_fieldId_idx" ON "CustomFieldValue"("fieldId");
-- GIN on values (D10) for containment lookups; scalar eq/range go through
-- per-searcher expression indexes below.
CREATE INDEX "CustomFieldValue_value_gin" ON "CustomFieldValue" USING gin ("value");
CREATE INDEX "CustomFieldValue_num_idx" ON "CustomFieldValue" ("fieldId", ((value#>>'{}')::float8)) WHERE jsonb_typeof(value) = 'number';
CREATE INDEX "CustomFieldValue_text_idx" ON "CustomFieldValue" ("fieldId", (value#>>'{}')) WHERE jsonb_typeof(value) = 'string';

ALTER TABLE "CustomFieldContext" ADD CONSTRAINT "CustomFieldContext_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFieldContextProject" ADD CONSTRAINT "CustomFieldContextProject_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "CustomFieldContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFieldContextProject" ADD CONSTRAINT "CustomFieldContextProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFieldOption" ADD CONSTRAINT "CustomFieldOption_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "CustomFieldContext"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFieldOption" ADD CONSTRAINT "CustomFieldOption_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CustomFieldOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;
