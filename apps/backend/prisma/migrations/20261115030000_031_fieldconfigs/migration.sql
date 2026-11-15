CREATE TABLE "FieldConfiguration" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FieldConfiguration_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FieldConfigurationItem" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "defaultValue" JSONB,
    "rules" JSONB,
    CONSTRAINT "FieldConfigurationItem_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FieldConfigurationScheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultConfigId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FieldConfigurationScheme_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FieldConfigMapping" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "issueTypeId" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    CONSTRAINT "FieldConfigMapping_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Project" ADD COLUMN "fieldConfigurationSchemeId" TEXT;
CREATE UNIQUE INDEX "FieldConfiguration_name_key" ON "FieldConfiguration"("name");
CREATE UNIQUE INDEX "FieldConfigurationScheme_name_key" ON "FieldConfigurationScheme"("name");
CREATE UNIQUE INDEX "FieldConfigurationItem_configId_fieldId_key" ON "FieldConfigurationItem"("configId", "fieldId");
CREATE UNIQUE INDEX "FieldConfigMapping_schemeId_issueTypeId_key" ON "FieldConfigMapping"("schemeId", "issueTypeId");
ALTER TABLE "FieldConfigurationItem" ADD CONSTRAINT "FieldConfigurationItem_configId_fkey" FOREIGN KEY ("configId") REFERENCES "FieldConfiguration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FieldConfigurationScheme" ADD CONSTRAINT "FieldConfigurationScheme_defaultConfigId_fkey" FOREIGN KEY ("defaultConfigId") REFERENCES "FieldConfiguration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FieldConfigMapping" ADD CONSTRAINT "FieldConfigMapping_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "FieldConfigurationScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FieldConfigMapping" ADD CONSTRAINT "FieldConfigMapping_configId_fkey" FOREIGN KEY ("configId") REFERENCES "FieldConfiguration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FieldConfigMapping" ADD CONSTRAINT "FieldConfigMapping_issueTypeId_fkey" FOREIGN KEY ("issueTypeId") REFERENCES "IssueType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_fieldConfigurationSchemeId_fkey" FOREIGN KEY ("fieldConfigurationSchemeId") REFERENCES "FieldConfigurationScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
