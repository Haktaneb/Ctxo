// Package emit writes JSONL records to an io.Writer. The schema mirrors
// @ctxo/lang-csharp's RoslynBatchResult shape so the TypeScript composite
// adapter can consume Go and C# analyzer output through a shared parser.
package emit

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// FieldTag is one struct field's raw tag text (decoded from the Go string
// literal). The TypeScript side parses it into annotations, so both tiers
// share one parser.
type FieldTag struct {
	Field string `json:"field"`
	Tag   string `json:"tag"`
}

// Symbol is the wire shape for a declared symbol. Matches SymbolNode in
// @ctxo/plugin-api with optional byte offsets. Tags is set on struct symbols
// only, in field order.
type Symbol struct {
	SymbolID    string     `json:"symbolId"`
	Name        string     `json:"name"`
	Kind        string     `json:"kind"`
	StartLine   int        `json:"startLine"`
	EndLine     int        `json:"endLine"`
	StartOffset *int       `json:"startOffset,omitempty"`
	EndOffset   *int       `json:"endOffset,omitempty"`
	Tags        []FieldTag `json:"tags,omitempty"`
}

// Edge is the wire shape for a dependency relationship. Kind is one of
// imports | calls | extends | implements | uses. TypeArgs preserves generic
// instantiation metadata when Kind == "uses".
type Edge struct {
	From     string   `json:"from"`
	To       string   `json:"to"`
	Kind     string   `json:"kind"`
	TypeArgs []string `json:"typeArgs,omitempty"`
}

// Complexity is the wire shape for per-symbol metrics. Always empty from the
// Go binary; the tree-sitter layer fills it in.
type Complexity struct {
	SymbolID   string `json:"symbolId"`
	Cyclomatic int    `json:"cyclomatic"`
}

// SqlCallSite is raw SQL text found at a known database API call site, as
// reported with --sql-call-sites. Line is 0-based; Kind is "statement". The
// TypeScript side turns the text into data edges.
type SqlCallSite struct {
	SymbolID string `json:"symbolId"`
	Line     int    `json:"line"`
	Text     string `json:"text"`
	Kind     string `json:"kind"`
}

// SqlStats counts the SQL arguments of known call sites in one run: Constant
// ones gave a record, NonConstant ones did not.
type SqlStats struct {
	Constant    int `json:"constant"`
	NonConstant int `json:"nonConstant"`
}

// FileRecord is emitted once per source file analyzed. SqlCallSites is
// sorted by line, then text, and omitted when empty (always without
// --sql-call-sites).
type FileRecord struct {
	Type         string        `json:"type"`
	File         string        `json:"file"`
	Symbols      []Symbol      `json:"symbols"`
	Edges        []Edge        `json:"edges"`
	Complexity   []Complexity  `json:"complexity"`
	SqlCallSites []SqlCallSite `json:"sqlCallSites,omitempty"`
}

// ProjectRecord is emitted once per run to describe module-level edges.
type ProjectRecord struct {
	Type     string         `json:"type"`
	Projects []ProjectEntry `json:"projects"`
	Edges    []ProjectEdge  `json:"edges"`
}

type ProjectEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type ProjectEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

// Summary is the final record emitted when analysis completes. Sql is set
// only with --sql-call-sites.
type Summary struct {
	Type       string    `json:"type"`
	TotalFiles int       `json:"totalFiles"`
	Elapsed    string    `json:"elapsed"`
	Hint       string    `json:"hint,omitempty"`
	Sql        *SqlStats `json:"sql,omitempty"`
}

// Progress is an optional informational record. Consumed by the TS parser
// for log-forwarding only; never affects extracted data.
type Progress struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// Dead is emitted once per run, listing function/method symbol ids that are
// not reachable from the module's entry points. HasMain=false means library
// mode (reachability approximated via exported API). Timeout=true means the
// reach analysis exceeded its deadline and dead-code precision is degraded.
type Dead struct {
	Type      string   `json:"type"`
	SymbolIDs []string `json:"symbolIds"`
	HasMain   bool     `json:"hasMain"`
	Timeout   bool     `json:"timeout,omitempty"`
}

// Writer serializes records to JSONL. Writes are serialized internally so a
// single Writer is safe to share across goroutines.
type Writer struct {
	mu  sync.Mutex
	bw  *bufio.Writer
	err error
}

// NewWriter wraps an io.Writer with JSONL framing.
func NewWriter(w io.Writer) *Writer {
	return &Writer{bw: bufio.NewWriter(w)}
}

// File emits a file-scoped record.
func (w *Writer) File(rec FileRecord) error {
	rec.Type = "file"
	if rec.Symbols == nil {
		rec.Symbols = []Symbol{}
	}
	if rec.Edges == nil {
		rec.Edges = []Edge{}
	}
	if rec.Complexity == nil {
		rec.Complexity = []Complexity{}
	}
	return w.writeJSON(rec)
}

// Project emits the project-graph record.
func (w *Writer) Project(rec ProjectRecord) error {
	rec.Type = "projectGraph"
	if rec.Projects == nil {
		rec.Projects = []ProjectEntry{}
	}
	if rec.Edges == nil {
		rec.Edges = []ProjectEdge{}
	}
	return w.writeJSON(rec)
}

// Dead emits the unreachable-symbols record.
func (w *Writer) Dead(rec Dead) error {
	rec.Type = "dead"
	if rec.SymbolIDs == nil {
		rec.SymbolIDs = []string{}
	}
	return w.writeJSON(rec)
}

// Summary emits the terminal summary record and flushes.
func (w *Writer) Summary(rec Summary) error {
	rec.Type = "summary"
	if err := w.writeJSON(rec); err != nil {
		return err
	}
	return w.Flush()
}

// Progress emits an informational message.
func (w *Writer) Progress(message string) error {
	return w.writeJSON(Progress{Type: "progress", Message: message})
}

// Flush flushes the underlying writer.
func (w *Writer) Flush() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return w.err
	}
	return w.bw.Flush()
}

func (w *Writer) writeJSON(v any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return w.err
	}
	buf, err := json.Marshal(v)
	if err != nil {
		w.err = fmt.Errorf("emit: marshal: %w", err)
		return w.err
	}
	if _, err := w.bw.Write(buf); err != nil {
		w.err = err
		return err
	}
	if err := w.bw.WriteByte('\n'); err != nil {
		w.err = err
		return err
	}
	return nil
}
