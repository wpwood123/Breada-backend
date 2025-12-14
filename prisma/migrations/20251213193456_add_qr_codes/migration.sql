/*
  Warnings:

  - A unique constraint covering the columns `[qrCodeId]` on the table `Child` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Child" ADD COLUMN     "qrCodeId" TEXT;

-- CreateTable
CREATE TABLE "QrCode" (
    "id" TEXT NOT NULL,
    "printed" BOOLEAN NOT NULL DEFAULT false,
    "childId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QrCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QrCode_childId_key" ON "QrCode"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "Child_qrCodeId_key" ON "Child"("qrCodeId");

-- AddForeignKey
ALTER TABLE "QrCode" ADD CONSTRAINT "QrCode_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE SET NULL ON UPDATE CASCADE;
