// Package facts collects syntactic evidence for code facts (PR 4, issue
// #156): comparisons with a literal in conditions and case labels, calls that
// match a normalization pattern, retry and timeout bindings, time.Duration
// values, and net/http and gin routes. It only reports evidence; the
// TypeScript side's shared finisher applies the fact rules (trivial literals,
// canonical numbers, text normalization) and decides what becomes a fact, so
// nothing here formats numbers. Calls and routes are type-resolved.
package facts

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/constant"
	"go/printer"
	"go/token"
	"go/types"
	"os"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/emit"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/symbols"
)

// MaxEvidencePerFile is the most evidence records collected for one file, so
// a generated file cannot flood the stream; the finisher keeps at most 500
// facts per file in any case.
const MaxEvidencePerFile = 2000

// Options are the fact detector options the analyzer needs, decoded from
// --facts=<base64>.
type Options struct {
	NormalizationMethods []string
}

// Decode reads the --facts value: standard base64 of the UTF-8 JSON
// {"normalizationMethods":[...]} (other keys are ignored). Any other input
// is an error.
func Decode(base64Value string) (*Options, error) {
	if base64Value == "" {
		return nil, errors.New("facts: empty value")
	}
	raw, err := base64.StdEncoding.DecodeString(base64Value)
	if err != nil {
		return nil, fmt.Errorf("facts: not base64: %w", err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("facts: not a JSON object: %w", err)
	}
	list, ok := doc["normalizationMethods"]
	if !ok || bytes.Equal(bytes.TrimSpace(list), []byte("null")) {
		return nil, errors.New("facts: normalizationMethods missing")
	}
	var methods []string
	if err := json.Unmarshal(list, &methods); err != nil {
		return nil, fmt.Errorf("facts: normalizationMethods is not a list of strings: %w", err)
	}
	if methods == nil {
		methods = []string{}
	}
	return &Options{NormalizationMethods: methods}, nil
}

// retryTimeoutFragments are the FC-5 name fragments.
var retryTimeoutFragments = []string{"retry", "retries", "attempt", "timeout", "delay", "backoff", "ttl", "expir"}

func isUpper(c byte) bool { return c >= 'A' && c <= 'Z' }
func isLower(c byte) bool { return c >= 'a' && c <= 'z' }
func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// nameTokens splits a name into lower-cased ASCII tokens like the shared
// rule's /[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|\d+/g: only A-Z, a-z and 0-9
// form tokens, every other byte (including every byte of a non-ASCII rune)
// separates them.
func nameTokens(name string) []string {
	var tokens []string
	for i := 0; i < len(name); {
		c := name[i]
		j := i + 1
		switch {
		case isUpper(c):
			for j < len(name) && isUpper(name[j]) {
				j++
			}
			if j < len(name) && isLower(name[j]) {
				if j-i > 1 {
					j-- // the last capital starts the next word
				} else {
					for j < len(name) && isLower(name[j]) {
						j++
					}
				}
			}
		case isLower(c):
			for j < len(name) && isLower(name[j]) {
				j++
			}
		case isDigit(c):
			for j < len(name) && isDigit(name[j]) {
				j++
			}
		default:
			i++
			continue
		}
		tokens = append(tokens, asciiLower(name[i:j]))
		i = j
	}
	return tokens
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if isUpper(c) {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

// HasRetryTimeoutFragment is FC-5: a fragment matches when the name's tokens,
// joined from the start of some token, begin with it.
func HasRetryTimeoutFragment(name string) bool {
	tokens := nameTokens(name)
	for i := range tokens {
		rest := strings.Join(tokens[i:], "")
		for _, f := range retryTimeoutFragments {
			if strings.HasPrefix(rest, f) {
				return true
			}
		}
	}
	return false
}

// MatchesPattern is FC-4: Name matches exactly, Name* by prefix
// (case-sensitive), and q.Name[*] only when the call is written q.Name(...).
// qualifier is the receiver's source, "" for a call without one.
func MatchesPattern(method, qualifier string, patterns []string) bool {
	for _, p := range patterns {
		name := p
		if dot := strings.IndexByte(p, '.'); dot >= 0 {
			if p[:dot] != qualifier || qualifier == "" {
				continue
			}
			name = p[dot+1:]
		}
		if strings.HasSuffix(name, "*") {
			if strings.HasPrefix(method, name[:len(name)-1]) {
				return true
			}
		} else if method == name {
			return true
		}
	}
	return false
}

// durationUnits maps the time package's unit constants to fact units.
var durationUnits = map[string]string{
	"Nanosecond": "ns", "Microsecond": "us", "Millisecond": "ms",
	"Second": "s", "Minute": "min", "Hour": "h",
}

// ginVerbs maps gin RouterGroup methods with a path first argument to verbs.
var ginVerbs = map[string]string{
	"GET": "GET", "POST": "POST", "PUT": "PUT", "DELETE": "DELETE",
	"PATCH": "PATCH", "HEAD": "HEAD", "OPTIONS": "OPTIONS", "Any": "ANY",
}

const ginPath = "github.com/gin-gonic/gin"

// readSource returns the bytes of the file the AST was parsed from, or nil
// when they cannot be read or do not match the parsed file's size.
func readSource(fset *token.FileSet, file *ast.File) []byte {
	tf := fset.File(file.Pos())
	if tf == nil {
		return nil
	}
	src, err := os.ReadFile(tf.Name())
	if err != nil || len(src) != tf.Size() {
		return nil
	}
	return src
}

// SourceHash is the hex SHA-256 of the file's bytes, or "" when they cannot
// be read.
func SourceHash(pkg *packages.Package, file *ast.File) string {
	if pkg == nil || pkg.Fset == nil || file == nil {
		return ""
	}
	tf := pkg.Fset.File(file.Pos())
	if tf == nil {
		return ""
	}
	src, err := os.ReadFile(tf.Name())
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(src)
	return hex.EncodeToString(sum[:])
}

type collector struct {
	info     *types.Info
	fset     *token.FileSet
	tf       *token.File
	src      []byte
	opts     Options
	out      []emit.FactEvidence
	consumed map[ast.Node]bool // duration expressions already reported as bound values
}

// Collect walks every function declaration body of file (closures belong to
// the declaration) and every package-level const and var value (attributed to
// that variable), and returns the file's evidence sorted by line, then kind,
// then text, at most MaxEvidencePerFile records.
func Collect(pkg *packages.Package, file *ast.File, relFile string, opts Options) []emit.FactEvidence {
	if pkg == nil || pkg.TypesInfo == nil || pkg.Fset == nil || file == nil {
		return nil
	}
	c := &collector{
		info:     pkg.TypesInfo,
		fset:     pkg.Fset,
		tf:       pkg.Fset.File(file.Pos()),
		src:      readSource(pkg.Fset, file),
		opts:     opts,
		consumed: map[ast.Node]bool{},
	}
	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Body == nil || d.Name == nil {
				continue
			}
			c.inspect(d.Body, symbols.FuncDeclSymbolID(relFile, d))
		case *ast.GenDecl:
			if d.Tok != token.CONST && d.Tok != token.VAR {
				continue
			}
			for _, spec := range d.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				owner := func(i int) string {
					if i < len(vs.Names) && vs.Names[i].Name != "_" {
						return symbols.SymbolID(relFile, vs.Names[i].Name, "variable")
					}
					return ""
				}
				for i, value := range vs.Values {
					sid := owner(i)
					if len(vs.Values) != len(vs.Names) {
						sid = owner(0)
					} else {
						c.binding(vs.Names[i], vs.Names[i].Name, value, sid)
					}
					c.inspect(value, sid)
				}
			}
		}
	}
	sort.SliceStable(c.out, func(i, j int) bool {
		a, b := c.out[i], c.out[j]
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Text < b.Text
	})
	return c.out
}

