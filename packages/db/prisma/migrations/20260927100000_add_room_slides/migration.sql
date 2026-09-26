-- CreateTable
CREATE TABLE "RoomSlide" (
    "id" SERIAL NOT NULL,
    "roomId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomSlide_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomSlide_roomId_position_idx" ON "RoomSlide"("roomId", "position");

-- AddForeignKey
ALTER TABLE "RoomSlide" ADD CONSTRAINT "RoomSlide_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
