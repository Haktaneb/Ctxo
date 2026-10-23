package sqlsites

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/emit"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/load"
)

// stubModules are stand-ins for the real libraries, wired in through replace
// directives so the tests never download anything. They declare only the
// shapes the known-API table needs.
var stubModules = map[string]string{
	"stubs/sqlx/go.mod": "module github.com/jmoiron/sqlx\n\ngo 1.22\n",
	"stubs/sqlx/sqlx.go": `package sqlx

import (
	"context"
	"database/sql"
)

type Rows struct{}

type DB struct{ *sql.DB }
type Tx struct{ *sql.Tx }
type Conn struct{ *sql.Conn }

func (db *DB) Select(dest interface{}, query string, args ...interface{}) error { return nil }
func (db *DB) Get(dest interface{}, query string, args ...interface{}) error    { return nil }
func (db *DB) Queryx(query string, args ...interface{}) (*Rows, error)          { return nil, nil }
func (db *DB) NamedExec(query string, arg interface{}) (sql.Result, error)      { return nil, nil }
func (db *DB) MustExec(query string, args ...interface{}) sql.Result            { return nil }

func (tx *Tx) Select(dest interface{}, query string, args ...interface{}) error { return nil }
func (tx *Tx) Get(dest interface{}, query string, args ...interface{}) error    { return nil }
func (tx *Tx) Queryx(query string, args ...interface{}) (*Rows, error)          { return nil, nil }
func (tx *Tx) NamedExec(query string, arg interface{}) (sql.Result, error)      { return nil, nil }
func (tx *Tx) MustExec(query string, args ...interface{}) sql.Result            { return nil }

func (c *Conn) Select(dest interface{}, query string, args ...interface{}) error { return nil }
func (c *Conn) Get(dest interface{}, query string, args ...interface{}) error    { return nil }
func (c *Conn) Queryx(query string, args ...interface{}) (*Rows, error)          { return nil, nil }
func (c *Conn) NamedExec(query string, arg interface{}) (sql.Result, error)      { return nil, nil }
func (c *Conn) MustExec(query string, args ...interface{}) sql.Result            { return nil }

func (db *DB) SelectContext(ctx context.Context, dest interface{}, query string, args ...interface{}) error {
	return nil
}

func Select(q interface{}, dest interface{}, query string, args ...interface{}) error { return nil }
func Get(q interface{}, dest interface{}, query string, args ...interface{}) error    { return nil }
func NamedExec(e interface{}, query string, arg interface{}) (sql.Result, error)     { return nil, nil }
func MustExec(e interface{}, query string, args ...interface{}) sql.Result           { return nil }
func In(query string, args ...interface{}) (string, []interface{}, error)            { return query, args, nil }
`,
	"stubs/pgx5/go.mod": "module github.com/jackc/pgx/v5\n\ngo 1.22\n",
	"stubs/pgx5/pgx.go": `package pgx

import "context"

type CommandTag struct{}
type Rows interface{ Close() }
type Row interface{ Scan(dest ...any) error }

type Conn struct{}

func (c *Conn) Exec(ctx context.Context, sql string, arguments ...any) (CommandTag, error) {
	return CommandTag{}, nil
}
func (c *Conn) Query(ctx context.Context, sql string, args ...any) (Rows, error) { return nil, nil }
func (c *Conn) QueryRow(ctx context.Context, sql string, args ...any) Row        { return nil }
func (c *Conn) Prepare(ctx context.Context, name, sql string) (any, error)       { return nil, nil }

type Tx interface {
	Exec(ctx context.Context, sql string, arguments ...any) (CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) Row
}
`,
	"stubs/pgx5/pgxpool/pool.go": `package pgxpool

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type Pool struct{}
type Conn struct{}
type Tx struct{}

func (p *Pool) Exec(ctx context.Context, sql string, arguments ...any) (pgx.CommandTag, error) {
	return pgx.CommandTag{}, nil
}
func (p *Pool) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) { return nil, nil }
func (p *Pool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row        { return nil }

func (c *Conn) Exec(ctx context.Context, sql string, arguments ...any) (pgx.CommandTag, error) {
	return pgx.CommandTag{}, nil
}
func (c *Conn) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) { return nil, nil }
func (c *Conn) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row        { return nil }

func (t *Tx) Exec(ctx context.Context, sql string, arguments ...any) (pgx.CommandTag, error) {
	return pgx.CommandTag{}, nil
}
func (t *Tx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) { return nil, nil }
func (t *Tx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row        { return nil }
`,
	"stubs/pgx4/go.mod": "module github.com/jackc/pgx/v4\n\ngo 1.22\n",
	"stubs/pgx4/pgx.go": `package pgx

import "context"

type CommandTag []byte
type Rows interface{ Close() }
type Row interface{ Scan(dest ...interface{}) error }

type Conn struct{}

func (c *Conn) Exec(ctx context.Context, sql string, arguments ...interface{}) (CommandTag, error) {
	return nil, nil
}
func (c *Conn) Query(ctx context.Context, sql string, args ...interface{}) (Rows, error) {
	return nil, nil
}
func (c *Conn) QueryRow(ctx context.Context, sql string, args ...interface{}) Row { return nil }

type Tx interface {
	Exec(ctx context.Context, sql string, arguments ...interface{}) (CommandTag, error)
	Query(ctx context.Context, sql string, args ...interface{}) (Rows, error)
	QueryRow(ctx context.Context, sql string, args ...interface{}) Row
}
`,
	"stubs/pgx4/pgxpool/pool.go": `package pgxpool

import (
	"context"

	"github.com/jackc/pgx/v4"
)

type Pool struct{}

func (p *Pool) Exec(ctx context.Context, sql string, arguments ...interface{}) (pgx.CommandTag, error) {
	return nil, nil
}
func (p *Pool) Query(ctx context.Context, sql string, args ...interface{}) (pgx.Rows, error) {
	return nil, nil
}
func (p *Pool) QueryRow(ctx context.Context, sql string, args ...interface{}) pgx.Row { return nil }
`,
	"stubs/gorm/go.mod": "module gorm.io/gorm\n\ngo 1.22\n",
	"stubs/gorm/gorm.go": `package gorm

type DB struct{}

func (db *DB) Raw(sql string, values ...interface{}) *DB             { return db }
func (db *DB) Exec(sql string, values ...interface{}) *DB            { return db }
func (db *DB) Where(query interface{}, args ...interface{}) *DB      { return db }
func (db *DB) Find(dest interface{}, conds ...interface{}) *DB       { return db }
func (db *DB) Table(name string, args ...interface{}) *DB            { return db }
`,
}

