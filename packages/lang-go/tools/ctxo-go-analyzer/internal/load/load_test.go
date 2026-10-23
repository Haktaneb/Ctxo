package load

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"golang.org/x/tools/go/packages"
)

func TestPackagesOnHealthyModule(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"go.mod": "module fixture\n\ngo 1.22\n",
		"a.go":   "package fixture\n\nfunc Hello() string { return \"hi\" }\n",
	})
	res := Packages(dir)
	if res.FatalError != nil {
		t.Fatalf("FatalError: %v", res.FatalError)
	}
	if len(res.Packages) == 0 {
		t.Fatal("expected at least one package")
	}
}

func TestPackagesWithFallbackRecoversPartial(t *testing.T) {
	// "broken/" imports a non-existent path so the module-wide load fails;
	// "healthy/" is self-contained, so per-subdir loading recovers it.
	dir := writeFixture(t, map[string]string{
		"go.mod":             "module fixture\n\ngo 1.22\n",
		"broken/broken.go":   "package broken\n\nimport _ \"definitely.nowhere/missing\"\n",
		"healthy/healthy.go": "package healthy\n\nfunc Y() int { return 1 }\n",
	})

	res := PackagesWithFallback(dir)
	if len(res.Packages) == 0 {
		t.Fatalf("expected fallback to recover at least one package; got 0 (FatalError=%v)", res.FatalError)
	}
	if !pkgListContainsName(res.Packages, "healthy") {
		t.Errorf("expected 'healthy' package recovered via fallback; got %v", pkgNames(res.Packages))
	}
}

func TestTopLevelGoSubdirsSkipsHidden(t *testing.T) {
	dir := writeFixture(t, map[string]string{
		"a/file.go":     "package a",
		".hidden/x.go":  "package x",
		"vendor/foo.go": "package foo",
		"b/file.go":     "package b",
	})
	got := topLevelGoSubdirs(dir)
	sort.Strings(got)
	want := []string{"a", "b"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("index %d: got %q want %q", i, got[i], want[i])
		}
	}
}

// testModule has an internal test, an external (_test suffix) test and a
// directory that holds only _test.go files.
var testModule = map[string]string{
	"go.mod":                      "module fixture\n\ngo 1.22\n",
	"loans/loan.go":               "package loans\n\nfunc CanBorrow(n int) bool { return n < 3 }\n",
	"loans/loan_test.go":          "package loans\n\nimport \"testing\"\n\nfunc TestCanBorrow(t *testing.T) { _ = CanBorrow(1) }\n",
	"loans/loan_external_test.go": "package loans_test\n\nimport (\n\t\"testing\"\n\n\t\"fixture/loans\"\n)\n\nfunc TestOutside(t *testing.T) { _ = loans.CanBorrow(1) }\n",
	"members/member.go":           "package members\n\nimport \"fixture/loans\"\n\nfunc Allowed() bool { return loans.CanBorrow(0) }\n",
	"itest/smoke_test.go":         "package itest\n\nimport \"testing\"\n\nfunc TestSmoke(t *testing.T) {}\n",
}

func TestPartitionProdMatchesALoadWithoutTests(t *testing.T) {
	dir := writeFixture(t, testModule)
	withTests := Partition(load(dir, true).Packages)
	without := Partition(load(dir, false).Packages)
	if len(without.Tests) != 0 {
		t.Fatalf("a load without tests has test variants: %v", pkgIDs(without.Tests))
	}
	got, want := pkgIDs(withTests.Prod), pkgIDs(without.Prod)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("Prod IDs differ\n with tests: %v\n without:    %v", got, want)
	}
	if len(want) == 0 {
		t.Fatal("expected production packages")
	}
}

func TestPartitionPutsVariantsInTestsAndDropsTestMains(t *testing.T) {
	dir := writeFixture(t, testModule)
	raw := load(dir, true).Packages
	parts := Partition(raw)

	var mains int
	for _, p := range raw {
		if p.Name == "main" && strings.HasSuffix(p.ID, ".test") {
			mains++
		}
	}
	if mains == 0 {
		t.Fatalf("expected test mains in the raw load: %v", pkgIDs(raw))
	}
	for _, p := range append(append([]*packages.Package{}, parts.Prod...), parts.Tests...) {
		if p.Name == "main" && strings.HasSuffix(p.ID, ".test") {
			t.Errorf("test main %s kept", p.ID)
		}
	}
	for _, p := range parts.Prod {
		if strings.Contains(p.ID, "[") {
			t.Errorf("variant %s in Prod", p.ID)
		}
	}
	for _, p := range parts.Tests {
		if !strings.Contains(p.ID, "[") {
			t.Errorf("non-variant %s in Tests", p.ID)
		}
	}
	for _, want := range []string{
		"fixture/loans [fixture/loans.test]",
		"fixture/loans_test [fixture/loans.test]",
		"fixture/itest [fixture/itest.test]",
	} {
		if !containsID(parts.Tests, want) {
			t.Errorf("Tests lacks %s: %v", want, pkgIDs(parts.Tests))
		}
	}
	for _, list := range [][]*packages.Package{parts.Prod, parts.Tests} {
		ids := pkgIDs(list)
		if !sort.StringsAreSorted(ids) {
			t.Errorf("not sorted by ID: %v", ids)
		}
	}
	if got := len(parts.Prod) + len(parts.Tests) + mains; got != len(raw) {
		t.Errorf("partition lost packages: %d + %d + %d mains != %d", len(parts.Prod), len(parts.Tests), mains, len(raw))
	}
}

// ── helpers ──

func pkgIDs(pkgs []*packages.Package) []string {
	out := make([]string, 0, len(pkgs))
	for _, p := range pkgs {
		out = append(out, p.ID)
	}
	return out
}

func containsID(pkgs []*packages.Package, id string) bool {
	for _, p := range pkgs {
		if p.ID == id {
			return true
		}
	}
	return false
}

func writeFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func pkgNames(pkgs []*packages.Package) []string {
	out := make([]string, 0, len(pkgs))
	for _, p := range pkgs {
		out = append(out, p.Name)
	}
	return out
}

func pkgListContainsName(pkgs []*packages.Package, name string) bool {
	for _, p := range pkgs {
		if p.Name == name {
			return true
		}
	}
	return false
}
