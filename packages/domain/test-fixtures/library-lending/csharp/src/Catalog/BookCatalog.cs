using LibraryLending.Lending;

namespace LibraryLending.Catalog;

public static class BookCatalog
{
    public static string DescribeLimit(string title)
    {
        return title + " can be borrowed with up to " + LoanLimit.MaxLoans + " other books";
    }
}
