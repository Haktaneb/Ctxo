namespace LibraryLending.Lending;

public static class MemberDirectory
{
    public static string Key(string email) => email.Trim().ToLowerInvariant();
}
