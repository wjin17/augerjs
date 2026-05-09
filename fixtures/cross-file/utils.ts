export function formatDate(d: Date): string {
  return d.toISOString();
}

export function parseDate(s: string): Date {
  return new Date(s);
}
