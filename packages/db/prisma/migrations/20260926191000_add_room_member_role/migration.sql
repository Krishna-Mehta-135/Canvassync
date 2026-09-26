-- CreateEnum
CREATE TYPE "RoomMemberRole" AS ENUM ('EDITOR', 'VIEWER');

-- AlterTable
ALTER TABLE "RoomMember" ADD COLUMN "role" "RoomMemberRole" NOT NULL DEFAULT 'EDITOR';
