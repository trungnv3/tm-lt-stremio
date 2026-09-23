-- ============================================================
-- TM-LT Stremio - Add TV episode fields
-- ============================================================

ALTER TABLE movies ADD COLUMN season INTEGER;
ALTER TABLE movies ADD COLUMN episode INTEGER;
