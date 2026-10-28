-- Business category on the tenant, chosen in the onboarding wizard.
ALTER TABLE "Tenant" ADD COLUMN "businessCategory" TEXT;

-- Structured product rows from a catalog CSV, tenant-scoped and tied to the
-- readable document the CSV is also ingested as (cascades on either delete).
CREATE TABLE "ProductCatalog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductCatalog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductCatalog_tenantId_idx" ON "ProductCatalog"("tenantId");
CREATE INDEX "ProductCatalog_tenantId_sku_idx" ON "ProductCatalog"("tenantId", "sku");

ALTER TABLE "ProductCatalog" ADD CONSTRAINT "ProductCatalog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductCatalog" ADD CONSTRAINT "ProductCatalog_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "TenantDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
