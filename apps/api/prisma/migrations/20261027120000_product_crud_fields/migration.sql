-- Per-item category, image, and an updatedAt for in-dashboard CRUD editing.
ALTER TABLE "ProductCatalog" ADD COLUMN "category" TEXT;
ALTER TABLE "ProductCatalog" ADD COLUMN "imageUrl" TEXT;
-- NOT NULL with a default so any existing rows backfill cleanly; the app
-- (Prisma @updatedAt) maintains it from here.
ALTER TABLE "ProductCatalog" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
