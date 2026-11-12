-- TM-LT Stremio - Add manual movie visibility

ALTER TABLE movies
ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
