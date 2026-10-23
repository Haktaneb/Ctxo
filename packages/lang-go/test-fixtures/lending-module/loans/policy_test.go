package loans

import "testing"

type fakeStore struct{}

func (fakeStore) Open(memberID int) int { return memberID % 3 }

func TestCanBorrow(t *testing.T) {
	var s Store = fakeStore{}
	if !CanBorrow(s.Open(1)) {
		t.Fatal("one open loan must allow borrowing")
	}
}
