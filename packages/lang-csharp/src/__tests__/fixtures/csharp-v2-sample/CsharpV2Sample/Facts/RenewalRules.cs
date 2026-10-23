// Fact fixture (PR 4, issue #156): the syntax shapes both C# tiers must read alike. Only the
// tier-agreement test reads this file; it pins no table of its own.
using System;
using Microsoft.AspNetCore.Builder;

namespace Lending.Facts
{
    public class RenewalBase
    {
        public RenewalBase(int timeout)
        {
        }
    }

    public interface IRenewable
    {
        bool CanRenew(int days);
    }

    public sealed class ShelfRenewal : IRenewable
    {
        bool IRenewable.CanRenew(int days)
        {
            if (days > 30) return false;
            return true;
        }
    }

    public sealed record RenewalOptions
    {
        public int Timeout { get; init; }
        public int RetryLimit { get; init; }
    }

    public class RenewalRules : RenewalBase
    {
        private static readonly int retryFloor;
        private int holdDelay = 45, graceDays = 9, expiryHours = 72;

        public int MaxRenewals { get; set; } = 6;

        public static TimeSpan LoanTtl { get; } = TimeSpan.FromDays(21);

        public int Window => holdDelay is > 30 ? 2 : 3;

        public int Grace
        {
            get
            {
                if (graceDays < 12) return 1;
                return 0;
            }
            set => holdDelay = value > 40 ? value : 40;
        }

        public event EventHandler? Renewed
        {
            add { if (expiryHours > 48) { } }
            remove { }
        }

        static RenewalRules()
        {
            retryFloor = 2;
            if (retryFloor >= 4) { }
        }

        public RenewalRules(int limit) : base(timeout: 15)
        {
            int attemptLimit = (8);
            var backoffSeconds = limit * 3;
            if (limit is 3 && attemptLimit > 2) { }
            while (limit < 20) limit++;
            do { limit--; } while (!(limit >= 11));
            for (var i = 0; i < 13; i++) { }
        }

        public string Status(int renewals, string? member, char tier) =>
            renewals switch
            {
                0 => "new",
                > 5 when member == "staff" => "capped",
                7 or 8 => "warn",
                _ => tier == 'g' ? "gold" : "plain",
            };

        public int Check(int days, string code, long fine)
        {
            switch (days)
            {
                case 14:
                case > 28:
                    return 1;
                case int d when d < -3:
                    return 2;
            }

            try
            {
                Notify(retryAttempts: 4, label: "x");
            }
            catch (InvalidOperationException e) when (e.HResult == 409)
            {
            }

            if (days is > 21 && code != "LATE") return 3;
            if (code is "A" or "B") return 4;
            if (code is not "Z") return 5;
            if (days is (> 2 and < 6)) return 6;
            if (fine == -25 || fine > (99)) return 7;
            if (fine == +5L) return 8;
            if (code == @"Hold" && code != """Raw""") return 9;
            if (code == $"{days}") return 10;
            if (code is not "LOST" and not "DAMAGED") return 13;
            var shelf = (code) switch { "REF" => 1, _ => 0 };
            switch (days)
            {
                case not 0 and < 45:
                    return 14;
            }

            bool Late(int n) => n >= 35;
            Func<int, bool> early = n => n <= 2;
            return Late(days) || early(days) ? 11 : 12;
        }

        public string Normalize(string? email, string name)
        {
            var trimmed = email?.Trim();
            var upper = name.Trim().ToUpperInvariant();
            return name.Normalize() + trimmed + upper.ToLower();
        }

        public RenewalOptions Options()
        {
            var options = new RenewalOptions { Timeout = 30, RetryLimit = 5 };
            var anonymous = new { RetryDelay = 250, Name = "renewal" };
            options = options with { Timeout = 60 };
            var pause = TimeSpan.FromMilliseconds(500);
            var waitTimeout = System.TimeSpan.FromHours(2);
            Schedule(TimeSpan.FromSeconds(10));
            Schedule(delay: TimeSpan.FromMinutes(1.5));
            holdDelay = 50;
            this.holdDelay = 55;
            const int retryBudget = 2 * 60 * 1000;
            var holds = new System.Collections.Generic.Dictionary<string, TimeSpan>();
            holds["reserve"] = TimeSpan.FromHours(3);
            return options;
        }

        public void Map(WebApplication app)
        {
            app.MapPut(@"/renewals/{id}", (int id) => id);
            app.MapDelete("""/renewals/{id}""", (int id) => id);
            app.MapPatch($"/renewals/{1}", () => 0);
            app.MapPatch("/renewals"u8, () => 0);
            app.MapGet("/renewals/A", () => 0);
        }

        public int this[int index]
        {
            get
            {
                if (index > 90) return 1;
                return 0;
            }
        }

        public static RenewalRules operator +(RenewalRules a, RenewalRules b)
        {
            if (a.holdDelay > 91) return a;
            return b;
        }

        public static explicit operator int(RenewalRules r) => r.holdDelay > 92 ? 1 : 0;

        ~RenewalRules()
        {
            if (holdDelay > 93) { }
        }

        public enum Level
        {
            Low = 94,
            High = 95,
        }

        public class Nested
        {
            public int RetryWindow = 17;

            public bool Due(int overdueDays) => overdueDays > 60;

            private bool Hidden(int timeoutSeconds = 77) => timeoutSeconds > 61;
        }

        private static void Notify(int retryAttempts, string label)
        {
        }

        private static void Schedule(TimeSpan delay)
        {
        }
    }
}
