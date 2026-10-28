-- A tenant's own outbound SMTP. smtpPass holds AES-256-GCM ciphertext only.
CREATE TABLE "TenantSmtpConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpUser" TEXT NOT NULL,
    "smtpPass" TEXT NOT NULL,
    "smtpFrom" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantSmtpConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantSmtpConfig_tenantId_key" ON "TenantSmtpConfig"("tenantId");

ALTER TABLE "TenantSmtpConfig" ADD CONSTRAINT "TenantSmtpConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
