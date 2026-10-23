// Synthetic Go samples for the fact detectors (PR 4, issue #156). The syntax-tier unit tests pin their facts;
// the tier-agreement integration test runs them through ctxo-go-analyzer as well. They mirror the analyzer's
// own Go tests (tools/ctxo-go-analyzer/internal/facts/facts_test.go). Every sample compiles in a module that
// requires the gin stub below, each in its own package directory.

/** The gin stand-in of the analyzer's Go tests: RouterGroup, Engine, IRoutes and IRouter with route methods. */
export const GIN_STUB = `package gin

type HandlerFunc func()

type IRoutes interface {
	GET(string, ...HandlerFunc) IRoutes
	POST(string, ...HandlerFunc) IRoutes
	Any(string, ...HandlerFunc) IRoutes
	Handle(string, string, ...HandlerFunc) IRoutes
}

type IRouter interface {
	IRoutes
	Group(string) *RouterGroup
}

type RouterGroup struct{}

type Engine struct{ RouterGroup }

func (g *RouterGroup) GET(path string, handlers ...HandlerFunc) IRoutes    { return nil }
func (g *RouterGroup) POST(path string, handlers ...HandlerFunc) IRoutes   { return nil }
func (g *RouterGroup) PUT(path string, handlers ...HandlerFunc) IRoutes    { return nil }
func (g *RouterGroup) DELETE(path string, handlers ...HandlerFunc) IRoutes { return nil }
func (g *RouterGroup) Any(path string, handlers ...HandlerFunc) IRoutes    { return nil }
func (g *RouterGroup) Group(path string) *RouterGroup                      { return g }
func (g *RouterGroup) Handle(method, path string, handlers ...HandlerFunc) IRoutes {
	return nil
}
`;

export const APP_GO_MOD = `module app

go 1.22

require github.com/gin-gonic/gin v1.0.0

replace github.com/gin-gonic/gin => ./stubs/gin
`;

