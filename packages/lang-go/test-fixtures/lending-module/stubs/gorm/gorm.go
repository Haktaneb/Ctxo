// Package gorm is a stub of gorm.io/gorm with only the API the lending
// fixture and the SQL corpus call.
package gorm

// DB is a gorm session.
type DB struct{}

// Raw runs raw sql and returns the session.
func (db *DB) Raw(sql string, values ...interface{}) *DB { return db }

// Exec runs raw sql.
func (db *DB) Exec(sql string, values ...interface{}) *DB { return db }

// Where adds a condition.
func (db *DB) Where(query interface{}, args ...interface{}) *DB { return db }

// Find loads records into dest.
func (db *DB) Find(dest interface{}, conds ...interface{}) *DB { return db }
