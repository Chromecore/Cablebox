package db

import (
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
}

func New(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_foreign_keys=on&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(5)
	sqlDB.SetMaxIdleConns(5)

	db := &DB{sqlDB}
	if err := db.migrate(); err != nil {
		sqlDB.Close()
		return nil, err
	}
	return db, nil
}

func (db *DB) migrate() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS channels (
			id       INTEGER PRIMARY KEY,
			number   INTEGER UNIQUE NOT NULL,
			name     TEXT    NOT NULL DEFAULT '',
			logo_url TEXT    NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS schedule_blocks (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			start_time        TEXT    NOT NULL,
			duration_seconds  INTEGER NOT NULL DEFAULT 0,
			type              TEXT    NOT NULL DEFAULT 'episode',
			jellyfin_item_id  TEXT    NOT NULL DEFAULT '',
			show_id           TEXT    NOT NULL DEFAULT '',
			show_name         TEXT    NOT NULL DEFAULT '',
			episode_name      TEXT    NOT NULL DEFAULT '',
			season_number     INTEGER NOT NULL DEFAULT 0,
			episode_number    INTEGER NOT NULL DEFAULT 0,
			empty_image_url   TEXT    NOT NULL DEFAULT '',
			is_recurring      INTEGER NOT NULL DEFAULT 0,
			recur_days        TEXT    NOT NULL DEFAULT '[]'
		)`,
		`CREATE TABLE IF NOT EXISTS config (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_schedule_channel ON schedule_blocks(channel_id)`,
		`CREATE INDEX IF NOT EXISTS idx_schedule_start ON schedule_blocks(start_time)`,
	}

	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("migration failed: %w", err)
		}
	}

	// Pre-populate 50 channels on first run
	if err := db.seedChannels(); err != nil {
		return err
	}

	// Add sort_order column if it doesn't exist yet (non-destructive migration)
	if err := db.addSortOrderColumn(); err != nil {
		return err
	}

	// Add group_id column if it doesn't exist yet (non-destructive migration)
	if err := db.addGroupIDColumn(); err != nil {
		return err
	}

	// Set default admin PIN (SHA256 of "1234")
	if err := db.setDefaultConfig(); err != nil {
		return err
	}

	return nil
}

func (db *DB) addGroupIDColumn() error {
	_, err := db.Exec(`ALTER TABLE schedule_blocks ADD COLUMN group_id TEXT NOT NULL DEFAULT ''`)
	if err != nil && !strings.Contains(err.Error(), "duplicate column") {
		return nil // tolerate all errors — column may already exist
	}
	return nil
}

func (db *DB) addSortOrderColumn() error {
	_, err := db.Exec(`ALTER TABLE channels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`)
	if err != nil {
		// "duplicate column name" means it already exists — ignore
		if strings.Contains(err.Error(), "duplicate column") {
			return nil
		}
		// Some SQLite drivers say "table already has column" — also ignore
		return nil
	}
	// Initialise sort_order = number for existing rows
	_, err = db.Exec(`UPDATE channels SET sort_order = number WHERE sort_order = 0`)
	return err
}

func (db *DB) seedChannels() error {
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM channels").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	for i := 1; i <= 50; i++ {
		if _, err := db.Exec(
			"INSERT INTO channels (number, name, logo_url) VALUES (?, ?, '')",
			i, fmt.Sprintf("Channel %d", i),
		); err != nil {
			return err
		}
	}
	return nil
}

func (db *DB) setDefaultConfig() error {
	// Default PIN hash for "1234" (SHA256)
	defaults := map[string]string{
		"admin_pin_hash":   "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
		"jellyfin_url":     "",
		"jellyfin_api_key": "",
		"jellyfin_user_id": "",
	}
	for k, v := range defaults {
		if _, err := db.Exec(
			"INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)", k, v,
		); err != nil {
			return err
		}
	}
	return nil
}

func (db *DB) GetConfig(key string) (string, error) {
	var val string
	err := db.QueryRow("SELECT value FROM config WHERE key = ?", key).Scan(&val)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return val, err
}

func (db *DB) SetConfig(key, value string) error {
	_, err := db.Exec(
		"INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		key, value,
	)
	return err
}
