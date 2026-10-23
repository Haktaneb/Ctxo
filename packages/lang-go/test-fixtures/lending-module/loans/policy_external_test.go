package loans_test

import (
	"testing"

	"lending/loans"
)

func TestPolicyFromOutside(t *testing.T) {
	if loans.CanBorrow(3) {
		t.Fatal("three open loans must block borrowing")
	}
}
