import { describe, it, expect } from "vitest";
import { parseRubyFile } from "./ruby";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ruby parser", () => {
  it("extracts class and methods", () => {
    const result = parseRubyFile(resolve(__dirname, "../../../../fixtures/ruby/sample.rb"));
    const names = result.symbols.map((s) => s.name).sort();
    expect(names).toContain("Greeter");
    expect(names).toContain("greet");
    expect(names).toContain("format_name");

    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet?.callees).toContain("format_name");
  });
});
