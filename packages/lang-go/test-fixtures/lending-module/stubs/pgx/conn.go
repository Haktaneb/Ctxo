// Package pgx is a stub of github.com/jackc/pgx/v5 with only the API the
// lending fixture and the SQL corpus call.
package pgx

import "context"

// CommandTag reports what a statement did.
type CommandTag struct{}

// Rows is a result set.
type Rows interface{ Close() }

// Row is one result row.
type Row interface{ Scan(dest ...any) error }

// Conn is one database connection.
type Conn struct{}

// Exec runs sql with arguments.
func (c *Conn) Exec(ctx context.Context, sql string, arguments ...any) (CommandTag, error) {
	return CommandTag{}, nil
}

// Query runs sql and returns the rows.
func (c *Conn) Query(ctx context.Context, sql string, args ...any) (Rows, error) {
	return nil, nil
}

// QueryRow runs sql and returns one row.
func (c *Conn) QueryRow(ctx context.Context, sql string, args ...any) Row {
	return nil
}

// Tx is one transaction.
type Tx interface {
	QueryRow(ctx context.Context, sql string, args ...any) Row
}
