/*
  Warnings:

  - You are about to drop the column `qrCode` on the `Child` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "public"."Child_qrCode_key";

-- AlterTable
ALTER TABLE "Child" DROP COLUMN "qrCode";
