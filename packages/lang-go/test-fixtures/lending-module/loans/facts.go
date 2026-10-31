package loans

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const maxRetries = 3

const settlementDays = 3

var holdTimeout = 90 * time.Minute

// MayBorrow says whether a member may take another loan. (policy.go already
// declares CanBorrow in this package.)
func MayBorrow(openLoans int, member *string) bool {
	if member == nil {
		return false
	}
	if openLoans >= 5 && *member != "" {
		return false
	}
	return true
}

// Fee is the late fee factor of a membership tier.
func Fee(tier string) float64 {
	switch tier {
	case "gold":
		return 0
	case "":
		return 1
	}
	return 2
}

// Key is the lookup key of a member email.
func Key(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// Routes registers the lending endpoints.
func Routes(mux *http.ServeMux, r *gin.Engine) {
	mux.HandleFunc("GET /holds/{id}", nil)
	http.HandleFunc("/health", nil)
	r.GET("/loans/:id", nil)
}

// Note is text that only looks like code.
func Note() string {
	return "if x > 5 { timeout = 30 }"
}
