package loans

import (
	"context"
	"database/sql"

	"github.com/jackc/pgx/v5"
	"github.com/jmoiron/sqlx"
	"gorm.io/gorm"
)

const activeLoansSQL = "SELECT l.Id FROM dbo.Loans l " + "JOIN [dbo].[Members] m ON m.Id = l.MemberId"

// Hold is one reservation of a copy.
type Hold struct{ ID int }

// ActiveLoans lists the open loans with their members.
func ActiveLoans(ctx context.Context, db *sql.DB) (*sql.Rows, error) {
	return db.QueryContext(ctx, activeLoansSQL)
}

// CloseLoan closes one loan through the stored procedure.
func CloseLoan(ctx context.Context, tx *sql.Tx, id int) error {
	_, err := tx.ExecContext(ctx, "EXEC dbo.usp_CloseLoan @id = ?", id)
	return err
}

// HoldsFor lists a member's holds.
func HoldsFor(db *sqlx.DB, id int) ([]Hold, error) {
	var holds []Hold
	err := db.Select(&holds, "SELECT * FROM dbo.Holds WHERE MemberId = ?", id)
	return holds, err
}

// Archive copies the closed loans into the archive.
func Archive(ctx context.Context, conn *pgx.Conn) error {
	_, err := conn.Exec(ctx, "INSERT INTO dbo.LoanArchive (Id) SELECT Id FROM dbo.Loans WHERE ClosedAt IS NOT NULL")
	return err
}

// Purge deletes the expired holds.
func Purge(g *gorm.DB) {
	g.Exec("DELETE FROM dbo.Holds WHERE ExpiresAt < CURRENT_TIMESTAMP")
}

// ByTable reads any table; its SQL is not a constant.
func ByTable(db *sql.DB, table string) (*sql.Rows, error) {
	return db.Query("SELECT * FROM " + table)
}

// Prepared runs a prepared statement; its SQL was read at Prepare.
func Prepared(stmt *sql.Stmt) error {
	_, err := stmt.Exec(1)
	return err
}

// Models loads loans through the ORM, without raw SQL.
func Models(g *gorm.DB) []Loan {
	var loans []Loan
	g.Where("member_id = ?", 1).Find(&loans)
	return loans
}
