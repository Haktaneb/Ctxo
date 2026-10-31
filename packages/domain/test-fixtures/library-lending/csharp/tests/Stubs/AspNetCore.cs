// Minimal stand-ins for the ASP.NET Core MVC types, so the sample needs no package reference.
namespace Microsoft.AspNetCore.Mvc;

[AttributeUsage(AttributeTargets.Class)]
public sealed class ApiControllerAttribute : Attribute
{
}

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
public sealed class RouteAttribute : Attribute
{
    public RouteAttribute(string template)
    {
        Template = template;
    }

    public string Template { get; }
}

[AttributeUsage(AttributeTargets.Method)]
public sealed class HttpGetAttribute : Attribute
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

[AttributeUsage(AttributeTargets.Method)]
public sealed class HttpPostAttribute : Attribute
{
    public HttpPostAttribute()
    {
    }

    public HttpPostAttribute(string template)
    {
        Template = template;
    }

    public string? Template { get; }
}

public abstract class ControllerBase
{
}
