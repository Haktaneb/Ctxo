using Xunit;

namespace CsharpV2Sample.Tests;

public sealed class ArgsAttribute : System.Attribute
{
    public ArgsAttribute(params int[] values)
    {
        Values = values;
    }

    public int[] Values { get; }
}

public sealed class NoteAttribute : System.Attribute
{
    public NoteAttribute(string text)
    {
        Text = text;
    }

    public string Text { get; }
}

public class LoanPolicyTests
{
    // 50 characters; LongText repeats it five times (250 characters).
    private const string Chunk = "Overdue fines accrue daily until the loan returns.";
    private const string LongText = Chunk + Chunk + Chunk + Chunk + Chunk;

    [Fact]
    [Trait("Rule", "LEND-03")]
    public void MemberHoldsAtMostFiveLoans()
    {
    }

    [Theory, Trait("Kind", "Characterization")]
    public void CharacterizesOverdueFees()
    {
    }

    [Unresolved("x", Level = 2)]
    public void UsesAnUnresolvedAttribute()
    {
    }

    [Args(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)]
    public void HasTwelveArgs()
    {
    }

    [Note(LongText)]
    public void HasALongArg()
    {
    }

    [A0, A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24]
    public void HasTwentyFiveAttributes()
    {
    }
}
