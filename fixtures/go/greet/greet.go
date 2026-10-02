// Package greet builds greetings. See https://example.com/greeting-guide.
package greet

import "fmt"

// Greet builds a friendly greeting for name.
func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

// Greeter greets people with a prefix.
type Greeter struct {
	Prefix string
}

// GreetPerson greets name using the configured prefix.
func (g Greeter) GreetPerson(name string) string {
	return g.Prefix + " " + Greet(name)
}
