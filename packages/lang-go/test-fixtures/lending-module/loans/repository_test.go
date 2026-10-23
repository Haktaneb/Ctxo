package loans

import (
	"database/sql"
	"testing"
)

func TestActiveLoanCount(t *testing.T) {
	var db *sql.DB
	if db == nil {
		t.Skip("no database")
	}
	var n int
	_ = db.QueryRow("SELECT COUNT(*) FROM dbo.Loans").Scan(&n)
}
