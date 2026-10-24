TIMEOUT_SECONDS = 30


def late_fee(days):
    if days > 14:
        return 2
    return 0
