"""Greeting helpers. Docs: https://example.com/greeting-guide"""


def greet(name: str) -> str:
    """Build a friendly greeting for ``name``."""
    return f"Hello, {name}!"


class Greeter:
    """Greets people with a prefix."""

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix

    def greet_person(self, name: str) -> str:
        """Greet ``name`` using the configured prefix."""
        return f"{self.prefix} {greet(name)}"