const goMod = `module app

go 1.22

require (
	github.com/jackc/pgx/v4 v4.0.0
	github.com/jackc/pgx/v5 v5.0.0
	github.com/jmoiron/sqlx v1.0.0
	gorm.io/gorm v1.0.0
)

replace (
	github.com/jackc/pgx/v4 => ./stubs/pgx4
	github.com/jackc/pgx/v5 => ./stubs/pgx5
	github.com/jmoiron/sqlx => ./stubs/sqlx
	gorm.io/gorm => ./stubs/gorm
)
`

const header = `package app

import (
	"context"
	"database/sql"
	"fmt"

	pgx4 "github.com/jackc/pgx/v4"
	pgxpool4 "github.com/jackc/pgx/v4/pgxpool"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jmoiron/sqlx"
	"gorm.io/gorm"
)

var (
	_ context.Context
	_ *sql.DB
	_ = fmt.Sprintf
	_ pgx4.Tx
	_ *pgxpool4.Pool
	_ pgx.Tx
	_ *pgxpool.Pool
	_ *sqlx.DB
	_ *gorm.DB
)

`

type result struct {
	sites []emit.SqlCallSite
	stats emit.SqlStats
}

// collectApp writes app.go (header plus body) next to the stub modules,
// loads it and runs Collect over every file of package app.
func collectApp(t *testing.T, body string) result {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{"go.mod": goMod, "app.go": header + body}
	for k, v := range stubModules {
		files[k] = v
	}
	for name, content := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	res := load.Packages(dir)
	if res.FatalError != nil {
		t.Fatalf("load: %v", res.FatalError)
	}
	var out result
	found := false
	for _, pkg := range load.Partition(res.Packages).Prod {
		if pkg.PkgPath != "app" {
			continue
		}
		for _, e := range pkg.Errors {
			t.Fatalf("package error: %v", e)
		}
		found = true
		for _, file := range pkg.Syntax {
			rel, err := filepath.Rel(dir, pkg.Fset.File(file.Pos()).Name())
			if err != nil {
				t.Fatal(err)
			}
			out.sites = append(out.sites, Collect(pkg, file, filepath.ToSlash(rel), &out.stats)...)
		}
	}
	if !found {
		t.Fatal("package app not loaded")
	}
	return out
}

