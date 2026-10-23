// Package sqlx is a stub of github.com/jmoiron/sqlx with only the API the
// lending fixture and the SQL corpus call.
package sqlx

import "database/sql"

// DB wraps *sql.DB, whose methods are promoted.
type DB struct {
	*sql.DB
}

// Tx wraps *sql.Tx, whose methods are promoted.
type Tx struct {
	*sql.Tx
}

// Rows wraps *sql.Rows.
type Rows struct {
	*sql.Rows
}

// Queryer is what Get needs.
type Queryer interface {
	Queryx(query string, args ...interface{}) (*Rows, error)
}

// Select runs query and scans the rows into dest.
func (db *DB) Select(dest interface{}, query string, args ...interface{}) error {
	return nil
}

// Get runs query and scans one row into dest.
func (db *DB) Get(dest interface{}, query string, args ...interface{}) error {
	return nil
}

// Queryx runs query and returns the rows.
func (db *DB) Queryx(query string, args ...interface{}) (*Rows, error) {
	return nil, nil
}

// NamedExec runs a named query.
func (db *DB) NamedExec(query string, arg interface{}) (sql.Result, error) {
	return nil, nil
}

// MustExec runs query and panics on an error.
func (db *DB) MustExec(query string, args ...interface{}) sql.Result {
	return nil
}

// Get runs query on q and scans one row into dest.
func Get(q Queryer, dest interface{}, query string, args ...interface{}) error {
	return nil
}
