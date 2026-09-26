-- CreateTable
CREATE TABLE "RoomSnapshot" (
    "id" SERIAL NOT NULL,
    "roomId" INTEGER NOT NULL,
    "shapes" JSONB NOT NULL,
    "shapeCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomSnapshot_roomId_createdAt_idx" ON "RoomSnapshot"("roomId", "createdAt");

-- AddForeignKey
ALTER TABLE "RoomSnapshot" ADD CONSTRAINT "RoomSnapshot_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
