INSERT INTO "User" ("id", "email", "name", "handle")
VALUES ('00000000-0000-4000-8000-000000000001', 'bench@example.invalid', 'Bench User', 'bench-user')
ON CONFLICT DO NOTHING;

INSERT INTO "Room" ("slug", "adminId")
SELECT 'bench-room', '00000000-0000-4000-8000-000000000001'
WHERE NOT EXISTS (
  SELECT 1 FROM "Room" WHERE "adminId" = '00000000-0000-4000-8000-000000000001' AND "slug" = 'bench-room'
);
