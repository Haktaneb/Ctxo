// Package sqlsites finds raw SQL text at known database API call sites
// (database/sql, sqlx, pgx v4 and v5 with pgxpool, gorm) so the TypeScript
// side can turn it into data edges. Matching is type-resolved: the callee
// must be a *types.Func of a known package, type and member.
package sqlsites

import (
	"go/ast"
	"go/constant"
	"go/types"
	"sort"

	"golang.org/x/tools/go/packages"

	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/emit"
	"github.com/alperhankendi/ctxo/tools/ctxo-go-analyzer/internal/symbols"
)

// statementKind is the only kind Go call sites report.
const statementKind = "statement"

type knownApi struct {
	types   map[string]bool // receiver type names; "" stands for a package function
	members map[string]bool
}

func set(names ...string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

var (
	databaseSQLMembers = set("Query", "QueryContext", "QueryRow", "QueryRowContext",
		"Exec", "ExecContext", "Prepare", "PrepareContext")
	sqlxMembers = set("Select", "Get", "Queryx", "NamedExec", "MustExec")
	pgxMembers  = set("Query", "QueryRow", "Exec")
)

// knownApis is the Go part of the known-API table, keyed by package path.
// *sql.Stmt is listed, but its methods have no string parameter: the SQL is
// read at Prepare.
var knownApis = map[string]knownApi{
	"database/sql":                    {set("DB", "Tx", "Conn", "Stmt"), databaseSQLMembers},
	"github.com/jmoiron/sqlx":         {set("DB", "Tx", "Conn", ""), sqlxMembers},
	"github.com/jackc/pgx/v5":         {set("Conn", "Tx"), pgxMembers},
	"github.com/jackc/pgx/v4":         {set("Conn", "Tx"), pgxMembers},
	"github.com/jackc/pgx/v5/pgxpool": {set("Pool", "Conn", "Tx"), pgxMembers},
	"github.com/jackc/pgx/v4/pgxpool": {set("Pool", "Conn", "Tx"), pgxMembers},
	"gorm.io/gorm":                    {set("DB"), set("Raw", "Exec")},
}

// Collect walks every function declaration body of file, closures included
// (they belong to the declaration), and returns one record per known call
// whose SQL argument is a string constant, sorted by line, then text. The
// SQL argument is the one bound to the callee's first string parameter; a
// known callee without one is not counted. stats, when not nil, gains one
// Constant per record and one NonConstant per other SQL argument.
func Collect(pkg *packages.Package, file *ast.File, relFile string, stats *emit.SqlStats) []emit.SqlCallSite {
	if pkg == nil || pkg.TypesInfo == nil || pkg.Fset == nil || file == nil {
		return nil
	}
	var out []emit.SqlCallSite
	for _, decl := range file.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Body == nil || fd.Name == nil {
			continue
		}
		symbolID := symbols.FuncDeclSymbolID(relFile, fd)
		ast.Inspect(fd.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			arg := sqlArgument(pkg.TypesInfo, call)
			if arg == nil {
				return true
			}
			tv, ok := pkg.TypesInfo.Types[arg]
			if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
				if stats != nil {
					stats.NonConstant++
				}
				return true
			}
			if stats != nil {
				stats.Constant++
			}
			out = append(out, emit.SqlCallSite{
				SymbolID: symbolID,
				Line:     pkg.Fset.Position(arg.Pos()).Line - 1,
				Text:     constant.StringVal(tv.Value),
				Kind:     statementKind,
			})
			return true
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Line != out[j].Line {
			return out[i].Line < out[j].Line
		}
		return out[i].Text < out[j].Text
	})
	return out
}

// sqlArgument returns the argument bound to the first string parameter of a
// known callee, or nil when the call is not a known API or the callee has no
// string parameter.
func sqlArgument(info *types.Info, call *ast.CallExpr) ast.Expr {
	ident, sel := calleeIdent(call.Fun)
	if ident == nil {
		return nil
	}
	fn, ok := info.Uses[ident].(*types.Func)
	if !ok || !isKnown(info, fn, sel) {
		return nil
	}
	sig, ok := fn.Type().(*types.Signature)
	if !ok {
		return nil
	}
	params := sig.Params()
	for i := 0; i < params.Len(); i++ {
		if sig.Variadic() && i == params.Len()-1 {
			break
		}
		if !isString(params.At(i).Type()) {
			continue
		}
		if i >= len(call.Args) {
			return nil
		}
		return call.Args[i]
	}
	return nil
}

// isKnown matches fn against the table. A method is named by its receiver
// type (pointer stripped); when that is not a named type (an interface
// literal), the selection's receiver is used instead.
func isKnown(info *types.Info, fn *types.Func, sel *ast.SelectorExpr) bool {
	sig, ok := fn.Type().(*types.Signature)
	if !ok {
		return false
	}
	if sig.Recv() == nil {
		pkg := fn.Pkg()
		if pkg == nil {
			return false
		}
		api, ok := knownApis[pkg.Path()]
		return ok && api.types[""] && api.members[fn.Name()]
	}
	named := namedType(sig.Recv().Type())
	if named == nil && sel != nil {
		if s, ok := info.Selections[sel]; ok {
			named = namedType(s.Recv())
		}
	}
	if named == nil || named.Obj().Pkg() == nil {
		return false
	}
	api, ok := knownApis[named.Obj().Pkg().Path()]
	return ok && api.types[named.Obj().Name()] && api.members[fn.Name()]
}

func namedType(t types.Type) *types.Named {
	if p, ok := types.Unalias(t).(*types.Pointer); ok {
		t = p.Elem()
	}
	named, _ := types.Unalias(t).(*types.Named)
	return named
}

func isString(t types.Type) bool {
	b, ok := t.Underlying().(*types.Basic)
	return ok && b.Kind() == types.String
}

// calleeIdent returns the identifier naming the called function, and the
// selector it sits in when the callee is x.Name.
func calleeIdent(expr ast.Expr) (*ast.Ident, *ast.SelectorExpr) {
	for {
		switch x := expr.(type) {
		case *ast.ParenExpr:
			expr = x.X
		case *ast.Ident:
			return x, nil
		case *ast.SelectorExpr:
			return x.Sel, x
		default:
			return nil, nil
		}
	}
}
