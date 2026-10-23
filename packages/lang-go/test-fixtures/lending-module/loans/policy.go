package loans

// Store reports how many loans a member has open.
type Store interface {
	Open(memberID int) int
}

// CanBorrow says whether a member with this many open loans may borrow again.
func CanBorrow(open int) bool {
	return open < 3
}
