// Accepted tier difference (PR 4, issue #156): an explicit implementation of an interface from
// another namespace, written by its simple name. Roslyn names the member after the interface's real
// namespace; the syntax tier can only assume the member's own namespace.
using Lending.Facts.Contracts;

namespace Lending.Facts.Contracts
{
    public interface IExtendable
    {
        bool Extend(int days);
    }
}

namespace Lending.Facts.Differences
{
    public sealed class ExternalRenewal : IExtendable
    {
        bool IExtendable.Extend(int days)
        {
            if (days > 21) return false;
            return true;
        }
    }
}