func (c *collector) add(sid string, pos token.Pos, e emit.FactEvidence) {
	if len(c.out) >= MaxEvidencePerFile {
		return
	}
	e.SymbolID = sid
	e.Line = c.fset.Position(pos).Line - 1
	c.out = append(c.out, e)
}

// text is the node's source, or its printed form when the source is not
// available.
func (c *collector) text(n ast.Node) string {
	if c.src != nil && c.tf != nil {
		start, end := c.tf.Offset(n.Pos()), c.tf.Offset(n.End())
		if start >= 0 && end <= len(c.src) && start <= end {
			return string(c.src[start:end])
		}
	}
	var buf bytes.Buffer
	_ = printer.Fprint(&buf, c.fset, n)
	return buf.String()
}

func (c *collector) inspect(root ast.Node, sid string) {
	ast.Inspect(root, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.IfStmt:
			c.condition(x.Cond, sid)
		case *ast.ForStmt:
			if x.Cond != nil {
				c.condition(x.Cond, sid)
			}
		case *ast.SwitchStmt:
			c.switchCases(x, sid)
		case *ast.CallExpr:
			c.call(x, sid)
		case *ast.ValueSpec:
			if len(x.Values) == len(x.Names) {
				for i, v := range x.Values {
					c.binding(x.Names[i], x.Names[i].Name, v, sid)
				}
			}
		case *ast.AssignStmt:
			if (x.Tok == token.ASSIGN || x.Tok == token.DEFINE) && len(x.Lhs) == len(x.Rhs) {
				for i, lhs := range x.Lhs {
					if name := assignedName(lhs); name != "" {
						c.binding(lhs, name, x.Rhs[i], sid)
					}
				}
			}
		case *ast.KeyValueExpr:
			if key, ok := x.Key.(*ast.Ident); ok {
				if field, ok := c.info.Uses[key].(*types.Var); ok && field.IsField() {
					c.binding(key, key.Name, x.Value, sid)
				}
			}
		case *ast.BinaryExpr:
			if !c.consumed[x] {
				if d, ok := c.duration(x); ok {
					c.add(sid, x.Pos(), d)
				}
			}
		}
		return true
	})
}