type apiCase struct {
	params string // parameter list of the generated function
	call   string // call with %q standing for the SQL text
}

func knownApiCases() []apiCase {
	var cases []apiCase
	add := func(params, call string) { cases = append(cases, apiCase{params, call}) }

	// database/sql: DB and Tx carry every form, Conn only the Context forms.
	for _, recv := range []string{"x *sql.DB", "x *sql.Tx"} {
		add("ctx context.Context, "+recv, "x.Query(%q)")
		add("ctx context.Context, "+recv, "x.QueryContext(ctx, %q, 1)")
		add("ctx context.Context, "+recv, "x.QueryRow(%q)")
		add("ctx context.Context, "+recv, "x.QueryRowContext(ctx, %q)")
		add("ctx context.Context, "+recv, "x.Exec(%q, 1, 2)")
		add("ctx context.Context, "+recv, "x.ExecContext(ctx, %q)")
		add("ctx context.Context, "+recv, "x.Prepare(%q)")
		add("ctx context.Context, "+recv, "x.PrepareContext(ctx, %q)")
	}
	add("ctx context.Context, x *sql.Conn", "x.QueryContext(ctx, %q)")
	add("ctx context.Context, x *sql.Conn", "x.QueryRowContext(ctx, %q)")
	add("ctx context.Context, x *sql.Conn", "x.ExecContext(ctx, %q)")
	add("ctx context.Context, x *sql.Conn", "x.PrepareContext(ctx, %q)")

	// sqlx methods on DB, Tx and Conn, and the package functions.
	for _, recv := range []string{"x *sqlx.DB", "x *sqlx.Tx", "x *sqlx.Conn"} {
		add(recv, "x.Select(nil, %q)")
		add(recv, "x.Get(nil, %q, 1)")
		add(recv, "x.Queryx(%q)")
		add(recv, "x.NamedExec(%q, nil)")
		add(recv, "x.MustExec(%q)")
	}
	add("x *sqlx.DB", "sqlx.Select(x, nil, %q)")
	add("x *sqlx.DB", "sqlx.Get(x, nil, %q)")
	add("x *sqlx.DB", "sqlx.NamedExec(x, %q, nil)")
	add("x *sqlx.DB", "sqlx.MustExec(x, %q)")

	// The *sql.DB methods promoted onto sqlx.DB.
	add("ctx context.Context, x *sqlx.DB", "x.QueryContext(ctx, %q)")
	add("x *sqlx.DB", "x.Exec(%q)")

	// pgx v5 and v4: Conn and the Tx interface, and their pgxpool types.
	for _, recv := range []string{"x *pgx.Conn", "x pgx.Tx", "x *pgxpool.Pool", "x *pgxpool.Conn", "x *pgxpool.Tx",
		"x *pgx4.Conn", "x pgx4.Tx", "x *pgxpool4.Pool"} {
		add("ctx context.Context, "+recv, "x.Query(ctx, %q)")
		add("ctx context.Context, "+recv, "x.QueryRow(ctx, %q, 1)")
		add("ctx context.Context, "+recv, "x.Exec(ctx, %q)")
	}

	// gorm.
	add("x *gorm.DB", "x.Raw(%q, 1)")
	add("x *gorm.DB", "x.Exec(%q)")
	return cases
}

func TestKnownApisYieldRecords(t *testing.T) {
	cases := knownApiCases()
	var body strings.Builder
	want := map[string]string{} // symbol id -> text
	for i, c := range cases {
		text := fmt.Sprintf("SELECT %d FROM dbo.T%d", i, i)
		fmt.Fprintf(&body, "func F%d(%s) {\n\t%s\n}\n\n", i, c.params, fmt.Sprintf(c.call, text))
		want[fmt.Sprintf("app.go::F%d::function", i)] = text
	}
	got := collectApp(t, body.String())

	gotBy := map[string]string{}
	for _, s := range got.sites {
		if s.Kind != "statement" {
			t.Errorf("%s: kind %q, want statement", s.SymbolID, s.Kind)
		}
		if prev, dup := gotBy[s.SymbolID]; dup {
			t.Errorf("%s: two records (%q, %q)", s.SymbolID, prev, s.Text)
		}
		gotBy[s.SymbolID] = s.Text
	}
	for i, c := range cases {
		id := fmt.Sprintf("app.go::F%d::function", i)
		if gotBy[id] != want[id] {
			t.Errorf("F%d (%s; %s): got %q, want %q", i, c.params, c.call, gotBy[id], want[id])
		}
	}
	if len(got.sites) != len(cases) {
		t.Errorf("got %d records, want %d", len(got.sites), len(cases))
	}
	if got.stats != (emit.SqlStats{Constant: len(cases), NonConstant: 0}) {
		t.Errorf("stats %+v, want {%d 0}", got.stats, len(cases))
	}
	if !sort.SliceIsSorted(got.sites, func(i, j int) bool { return got.sites[i].Line < got.sites[j].Line }) {
		t.Error("records are not sorted by line")
	}
}

