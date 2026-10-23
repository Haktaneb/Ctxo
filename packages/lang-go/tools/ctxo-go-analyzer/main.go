// ctxo-go-analyzer is the full-tier Go analysis binary bundled inside the
// @ctxo/lang-go npm package. It loads a module via golang.org/x/tools/go/packages,
// walks ASTs with full type info, and emits JSONL describing symbols, edges,
// and reachability on stdout.
//
// The TypeScript composite adapter in packages/lang-go/src/analyzer/ spawns
// this binary in batch mode per index run.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/tools/go/packages"

	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/edges"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/emit"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/extends"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/implements"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/load"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/reach"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/symbols"
)

const reachDeadline = 60 * time.Second

const version = "0.8.0-alpha.0"

func main() {
	root := flag.String("root", "", "module root to analyze (required)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	if *root == "" {
		fmt.Fprintln(os.Stderr, "ctxo-go-analyzer: --root is required")
		os.Exit(2)
	}

	if err := run(*root, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "ctxo-go-analyzer:", err)
		os.Exit(1)
	}
}

type fileAggregate struct {
	symbols []emit.Symbol
	edges   []emit.Edge
}

func run(root string, stdout io.Writer) error {
	w := emit.NewWriter(stdout)
	start := time.Now()

	if err := w.Progress(fmt.Sprintf("analyzer v%s loading %s", version, root)); err != nil {
		return err
	}

	res := load.PackagesWithFallback(root)
	if res.FatalError != nil {
		_ = w.Progress(fmt.Sprintf("module load returned a fatal error (degrading): %v", res.FatalError))
	}
	if res.FallbackUsed {
		_ = w.Progress(fmt.Sprintf("root pattern failed; per-subdir fallback recovered %d packages", len(res.Packages)))
	}
	if len(res.Errors) > 0 {
		_ = w.Progress(fmt.Sprintf("load reported %d package-level errors (continuing)", len(res.Errors)))
	}

	byFile := make(map[string]*fileAggregate)
	get := func(rel string) *fileAggregate {
		if agg, ok := byFile[rel]; ok {
			return agg
		}
		agg := &fileAggregate{}
		byFile[rel] = agg
		return agg
	}

	parts := load.Partition(res.Packages)

	// Production pass: exactly the analysis of a load without tests.
	for _, pkg := range parts.Prod {
		for _, fs := range symbols.Extract(pkg, root) {
			get(fs.RelPath).symbols = append(get(fs.RelPath).symbols, fs.Symbols...)
		}
	}

	ext := edges.NewExtractor(root, append(append([]*packages.Package{}, parts.Prod...), parts.Tests...))
	for _, pkg := range parts.Prod {
		for _, file := range pkg.Syntax {
			rel := relativeFile(pkg, file, root)
			if rel == "" {
				continue
			}
			get(rel).edges = append(get(rel).edges, ext.Extract(pkg, file)...)
		}
	}

	for rel, implEdges := range implements.Extract(root, parts.Prod, nil) {
		get(rel).edges = append(get(rel).edges, implEdges...)
	}

	for rel, extEdges := range extends.Extract(root, parts.Prod, nil) {
		get(rel).edges = append(get(rel).edges, extEdges...)
	}

	testPass(root, parts.Tests, ext, get)

	paths := make([]string, 0, len(byFile))
	for p := range byFile {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		agg := byFile[p]
		if err := w.File(emit.FileRecord{
			File:    p,
			Symbols: agg.symbols,
			Edges:   agg.edges,
		}); err != nil {
			return err
		}
	}

	reachRes := reach.Analyze(root, parts.Prod, reachDeadline)
	deadIDs := collectDead(byFile, reachRes.Reachable)
	if err := w.Dead(emit.Dead{
		SymbolIDs: deadIDs,
		HasMain:   reachRes.HasMain,
		Timeout:   reachRes.Timeout,
	}); err != nil {
		return err
	}
	if reachRes.Timeout {
		_ = w.Progress("reachability analysis exceeded deadline; dead-code precision degraded")
	}

	return w.Summary(emit.Summary{
		TotalFiles: len(paths),
		Elapsed:    time.Since(start).String(),
	})
}

// testPass emits the _test.go files of the test variants, in package ID
// order. A file is taken from the first variant that holds it, so each test
// function appears once. implements and extends run inside the variant's own
// package universe, restricted to the files this variant emits, so a test
// fake links to the production interface it satisfies. A file's edges are
// de-duplicated by from, to, kind and typeArgs.
func testPass(root string, tests []*packages.Package, ext *edges.Extractor, get func(string) *fileAggregate) {
	emitted := make(map[string]bool)
	for _, pkg := range tests {
		mine := make(map[string]bool)
		for _, file := range pkg.Syntax {
			if pkg.Fset == nil {
				break
			}
			tf := pkg.Fset.File(file.Pos())
			if tf == nil || !strings.HasSuffix(filepath.Base(tf.Name()), "_test.go") {
				continue
			}
			rel := relativeFile(pkg, file, root)
			if rel == "" || emitted[rel] {
				continue
			}
			fs, ok := symbols.ExtractFile(pkg, file, root)
			if !ok {
				continue
			}
			emitted[rel] = true
			mine[rel] = true
			agg := get(rel)
			agg.symbols = append(agg.symbols, fs.Symbols...)
			agg.edges = append(agg.edges, ext.Extract(pkg, file)...)
		}
		if len(mine) == 0 {
			continue
		}
		include := func(rel string) bool { return mine[rel] }
		universe := []*packages.Package{pkg}
		for rel, implEdges := range implements.Extract(root, universe, include) {
			get(rel).edges = append(get(rel).edges, implEdges...)
		}
		for rel, extEdges := range extends.Extract(root, universe, include) {
			get(rel).edges = append(get(rel).edges, extEdges...)
		}
	}
	for rel := range emitted {
		agg := get(rel)
		agg.edges = dedupeEdges(agg.edges)
	}
}

func dedupeEdges(in []emit.Edge) []emit.Edge {
	type key struct{ from, to, kind, typeArgs string }
	seen := make(map[key]bool, len(in))
	out := in[:0]
	for _, e := range in {
		k := key{e.From, e.To, e.Kind, strings.Join(e.TypeArgs, ",")}
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, e)
	}
	return out
}

// collectDead walks every function/method symbol across the module and
// returns the subset not present in the reachable set. Non-callable kinds
// (type/variable/class/interface) are excluded — CHA gives us liveness for
// callable symbols only. Symbols of _test.go files are never dead: reach
// runs on production packages, and the CLI decides what tests keep alive.
func collectDead(byFile map[string]*fileAggregate, reachable map[string]bool) []string {
	var dead []string
	for file, agg := range byFile {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		for _, s := range agg.symbols {
			if s.Kind != "function" && s.Kind != "method" {
				continue
			}
			if !reachable[s.SymbolID] {
				dead = append(dead, s.SymbolID)
			}
		}
	}
	sort.Strings(dead)
	return dead
}

func relativeFile(pkg *packages.Package, file *ast.File, root string) string {
	if pkg.Fset == nil {
		return ""
	}
	tf := pkg.Fset.File(file.Pos())
	if tf == nil {
		return ""
	}
	rel, err := filepath.Rel(root, tf.Name())
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	return filepath.ToSlash(rel)
}
