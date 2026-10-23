// Package sqlx is a stub of github.com/jmoiron/sqlx with only the API the
// lending fixture calls.
package sqlx

import "database/sql"

// DB wraps *sql.DB, whose methods are promoted.
type DB struct {
	*sql.DB
}

// Select runs query and scans the rows into dest.
func (db *DB) Select(dest interface{}, query string, args ...interface{}) error {
	return nil
}
