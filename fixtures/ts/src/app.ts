import { Greeter, greet, type Person } from './greeter'

const alice: Person = { name: 'Alice', age: 30 }
const greeter = new Greeter('>>')

console.log(greet('world'))
console.log(greeter.greetPerson(alice))
