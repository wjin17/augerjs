import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { parseTypeScriptFile } from "../src/parsers/typescript";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("typescript parser", () => {
  it("extracts functions, classes, methods, interfaces, types", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(
      resolve(__dirname, "../../../fixtures/typescript/sample.ts"),
      project
    );

    const names = result.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["Greeter", "User", "UserId", "add", "formatName", "greet"]);

    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet?.kind).toBe("method");
    expect(greet?.parentName).toBe("Greeter");
    expect(greet?.callees).toContain("formatName");
  });
});
