-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "workflowSchemeId" TEXT;

-- CreateTable
CREATE TABLE "WorkflowScheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultWorkflowId" TEXT NOT NULL,

    CONSTRAINT "WorkflowScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowSchemeItem" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "issueTypeId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,

    CONSTRAINT "WorkflowSchemeItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowScheme_name_key" ON "WorkflowScheme"("name");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowSchemeItem_schemeId_issueTypeId_key" ON "WorkflowSchemeItem"("schemeId", "issueTypeId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workflowSchemeId_fkey" FOREIGN KEY ("workflowSchemeId") REFERENCES "WorkflowScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowScheme" ADD CONSTRAINT "WorkflowScheme_defaultWorkflowId_fkey" FOREIGN KEY ("defaultWorkflowId") REFERENCES "Workflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowSchemeItem" ADD CONSTRAINT "WorkflowSchemeItem_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "WorkflowScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowSchemeItem" ADD CONSTRAINT "WorkflowSchemeItem_issueTypeId_fkey" FOREIGN KEY ("issueTypeId") REFERENCES "IssueType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowSchemeItem" ADD CONSTRAINT "WorkflowSchemeItem_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
