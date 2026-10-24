package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/emit"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/facts"
)

// copyFixtureLF copies the lending module with CRLF turned into LF, so
// offsets, lines and hashes do not depend on the checkout's line endings.
func copyFixtureLF(t *testing.T) string {
	t.Helper()
	dst := copyModule(t, lendingFixture, all)
	err := filepath.WalkDir(dst, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(path, bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n")), 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

// recordLines runs the analyzer and returns its file and dead lines, the
// records that do not hold a path or a duration.
func recordLines(t *testing.T, root string, opts options) []string {
	t.Helper()
	var buf bytes.Buffer
	if err := run(root, opts, &buf); err != nil {
		t.Fatalf("run: %v", err)
	}
	var out []string
	sc := bufio.NewScanner(&buf)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		line := sc.Text()
		if strings.Contains(line, `"type":"progress"`) || strings.Contains(line, `"type":"summary"`) {
			continue
		}
		out = append(out, line)
	}
	return out
}

func readGolden(t *testing.T, name string) []string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n"), "\n")
}

// The golden files hold the output of the analyzer before fact evidence
// existed, run over this fixture: without --facts nothing may change.
func TestRunWithoutFactsMatchesThePreFactsOutput(t *testing.T) {
	for golden, opts := range map[string]options{
		"lending-facts-off.golden.jsonl":     {},
		"lending-facts-off-sql.golden.jsonl": {sqlCallSites: true},
	} {
		t.Run(golden, func(t *testing.T) {
			got := recordLines(t, copyFixtureLF(t), opts)
			want := readGolden(t, golden)
			if len(got) != len(want) {
				t.Fatalf("%d records, want %d", len(got), len(want))
			}
			for i := range want {
				if got[i] != want[i] {
					t.Errorf("record %d differs:\n got  %s\n want %s", i, got[i], want[i])
				}
			}
		})
	}
}

func TestRunReportsFactEvidenceOnlyWithTheFlag(t *testing.T) {
	root := copyFixtureLF(t)
	with := runInto(t, root, options{facts: &facts.Options{NormalizationMethods: []string{"strings.ToLower", "Trim*"}}})

	rec := with.files["loans/facts.go"]
	if len(rec.FactEvidence) != 12 {
		t.Errorf("loans/facts.go: %d evidence records, want 12: %+v", len(rec.FactEvidence), rec.FactEvidence)
	}
	testRec := with.files["loans/repository_test.go"]
	wantTest := []emit.FactEvidence{{
		Kind: "comparison", SymbolID: "loans/repository_test.go::TestActiveLoanCount::function", Line: 9,
		Text: "db == nil", Operator: "==", Literal: "nil", LiteralKind: "null",
	}}
	if !reflect.DeepEqual(testRec.FactEvidence, wantTest) {
		t.Errorf("the test pass must collect too: %+v", testRec.FactEvidence)
	}
	for file, rec := range with.files {
		if strings.HasPrefix(file, "stubs/") {
			// Dependency modules under the root get symbols only; the passes
			// never walk their files, so they carry no fact fields.
			if rec.FactSourceHash != "" || len(rec.FactEvidence) > 0 {
				t.Errorf("%s: a dependency file carries fact fields", file)
			}
			continue
		}
		body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(file)))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(body)
		if rec.FactSourceHash != hex.EncodeToString(sum[:]) {
			t.Errorf("%s: factSourceHash %q is not the sha256 of the file", file, rec.FactSourceHash)
		}
		if len(rec.FactEvidence) == 0 {
			if _, has := with.rawFiles[file]["factEvidence"]; has {
				t.Errorf("%s: an empty factEvidence must be omitted", file)
			}
		}
	}

	// Everything but the fact fields equals the run without the flag.
	without := runInto(t, root, options{})
	for file, raw := range without.rawFiles {
		for _, key := range []string{"factEvidence", "factSourceHash"} {
			if _, has := raw[key]; has {
				t.Errorf("%s has %s without the flag", file, key)
			}
		}
		stripped := with.files[file]
		stripped.FactEvidence = nil
		stripped.FactSourceHash = ""
		a, _ := json.Marshal(without.files[file])
		b, _ := json.Marshal(stripped)
		if !bytes.Equal(a, b) {
			t.Errorf("%s differs apart from the fact fields:\nwithout: %s\nwith:    %s", file, a, b)
		}
	}
}

func TestParseFactsFlagFailsOpen(t *testing.T) {
	if opts, warn := parseFactsFlag(""); opts != nil || warn != "" {
		t.Errorf("empty flag: %+v, %q", opts, warn)
	}
	if opts, warn := parseFactsFlag("%%%"); opts != nil || warn == "" {
		t.Errorf("bad flag: %+v, %q", opts, warn)
	}
	good := "eyJub3JtYWxpemF0aW9uTWV0aG9kcyI6WyJ0cmltIl19" // {"normalizationMethods":["trim"]}
	if opts, warn := parseFactsFlag(good); opts == nil || warn != "" || !reflect.DeepEqual(opts.NormalizationMethods, []string{"trim"}) {
		t.Errorf("good flag: %+v, %q", opts, warn)
	}
}
