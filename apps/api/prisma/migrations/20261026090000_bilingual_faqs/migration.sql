-- Bilingual FAQ starter questions: Hindi variants alongside the English ones,
-- index-aligned with "supportFaqs" / "salesFaqs". Additive and non-breaking:
-- existing rows get empty arrays and keep serving their English questions.
ALTER TABLE "TenantFaq" ADD COLUMN "supportFaqsHi" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "TenantFaq" ADD COLUMN "salesFaqsHi" TEXT[] DEFAULT ARRAY[]::TEXT[];
