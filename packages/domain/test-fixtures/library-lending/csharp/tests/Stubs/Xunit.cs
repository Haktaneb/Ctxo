// Minimal stand-ins for the xUnit attributes, so the sample needs no package reference.
namespace Xunit;

[AttributeUsage(AttributeTargets.Method)]
public sealed class FactAttribute : Attribute
{
}

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = true)]
public sealed class TraitAttribute : Attribute
{
    public TraitAttribute(string name, string value)
    {
        Name = name;
        Value = value;
    }

    public string Name { get; }

    public string Value { get; }
}