func assignedName(lhs ast.Expr) string {
	switch x := lhs.(type) {
	case *ast.Ident:
		if x.Name != "_" {
			return x.Name
		}
	case *ast.SelectorExpr:
		return x.Sel.Name
	}
	return ""
}

func unparen(e ast.Expr) ast.Expr {
	for {
		p, ok := e.(*ast.ParenExpr)
		if !ok {
			return e
		}
		e = p.X
	}
}

// condition reports the comparisons of a condition, through &&, ||, ! and
// parentheses.
func (c *collector) condition(e ast.Expr, sid string) {
	switch x := e.(type) {
	case *ast.ParenExpr:
		c.condition(x.X, sid)
	case *ast.UnaryExpr:
		if x.Op == token.NOT {
			c.condition(x.X, sid)
		}
	case *ast.BinaryExpr:
		switch x.Op {
		case token.LAND, token.LOR:
			c.condition(x.X, sid)
			c.condition(x.Y, sid)
		case token.EQL, token.NEQ, token.LSS, token.LEQ, token.GTR, token.GEQ:
			left, right := c.literalKind(x.X), c.literalKind(x.Y)
			if (left == "") == (right == "") {
				return
			}
			literal, kind := x.X, left
			if left == "" {
				literal, kind = x.Y, right
			}
			c.add(sid, x.Pos(), emit.FactEvidence{
				Kind: "comparison", Text: c.text(x), Operator: x.Op.String(),
				Literal: c.text(literal), LiteralKind: kind,
			})
		}
	}
}

