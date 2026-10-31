// Package gin is a stand-in for github.com/gin-gonic/gin with only the
// routing shapes the fact collector resolves.
package gin

type HandlerFunc func()

type IRoutes interface{}

type RouterGroup struct{}

type Engine struct{ RouterGroup }

func (g *RouterGroup) GET(path string, handlers ...HandlerFunc) IRoutes  { return nil }
func (g *RouterGroup) POST(path string, handlers ...HandlerFunc) IRoutes { return nil }
func (g *RouterGroup) Any(path string, handlers ...HandlerFunc) IRoutes  { return nil }
func (g *RouterGroup) Handle(method, path string, handlers ...HandlerFunc) IRoutes {
	return nil
}
