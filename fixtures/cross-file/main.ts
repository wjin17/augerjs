import { formatDate, parseDate as pd } from "./utils.js";

export function processDate(s: string): string {
  const d = pd(s);
  return formatDate(d);
}
