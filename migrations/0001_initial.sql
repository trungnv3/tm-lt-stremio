-- ============================================================
-- TM-LT Stremio - Initial Database Schema
-- ============================================================

-- ------------------------------------------------------------
-- Google Drive libraries
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    folder_id TEXT NOT NULL UNIQUE,
    folder_url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Indexed movie/video files
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    library_id INTEGER NOT NULL,

    drive_file_id TEXT NOT NULL UNIQUE,
    drive_parent_id TEXT,
    drive_name TEXT NOT NULL,
    drive_mime_type TEXT,
    drive_size INTEGER,
    drive_modified_time TEXT,

    title TEXT NOT NULL,
    year INTEGER,

    tmdb_id INTEGER,
    tmdb_type TEXT,

    poster_url TEXT,
    backdrop_url TEXT,
    overview TEXT,
    genres TEXT,

    is_active INTEGER NOT NULL DEFAULT 1,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (library_id) REFERENCES libraries(id)
);

-- ------------------------------------------------------------
-- Stream information
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    movie_id INTEGER NOT NULL,

    stream_type TEXT NOT NULL DEFAULT 'google_drive',
    drive_file_id TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (movie_id) REFERENCES movies(id)
);

-- ------------------------------------------------------------
-- Reindex history
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reindex_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    library_id INTEGER,

    status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,

    files_found INTEGER NOT NULL DEFAULT 0,
    files_added INTEGER NOT NULL DEFAULT 0,
    files_updated INTEGER NOT NULL DEFAULT 0,
    files_removed INTEGER NOT NULL DEFAULT 0,

    error_message TEXT,

    FOREIGN KEY (library_id) REFERENCES libraries(id)
);

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_movies_library
    ON movies(library_id);

CREATE INDEX IF NOT EXISTS idx_movies_active
    ON movies(is_active);

CREATE INDEX IF NOT EXISTS idx_movies_tmdb
    ON movies(tmdb_id);

CREATE INDEX IF NOT EXISTS idx_movies_title
    ON movies(title);

CREATE INDEX IF NOT EXISTS idx_streams_movie
    ON streams(movie_id);

CREATE INDEX IF NOT EXISTS idx_reindex_library
    ON reindex_jobs(library_id);