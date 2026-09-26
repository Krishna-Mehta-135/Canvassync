-- AlterTable
ALTER TABLE "Room" ADD COLUMN "publicToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Room_publicToken_key" ON "Room"("publicToken");