func TestConstantsAndNonConstants(t *testing.T) {
	got := collectApp(t, `const loansSQL = "SELECT Id FROM dbo.Loans"

const prefix = "SELECT Id FROM "

var dynamic = "SELECT Id FROM dbo.Dynamic"

func Constants(db *sql.DB) {
	db.Query(loansSQL)
	db.Query(prefix + "dbo.Members")
}

func NonConstants(db *sql.DB, table string) {
	db.Query(dynamic)
	db.Query(fmt.Sprintf("SELECT * FROM %s", table))
	db.Query(table)
}
`)
	want := []emit.SqlCallSite{
		{SymbolID: "app.go::Constants::function", Line: 34, Text: "SELECT Id FROM dbo.Loans", Kind: "statement"},
		{SymbolID: "app.go::Constants::function", Line: 35, Text: "SELECT Id FROM dbo.Members", Kind: "statement"},
	}
	if !reflect.DeepEqual(got.sites, want) {
		t.Errorf("sites:\n got  %+v\n want %+v", got.sites, want)
	}
	if got.stats != (emit.SqlStats{Constant: 2, NonConstant: 3}) {
		t.Errorf("stats %+v, want {2 3}", got.stats)
	}
}

func TestStmtMethodsAndOrmCallsAreIgnored(t *testing.T) {
	got := collectApp(t, `func Ignored(ctx context.Context, stmt *sql.Stmt, g *gorm.DB, c *pgx.Conn, db *sqlx.DB) {
	stmt.Exec(1)
	stmt.ExecContext(ctx, 1)
	stmt.Query()
	stmt.QueryRowContext(ctx)
	g.Where("member_id = ?", 1).Find(nil)
	g.Table("dbo.Loans")
	c.Prepare(ctx, "name", "SELECT 1")
	db.SelectContext(ctx, nil, "SELECT 2")
	sqlx.In("SELECT 3 WHERE Id IN (?)", 1)
	fmt.Sprintf("SELECT 4")
}
`)
	if len(got.sites) != 0 {
		t.Errorf("want no records, got %+v", got.sites)
	}
	if got.stats != (emit.SqlStats{}) {
		t.Errorf("stats %+v, want zero", got.stats)
	}
}

func TestClosuresBelongToTheEnclosingFunction(t *testing.T) {
	got := collectApp(t, `type Repo struct{ db *sql.DB }

func Outer(db *sql.DB) {
	run := func() {
		db.Exec("UPDATE dbo.B SET X = 1"); db.Exec("UPDATE dbo.A SET X = 1")
	}
	run()
}

func (r *Repo) Load() {
	go func() {
		_, _ = r.db.Query("SELECT * FROM dbo.Loads")
	}()
}

var Global = func(db *sql.DB) { db.Exec("DELETE FROM dbo.Outside") }
`)
	want := []emit.SqlCallSite{
		{SymbolID: "app.go::Outer::function", Line: 31, Text: "UPDATE dbo.A SET X = 1", Kind: "statement"},
		{SymbolID: "app.go::Outer::function", Line: 31, Text: "UPDATE dbo.B SET X = 1", Kind: "statement"},
		{SymbolID: "app.go::Repo.Load::method", Line: 38, Text: "SELECT * FROM dbo.Loads", Kind: "statement"},
	}
	if !reflect.DeepEqual(got.sites, want) {
		t.Errorf("sites:\n got  %+v\n want %+v", got.sites, want)
	}
	if got.stats != (emit.SqlStats{Constant: 3}) {
		t.Errorf("stats %+v, want {3 0}", got.stats)
	}
}
