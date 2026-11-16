INSERT INTO "User" ("id", "email", "name", "handle")
VALUES ('00000000-0000-4000-8000-000000000001', 'bench@example.invalid', 'Bench User', 'bench-user')
ON CONFLICT DO NOTHING;

INSERT INTO "Room" ("slug", "adminId")
SELECT 'bench-room', '00000000-0000-4000-8000-000000000001'
WHERE NOT EXISTS (
  SELECT 1 FROM "Room" WHERE "adminId" = '00000000-0000-4000-8000-000000000001' AND "slug" = 'bench-room'
);

INSERT INTO "Room" ("id", "slug", "adminId")
VALUES
  (1001, 'bench-room-100', '00000000-0000-4000-8000-000000000001'),
  (1002, 'bench-room-1000', '00000000-0000-4000-8000-000000000001'),
  (1003, 'bench-room-5000', '00000000-0000-4000-8000-000000000001')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Shape" ("id", "roomId", "type", "props", "deleted", "createdAt", "updatedAt")
SELECT
  'bench-' || r.id || '-' || s.n,
  r.id,
  'rectangle',
  jsonb_build_object('id', 'shape-' || s.n, 'type', 'rectangle', 'x', s.n),
  false,
  TIMESTAMP '2026-01-01 00:00:00 UTC' + (s.n * INTERVAL '1 millisecond'),
  TIMESTAMP '2026-01-01 00:00:00 UTC' + (s.n * INTERVAL '1 millisecond')
FROM (VALUES (1001, 100), (1002, 1000), (1003, 5000)) AS r(id, shape_count)
CROSS JOIN LATERAL generate_series(1, r.shape_count) AS s(n)
ON CONFLICT ("id") DO NOTHING;

SELECT setval(pg_get_serial_sequence('"Room"', 'id'), GREATEST((SELECT MAX("id") FROM "Room"), 1));
