-- The email provider chosen in the dashboard (gmail | outlook | null).
ALTER TABLE "TenantSmtpConfig" ADD COLUMN "provider" TEXT;
