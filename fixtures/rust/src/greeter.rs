//! Greeting helpers. See <https://example.com/greeting-guide>.

/// Builds a friendly greeting for `name`.
pub fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}

/// Greets people with a prefix.
pub struct Greeter {
    pub prefix: String,
}

impl Greeter {
    /// Greets `name` using the configured prefix.
    pub fn greet_person(&self, name: &str) -> String {
        format!("{} {}", self.prefix, greet(name))
    }
}
