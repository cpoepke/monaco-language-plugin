/**
 * Builds a friendly greeting.
 * See https://example.com/greeting-guide for the style rules.
 */
export function greet(name: string): string {
  return `Hello, ${name}!`
}

/** A person who can be greeted. */
export interface Person {
  name: string
  age: number
}

export class Greeter {
  constructor(private readonly prefix: string) {}

  /** Greets a {@link Person} using the configured prefix. */
  greetPerson(person: Person): string {
    return `${this.prefix} ${greet(person.name)}`
  }
}
