// Fact fixture (PR 4, issue #156): constants named after the FC-5 vectors that are C# identifiers.
// The first group gives retry-timeout facts, the second gives none.
namespace Lending.Facts;

public static class RetryNames
{
    public const int MaxRetries = 7;
    public const int MAX_RETRIES = 7;
    public const int retryCount = 7;
    public const int attempts = 7;
    public const int TimeOut = 7;
    public const int requestTimeoutMs = 7;
    public const int tokenTTL = 7;
    public const int ExpiryDays = 7;
    public const int backoffFactor = 7;
    public const int delayMs = 7;
    public const int HOLD_TIMEOUT = 7;
    public const int délaiRetry = 7;
    public const int retry2x = 7;
    public const int HTTPTimeout = 7;
    public const int ñretry = 7;

    public const int settlementDays = 7;
    public const int relay = 7;
    public const int delta = 7;
    public const int count = 7;
    public const int maxRétries = 7;
}
