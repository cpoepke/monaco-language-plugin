from app.greeter import Greeter, greet

greeter = Greeter(">>")
print(greet("world"))
print(greeter.greet_person("Alice"))
