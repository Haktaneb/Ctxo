package loans

type Base struct{ CreatedAt int64 }

type Loan struct {
	LoanID           int `json:"loan_id" gorm:"column:loan_id;primaryKey"`
	MemberID, CopyID int `json:"member_id"`
	Base
	Note string
	Due  string "json:\"due_at\""
}
