mod greeter;

use greeter::{greet, Greeter};

fn main() {
    let g = Greeter { prefix: ">>".to_string() };
    println!("{}", greet("world"));
    println!("{}", g.greet_person("Alice"));
}
