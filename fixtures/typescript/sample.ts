/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

/** A simple greeter. */
export class Greeter {
  /** Handles click. */
  onClick = () => {
    this.greet("user");
  };

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

/** Doubles a number. */
export const double = (n: number): number => n * 2;

/** Async greeter. */
export const greetAsync = async (name: string): Promise<string> =>
  `Hello, ${formatName(name)}`;

export const identity = <T>(x: T): T => x;

/** HTTP routes. */
export const routes = {
  get: (path: string) => formatName(path),
  post(path: string) { return formatName(path); },
};

export function processItems(items: number[]): number[] {
  const filtered = items.filter(n => n > 0);
  return filtered.map(n => n * 2);
}
