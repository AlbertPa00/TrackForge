CREATE TABLE "Screen" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Screen_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ScreenTab" (
    "id" TEXT NOT NULL,
    "screenId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ScreenTab_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ScreenTabField" (
    "id" TEXT NOT NULL,
    "tabId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ScreenTabField_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ScreenScheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScreenScheme_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ScreenSchemeItem" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "screenId" TEXT NOT NULL,
    CONSTRAINT "ScreenSchemeItem_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "IssueTypeScreenScheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultSchemeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IssueTypeScreenScheme_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ScreenSchemeMapping" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "issueTypeId" TEXT NOT NULL,
    "screenSchemeId" TEXT NOT NULL,
    CONSTRAINT "ScreenSchemeMapping_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Project" ADD COLUMN "issueTypeScreenSchemeId" TEXT;
CREATE UNIQUE INDEX "Screen_name_key" ON "Screen"("name");
CREATE UNIQUE INDEX "ScreenScheme_name_key" ON "ScreenScheme"("name");
CREATE UNIQUE INDEX "IssueTypeScreenScheme_name_key" ON "IssueTypeScreenScheme"("name");
CREATE INDEX "ScreenTab_screenId_position_idx" ON "ScreenTab"("screenId", "position");
CREATE UNIQUE INDEX "ScreenTabField_tabId_fieldId_key" ON "ScreenTabField"("tabId", "fieldId");
CREATE UNIQUE INDEX "ScreenSchemeItem_schemeId_operation_key" ON "ScreenSchemeItem"("schemeId", "operation");
CREATE UNIQUE INDEX "ScreenSchemeMapping_schemeId_issueTypeId_key" ON "ScreenSchemeMapping"("schemeId", "issueTypeId");
ALTER TABLE "ScreenTab" ADD CONSTRAINT "ScreenTab_screenId_fkey" FOREIGN KEY ("screenId") REFERENCES "Screen"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenTabField" ADD CONSTRAINT "ScreenTabField_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "ScreenTab"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenSchemeItem" ADD CONSTRAINT "ScreenSchemeItem_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "ScreenScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenSchemeItem" ADD CONSTRAINT "ScreenSchemeItem_screenId_fkey" FOREIGN KEY ("screenId") REFERENCES "Screen"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueTypeScreenScheme" ADD CONSTRAINT "IssueTypeScreenScheme_defaultSchemeId_fkey" FOREIGN KEY ("defaultSchemeId") REFERENCES "ScreenScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScreenSchemeMapping" ADD CONSTRAINT "ScreenSchemeMapping_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "IssueTypeScreenScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenSchemeMapping" ADD CONSTRAINT "ScreenSchemeMapping_screenSchemeId_fkey" FOREIGN KEY ("screenSchemeId") REFERENCES "ScreenScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenSchemeMapping" ADD CONSTRAINT "ScreenSchemeMapping_issueTypeId_fkey" FOREIGN KEY ("issueTypeId") REFERENCES "IssueType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_issueTypeScreenSchemeId_fkey" FOREIGN KEY ("issueTypeScreenSchemeId") REFERENCES "IssueTypeScreenScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
