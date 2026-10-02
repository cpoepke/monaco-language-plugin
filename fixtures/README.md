# Fixtures

Tiny multi-file projects used by the bridge integration tests and the demo e2e
tests. Each has an entry file that calls symbols defined in a second file:

| Language | Entry | Definition file | Symbols |
|---|---|---|---|
| TypeScript | `ts/src/app.ts` | `ts/src/greeter.ts` | `greet`, `Greeter`, `Person`, `greetPerson` |
| Python | `py/app/main.py` | `py/app/greeter.py` | `greet`, `Greeter`, `greet_person` |
| Go | `go/main.go` | `go/greet/greet.go` | `Greet`, `Greeter`, `GreetPerson` |
| Rust | `rust/src/main.rs` | `rust/src/greeter.rs` | `greet`, `Greeter`, `greet_person` |

Keep line numbers stable: tests assert definition locations.