// switchCases reports a tagless switch's case expressions as conditions and
// a tagged switch's literal case values as "<tag> case <value>".
func (c *collector) switchCases(s *ast.SwitchStmt, sid string) {
	if s.Body == nil {
		return
	}
	subject := ""
	if s.Tag != nil {
		subject = c.text(s.Tag)
	}
	for _, stmt := range s.Body.List {
		clause, ok := stmt.(*ast.CaseClause)
		if !ok {
			continue
		}
		for _, value := range clause.List {
			if s.Tag == nil {
				c.condition(value, sid)
				continue
			}
			kind := c.literalKind(value)
			if kind == "" {
				continue
			}
			c.add(sid, value.Pos(), emit.FactEvidence{
				Kind: "comparison", Text: subject + " case " + c.text(value), Operator: "case",
				Literal: c.text(value), LiteralKind: kind,
			})
		}
	}
}

// literalKind is the literal kind of an operand: number (optionally signed),
// string, char, and nil, true and false when they resolve to the universe.
func (c *collector) literalKind(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.BasicLit:
		switch x.Kind {
		case token.INT, token.FLOAT:
			return "number"
		case token.CHAR:
			return "char"
		case token.STRING:
			return "string"
		}
	case *ast.UnaryExpr:
		if lit, ok := x.X.(*ast.BasicLit); ok && (x.Op == token.SUB || x.Op == token.ADD) &&
			(lit.Kind == token.INT || lit.Kind == token.FLOAT) {
			return "number"
		}
	case *ast.Ident:
		obj := c.info.Uses[x]
		if obj == nil || obj.Parent() != types.Universe {
			return ""
		}
		switch obj.(type) {
		case *types.Nil:
			return "null"
		case *types.Const:
			if x.Name == "true" || x.Name == "false" {
				return "boolean"
			}
		}
	}
	return ""
}

// binding reports a bound value: a time.Duration value as a named duration,
// any other value only when the name has a retry or timeout fragment.
func (c *collector) binding(at ast.Node, name string, value ast.Expr, sid string) {
	inner := unparen(value)
	if d, ok := c.duration(inner); ok {
		c.consumed[inner] = true
		d.Name = name
		c.add(sid, inner.Pos(), d)
		return
	}
	if unit, constName, ok := c.timeConst(inner); ok {
		c.add(sid, inner.Pos(), emit.FactEvidence{
			Kind: "duration", Text: c.text(inner), Name: name,
			Constructor: "time." + constName, Unit: unit, Amount: "1",
		})
		return
	}
	if !HasRetryTimeoutFragment(name) {
		return
	}
	v := c.text(value)
	c.add(sid, at.Pos(), emit.FactEvidence{Kind: "binding", Text: name + " = " + v, Name: name, Value: v})
}

// timeConst resolves a time.<Unit> constant (through any import name).
func (c *collector) timeConst(e ast.Expr) (unit, name string, ok bool) {
	sel, isSel := unparen(e).(*ast.SelectorExpr)
	if !isSel {
		return "", "", false
	}
	k, isConst := c.info.Uses[sel.Sel].(*types.Const)
	if !isConst || k.Pkg() == nil || k.Pkg().Path() != "time" {
		return "", "", false
	}
	unit, ok = durationUnits[k.Name()]
	return unit, k.Name(), ok
}

// duration matches n * time.<Unit> and time.Duration(n) * time.<Unit> (either
// order); the amount is the source of n.
func (c *collector) duration(e ast.Expr) (emit.FactEvidence, bool) {
	bin, ok := e.(*ast.BinaryExpr)
	if !ok || bin.Op != token.MUL {
		return emit.FactEvidence{}, false
	}
	other := bin.Y
	unit, name, isConst := c.timeConst(bin.X)
	if !isConst {
		other = bin.X
		unit, name, isConst = c.timeConst(bin.Y)
	}
	if !isConst {
		return emit.FactEvidence{}, false
	}
	if _, _, both := c.timeConst(other); both {
		return emit.FactEvidence{}, false
	}
	amount := unparen(other)
	if call, ok := amount.(*ast.CallExpr); ok && len(call.Args) == 1 && c.isDurationType(call.Fun) {
		amount = call.Args[0]
	}
	return emit.FactEvidence{
		Kind: "duration", Text: c.text(bin), Constructor: "time." + name, Unit: unit, Amount: c.text(amount),
	}, true
}