/** Samples on which both tiers must give the same facts. */
export const AGREEING_SAMPLES: Readonly<Record<string, string>> = {
  nilAndStrings: `package app

func Check(member *string, ok bool) bool {
	if member != nil && ok == true {
		return false
	}
	if nil == member {
		return false
	}
	return false
}

func Note() string {
	return "if x > 5 { timeout = 30 }"
}

func Raw() string {
	return \`strings.ToLower(x) == 5\`
}
`,
  shadow: `package app

func Shadow(x int) bool {
	nil := 3
	true := 4
	if x == nil || x == true {
		return false
	}
	return true == 4
}
`,
  closures: `package app

type Desk struct{}

var handler = func(n int) bool { return n > 7 && n != 9 }

func (d *Desk) Renew(days int) {
	check := func() bool {
		if days > 14 {
			return false
		}
		return true
	}
	_ = check
}
`,
  packageLevel: `package app

import "time"

const (
	retryLimit, lateFee = 4, 2
	_                   = 1
)

var renewalBackoff = time.Second

var checker = func(n int) bool {
	if n >= 10 {
		return true
	}
	return false
}
`,
  rules: `package app

import (
	"strings"
	t "time"
)

type Policy struct {
	RetryCount int
	Window     t.Duration
}

func Rules(n int, code rune, tier string) Policy {
	for i := 0; i < 3; i++ {
	}
	if !(n == -1) {
	}
	switch {
	case n > 100, tier == "x":
	}
	switch code {
	case 'a', 'b':
	case rune(n):
	}
	maxAttempts := 5
	var renewTimeout = t.Duration(30) * t.Second
	t.Sleep(2 * t.Millisecond)
	p := Policy{RetryCount: 2, Window: 48 * t.Hour}
	p.RetryCount = 7
	_ = strings.ToUpper(tier)
	_ = strings.Repeat(tier, 2)
	_ = maxAttempts
	_ = renewTimeout
	return p
}
`,
  routes: `package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

const holdsPath = "/holds"

func Register(mux *http.ServeMux, r *gin.Engine, g *gin.RouterGroup, dynamic string) {
	mux.Handle("POST lending.example/renew/{id}", nil)
	http.Handle(holdsPath, nil)
	g.POST("/loans", nil)
	r.Any("/ping")
	r.Handle("delete", "/loans/:id", nil)
	r.Group("/v2").PUT("/members/:id", nil)
	r.GET(dynamic, nil)
	mux.HandleFunc("lending.example", nil)
	http.DefaultServeMux.HandleFunc("DELETE /holds/{id}", nil)
	r.POST("/caf\\u00e9/"+"menu", nil)
}
`,
  ginInterfaces: `package app

import "github.com/gin-gonic/gin"

func Register(r gin.IRouter, routes gin.IRoutes) {
	r.GET("/loans/:id", nil)
	r.Group("/v2").POST("/holds", nil)
	routes.Any("/ping")
	routes.Handle("PATCH", "/members/:id", nil)
}
`,
  chained: `package app

import "time"

func Wait() {
	time.Sleep(2 * time.Second * 3)
	var graceTimeout = 4 * (time.Minute * 15)
	_ = graceTimeout
}
`,
  normalization: `package app

import "strings"

type Email string

func (e Email) Normalize() string { return string(e) }

func Clean(e Email, s string) string {
	_ = e.Normalize()
	_ = strings.TrimLeft(s, " ")
	return strings.Title(s)
}
`,
  literals: `package app

import "time"

type Config struct {
	DelayMs int
	Labels  map[string]int
}

func Limits(n int, ratio float64, name string, cfg Config) {
	if ratio > 0.75 || n <= -3 {
	}
	if name == \`gold\` || name != "\\x41" {
	}
	if n == 0x10 || n == 017 || n > 1_000 {
	}
	for n > 2 {
	}
	m := map[string]int{"a": 1}
	labels := map[string]int{name: 2}
	list := []Config{{DelayMs: 250}}
	cfg = Config{DelayMs: 2 * 60 * 1000, Labels: m}
	ttlSeconds, backoffFactor := 3600, 1.5
	expiryDays := 7 / 2
	_, _, _, _, _ = labels, list, ttlSeconds, backoffFactor, expiryDays
	_ = 3 * time.Hour * time.Second
	_ = time.Duration(5) * time.Minute
}
`,
};

/**
 * Samples where the syntax tier, which has no types, gives other facts than the analyzer. Each is an accepted
 * difference, listed in the Task 9 report and pinned by the tier-agreement test.
 */
export const DIFFERING_SAMPLES: Readonly<Record<string, string>> = {
  // A HandleFunc on a type that is not net/http's ServeMux: the syntax tier reports it by name.
  fakeMux: `package app

import "net/http"

type fakeMux struct{}

func (fakeMux) HandleFunc(p string, h func(http.ResponseWriter, *http.Request)) {}

func Register(f fakeMux) {
	f.HandleFunc("/fake", nil)
}
`,
  // A route on a gin router declared in another file, in a file without the gin import, and a path constant
  // declared in another file: the analyzer resolves both, the syntax tier sees neither.
  elsewhere: `package app

func Register() {
	router.GET("/far", nil)
	mux.HandleFunc(remotePath, nil)
}
`,
  elsewhereDecls: `package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

var router *gin.Engine

var mux *http.ServeMux

const remotePath = "/remote"
`,
  // A generic receiver: the syntax tier's own method ID keeps the type parameters.
  generic: `package app

type List[T any] struct{ items []T }

func (l *List[T]) Get(i int) T {
	if i > 9 {
		return l.items[0]
	}
	return l.items[i]
}
`,
  // Identifier keys of a named map type: the syntax tier cannot tell them from struct fields.
  namedMap: `package app

type Limits map[string]int

const retryKey = "r"

func Build() Limits {
	return Limits{retryKey: 3}
}
`,
};
