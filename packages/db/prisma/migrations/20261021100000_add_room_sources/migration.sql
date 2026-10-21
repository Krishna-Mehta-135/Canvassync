-- CreateTable
CREATE TABLE "RoomSource" (
    "id" SERIAL NOT NULL,
    "roomId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceChunk" (
    "id" SERIAL NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "roomId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],

    CONSTRAINT "SourceChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomSource_roomId_createdAt_idx" ON "RoomSource"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "SourceChunk_roomId_idx" ON "SourceChunk"("roomId");

-- CreateIndex
CREATE INDEX "SourceChunk_sourceId_position_idx" ON "SourceChunk"("sourceId", "position");

-- AddForeignKey
ALTER TABLE "RoomSource" ADD CONSTRAINT "RoomSource_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceChunk" ADD CONSTRAINT "SourceChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "RoomSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