func (c *collector) isDurationType(fun ast.Expr) bool {
	var id *ast.Ident
	switch f := unparen(fun).(type) {
	case *ast.SelectorExpr:
		id = f.Sel
	case *ast.Ident:
		id = f
	default:
		return false
	}
	tn, ok := c.info.Uses[id].(*types.TypeName)
	return ok && tn.Pkg() != nil && tn.Pkg().Path() == "time" && tn.Name() == "Duration"
}

// call reports x.m(...) calls matching a normalization pattern and routes.
func (c *collector) call(call *ast.CallExpr, sid string) {
	sel, ok := unparen(call.Fun).(*ast.SelectorExpr)
	if !ok {
		return
	}
	method, qualifier := sel.Sel.Name, c.text(sel.X)
	if MatchesPattern(method, qualifier, c.opts.NormalizationMethods) {
		c.add(sid, call.Pos(), emit.FactEvidence{Kind: "call", Text: c.text(call), Method: method, Qualifier: qualifier})
	}
	if verb, route, ok := c.route(call, sel); ok {
		c.add(sid, call.Pos(), emit.FactEvidence{Kind: "route", Text: c.text(call), Verb: verb, Route: route})
	}
}

// route resolves net/http.HandleFunc and Handle, (*net/http.ServeMux).HandleFunc
// and Handle, and the gin RouterGroup verb methods, Any and Handle, with a
// constant string path.
func (c *collector) route(call *ast.CallExpr, sel *ast.SelectorExpr) (verb, route string, ok bool) {
	fn, isFunc := c.info.Uses[sel.Sel].(*types.Func)
	if !isFunc || fn.Pkg() == nil {
		return "", "", false
	}
	sig, isSig := fn.Type().(*types.Signature)
	if !isSig {
		return "", "", false
	}
	recv := ""
	if sig.Recv() != nil {
		named := namedType(sig.Recv().Type())
		if named == nil || named.Obj().Pkg() == nil {
			return "", "", false
		}
		if named.Obj().Pkg().Path() != fn.Pkg().Path() {
			return "", "", false
		}
		recv = named.Obj().Name()
	}
	name := fn.Name()
	switch {
	case fn.Pkg().Path() == "net/http" && (recv == "" || recv == "ServeMux") && (name == "HandleFunc" || name == "Handle"):
		pattern, isStr := c.constString(call, 0)
		if !isStr {
			return "", "", false
		}
		return httpPattern(pattern)
	case fn.Pkg().Path() == ginPath && recv == "RouterGroup":
		if v, known := ginVerbs[name]; known {
			path, isStr := c.constString(call, 0)
			return v, path, isStr
		}
		if name == "Handle" {
			method, isMethod := c.constString(call, 0)
			path, isPath := c.constString(call, 1)
			return method, path, isMethod && isPath && method != ""
		}
	}
	return "", "", false
}

// httpPattern splits a net/http pattern "[METHOD ][HOST]/[PATH]" into a verb
// (ANY without a method) and its path.
func httpPattern(pattern string) (verb, route string, ok bool) {
	verb, rest := "ANY", strings.TrimSpace(pattern)
	if i := strings.IndexAny(rest, " \t"); i >= 0 {
		verb, rest = rest[:i], strings.TrimLeft(rest[i:], " \t")
	}
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return "", "", false
	}
	return verb, rest[slash:], true
}

func (c *collector) constString(call *ast.CallExpr, i int) (string, bool) {
	if i >= len(call.Args) {
		return "", false
	}
	tv, ok := c.info.Types[call.Args[i]]
	if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
		return "", false
	}
	return constant.StringVal(tv.Value), true
}

func namedType(t types.Type) *types.Named {
	if p, ok := types.Unalias(t).(*types.Pointer); ok {
		t = p.Elem()
	}
	named, _ := types.Unalias(t).(*types.Named)
	return named
}
