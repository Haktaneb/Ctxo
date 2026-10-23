// Package pgxpool is a stub of github.com/jackc/pgx/v5/pgxpool with only the
// API the SQL corpus calls.
package pgxpool

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Pool is a connection pool.
type Pool struct{}

// Exec runs sql with arguments.
func (p *Pool) Exec(ctx context.Context, sql string, arguments ...any) (pgx.CommandTag, error) {
	return pgx.CommandTag{}, nil
}
