/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

/** A simple greeter. */
export class Greeter {
  /** Returns a greeting string. */
  greet(name: string): string {
    return `Hello, ${formatName(name)}`;
  }
}

function formatName(name: string): string {
  return name.trim();
}

export interface User {
  id: number;
  name: string;
}

export type UserId = User["id"];
