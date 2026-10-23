package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/emit"
)

// lendingFixture is the shared sample module of the lang-go TypeScript tests.
var lendingFixture = filepath.Join("..", "..", "test-fixtures", "lending-module")

// appModule is a binary (hasMain true) whose test files call an unexported
// helper and declare their own symbols; test mains come from these files.
var appModule = map[string]string{
	"go.mod": "module app\n\ngo 1.22\n",
	"main.go": `package main

func main() { run() }

func run() {}

func helper() int { return 1 }
`,
	"main_test.go": `package main

import "testing"

func TestHelper(t *testing.T) {
	if helper() != 1 {
		t.Fatal("helper")
	}
}

func unusedInTest() {}
`,
	"lib/lib.go": `package lib

func Exported() int { return unexported() }

func unexported() int { return 2 }

func orphan() {}
`,
	"lib/lib_external_test.go": `package lib_test

import (
	"testing"

	"app/lib"
)

func TestExported(t *testing.T) { _ = lib.Exported() }
`,
	"onlytests/only_test.go": `package onlytests

import "testing"

func TestOnly(t *testing.T) {}
`,
}

type runOutput struct {
	files map[string]emit.FileRecord
	dead  emit.Dead
}

func runInto(t *testing.T, root string) runOutput {
	t.Helper()
	var buf bytes.Buffer
	if err := run(root, &buf); err != nil {
		t.Fatalf("run: %v", err)
	}
	out := runOutput{files: map[string]emit.FileRecord{}}
	sc := bufio.NewScanner(&buf)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		line := sc.Bytes()
		var head struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(line, &head); err != nil {
			t.Fatalf("bad line %q: %v", line, err)
		}
		switch head.Type {
		case "file":
			var rec emit.FileRecord
			if err := json.Unmarshal(line, &rec); err != nil {
				t.Fatal(err)
			}
			if _, dup := out.files[rec.File]; dup {
				t.Errorf("file %s emitted twice", rec.File)
			}
			out.files[rec.File] = rec
		case "dead":
			if err := json.Unmarshal(line, &out.dead); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func copyModule(t *testing.T, src string, keep func(rel string) bool) string {
	t.Helper()
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		if !keep(filepath.ToSlash(rel)) {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), body, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

func writeModule(t *testing.T, files map[string]string, keep func(rel string) bool) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		if !keep(name) {
			continue
		}
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func all(string) bool { return true }

func noTests(rel string) bool { return !strings.HasSuffix(rel, "_test.go") }

func symbolCount(rec emit.FileRecord, id string) int {
	n := 0
	for _, s := range rec.Symbols {
		if s.SymbolID == id {
			n++
		}
	}
	return n
}

func hasEdge(rec emit.FileRecord, from, to, kind string) bool {
	for _, e := range rec.Edges {
		if e.From == from && e.To == to && e.Kind == kind {
			return true
		}
	}
	return false
}

func TestRunEmitsEachTestFunctionOnceWithItsCalls(t *testing.T) {
	out := runInto(t, copyModule(t, lendingFixture, all))
	const canBorrow = "loans/policy.go::CanBorrow::function"
	cases := []struct {
		file, fn string
		calls    bool
	}{
		{"loans/policy_test.go", "TestCanBorrow", true},
		{"loans/policy_external_test.go", "TestPolicyFromOutside", true},
		{"itest/smoke_test.go", "TestSmoke", false},
	}
	for _, c := range cases {
		rec, ok := out.files[c.file]
		if !ok {
			t.Errorf("no record for %s; got files %v", c.file, keys(out.files))
			continue
		}
		id := c.file + "::" + c.fn + "::function"
		if n := symbolCount(rec, id); n != 1 {
			t.Errorf("%s appears %d times, want 1: %+v", id, n, rec.Symbols)
		}
		if c.calls && !hasEdge(rec, id, canBorrow, "calls") {
			t.Errorf("%s has no calls edge to %s: %+v", id, canBorrow, rec.Edges)
		}
		seen := map[string]bool{}
		for _, e := range rec.Edges {
			k := e.From + "|" + e.To + "|" + e.Kind + "|" + strings.Join(e.TypeArgs, ",")
			if seen[k] {
				t.Errorf("%s: duplicate edge %s", c.file, k)
			}
			seen[k] = true
		}
	}
}

func TestRunLeavesProductionRecordsUnchanged(t *testing.T) {
	modules := map[string]func(keep func(string) bool) string{
		"lending": func(keep func(string) bool) string { return copyModule(t, lendingFixture, keep) },
		"app":     func(keep func(string) bool) string { return writeModule(t, appModule, keep) },
	}
	for name, build := range modules {
		t.Run(name, func(t *testing.T) {
			with := runInto(t, build(all))
			without := runInto(t, build(noTests))

			for file, rec := range without.files {
				got, ok := with.files[file]
				if !ok {
					t.Errorf("%s missing from the run with tests", file)
					continue
				}
				a, _ := json.Marshal(rec)
				b, _ := json.Marshal(got)
				if !bytes.Equal(a, b) {
					t.Errorf("%s differs:\nwithout tests: %s\nwith tests:    %s", file, a, b)
				}
			}
			for file := range with.files {
				if _, ok := without.files[file]; !ok && !strings.HasSuffix(file, "_test.go") {
					t.Errorf("production file %s only appears with tests", file)
				}
			}
			if !reflect.DeepEqual(with.dead, without.dead) {
				t.Errorf("dead differs:\nwithout tests: %+v\nwith tests:    %+v", without.dead, with.dead)
			}
		})
	}
	app := runInto(t, writeModule(t, appModule, all))
	if !app.dead.HasMain {
		t.Error("app module must keep hasMain true")
	}
	if !contains(app.dead.SymbolIDs, "lib/lib.go::orphan::function") {
		t.Errorf("orphan must stay dead: %v", app.dead.SymbolIDs)
	}
	if !contains(app.dead.SymbolIDs, "main.go::helper::function") {
		t.Errorf("helper is called only from a test and must stay dead in the analyzer list: %v", app.dead.SymbolIDs)
	}
	lending := runInto(t, copyModule(t, lendingFixture, all))
	if lending.dead.HasMain {
		t.Error("lending module is a library; hasMain must stay false")
	}
}

func TestRunLinksTestFakesToProductionInterfaces(t *testing.T) {
	out := runInto(t, copyModule(t, lendingFixture, all))
	rec := out.files["loans/policy_test.go"]
	if !hasEdge(rec, "loans/policy_test.go::fakeStore::class", "loans/policy.go::Store::interface", "implements") {
		t.Errorf("fakeStore does not implement Store: %+v", rec.Edges)
	}
	prod := out.files["loans/policy.go"]
	for _, e := range prod.Edges {
		if strings.Contains(e.From, "_test.go") || strings.Contains(e.To, "_test.go") {
			t.Errorf("production record carries a test edge: %+v", e)
		}
	}
}

func TestRunNeverListsTestSymbolsAsDead(t *testing.T) {
	for _, root := range []string{
		writeModule(t, appModule, all),
		copyModule(t, lendingFixture, all),
	} {
		out := runInto(t, root)
		for _, id := range out.dead.SymbolIDs {
			file := id[:strings.Index(id, "::")]
			if strings.HasSuffix(file, "_test.go") {
				t.Errorf("test symbol listed as dead: %s", id)
			}
		}
	}
	app := runInto(t, writeModule(t, appModule, all))
	if symbolCount(app.files["main_test.go"], "main_test.go::unusedInTest::function") != 1 {
		t.Errorf("unusedInTest must be a symbol: %+v", app.files["main_test.go"].Symbols)
	}
	if symbolCount(app.files["onlytests/only_test.go"], "onlytests/only_test.go::TestOnly::function") != 1 {
		t.Errorf("TestOnly must be a symbol: %+v", app.files["onlytests/only_test.go"])
	}
}

func keys(m map[string]emit.FileRecord) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
