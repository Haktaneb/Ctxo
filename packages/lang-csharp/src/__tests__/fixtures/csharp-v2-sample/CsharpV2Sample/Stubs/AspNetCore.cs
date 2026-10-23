// Stand-ins for the ASP.NET Core types the Facts fixtures use, so the fixture needs no NuGet restore.
namespace Microsoft.AspNetCore.Mvc
{
    public sealed class ApiControllerAttribute : System.Attribute
    {
    }

    public sealed class RouteAttribute : System.Attribute
    {
        public RouteAttribute(string template)
        {
            Template = template;
        }

        public string Template { get; }
    }

    public sealed class HttpGetAttribute : System.Attribute
    {
        public HttpGetAttribute()
        {
        }

        public HttpGetAttribute(string template)
        {
            Template = template;
        }

        public string? Template { get; }
    }

    public sealed class HttpPostAttribute : System.Attribute
    {
        public HttpPostAttribute()
        {
        }
    }

    public abstract class ControllerBase
    {
    }
}

namespace Microsoft.AspNetCore.Builder
{
    public sealed class WebApplication
    {
        public void MapGet(string pattern, System.Delegate handler)
        {
        }

        public void MapPost(string pattern, System.Delegate handler)
        {
        }
    }
}
