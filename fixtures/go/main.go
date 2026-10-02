package main

import (
	"fmt"

	"example.com/fixture/greet"
)

func main() {
	g := greet.Greeter{Prefix: ">>"}
	fmt.Println(greet.Greet("world"))
	fmt.Println(g.GreetPerson("Alice"))
}
