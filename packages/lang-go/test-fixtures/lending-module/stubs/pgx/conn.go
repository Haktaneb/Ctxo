// Package pgx is a stub of github.com/jackc/pgx/v5 with only the API the
// lending fixture calls.
package pgx

import "context"

// CommandTag reports what a statement did.
type CommandTag struct{}

// Conn is one database connection.
type Conn struct{}

// Exec runs sql with arguments.
func (c *Conn) Exec(ctx context.Context, sql string, arguments ...any) (CommandTag, error) {
	return CommandTag{}, nil
}
