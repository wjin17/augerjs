import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { parseTypeScriptFile } from "./typescript";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(__dirname, "../../../../fixtures/typescript/sample.ts");

describe("typescript parser", () => {
  it("extracts named functions, classes, methods, interfaces, types", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const names = result.symbols.map((s) => s.name).sort();
    expect(names).toContain("add");
    expect(names).toContain("Greeter");
    expect(names).toContain("greet");
    expect(names).toContain("formatName");
    expect(names).toContain("User");
    expect(names).toContain("UserId");
  });

  it("extracts arrow function constants", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const names = result.symbols.map((s) => s.name).sort();
    expect(names).toContain("double");
    expect(names).toContain("greetAsync");
    expect(names).toContain("identity");
  });

  it("assigns kind=function to arrow constants", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "double");
    expect(sym?.kind).toBe("function");
  });

  it("builds a readable signature for arrow functions", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "double");
    expect(sym?.signature).toBe("const double = (n: number): number");
  });

  it("marks async arrow functions as async in signature", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "greetAsync");
    expect(sym?.signature).toMatch(/^const greetAsync = async/);
  });

  it("extracts callees from arrow function bodies", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "greetAsync");
    expect(sym?.callees).toContain("formatName");
  });

  it("preserves JsDoc on arrow functions", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "double");
    expect(sym?.docstring).toBe("Doubles a number.");
  });

  it("extracts method callee edges", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet?.callees).toContain("formatName");
  });

  it("extracts class field arrow functions as methods", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "onClick");
    expect(sym).toBeDefined();
    expect(sym?.kind).toBe("method");
    expect(sym?.parentName).toBe("Greeter");
    expect(sym?.isAnonymous).toBe(false);
  });

  it("preserves JsDoc on class field arrow functions", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "onClick");
    expect(sym?.docstring).toBe("Handles click.");
  });

  it("extracts object literal as constant with kind=constant", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "routes");
    expect(sym).toBeDefined();
    expect(sym?.kind).toBe("constant");
    expect(sym?.isAnonymous).toBe(false);
  });

  it("extracts object literal arrow property as method", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "get");
    expect(sym).toBeDefined();
    expect(sym?.kind).toBe("method");
    expect(sym?.parentName).toBe("routes");
    expect(sym?.isAnonymous).toBe(false);
  });

  it("extracts object literal shorthand method", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "post");
    expect(sym).toBeDefined();
    expect(sym?.kind).toBe("method");
    expect(sym?.parentName).toBe("routes");
    expect(sym?.isAnonymous).toBe(false);
  });

  it("extracts anonymous callbacks with synthetic names", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const anons = result.symbols.filter((s) => s.isAnonymous);
    expect(anons.length).toBeGreaterThan(0);
    for (const anon of anons) {
      expect(anon.name).toMatch(/^<anonymous:\d+/);
    }
  });

  it("extracts enum as kind=type", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "Direction");
    expect(sym?.kind).toBe("type");
    expect(sym?.isAnonymous).toBe(false);
  });

  it("extracts enum members as kind=constant with parentName", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const sym = result.symbols.find((s) => s.name === "Up");
    expect(sym?.kind).toBe("constant");
    expect(sym?.parentName).toBe("Direction");
  });

  it("sets parentName on anonymous callbacks to their enclosing function", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const anons = result.symbols.filter((s) => s.isAnonymous);
    expect(anons.every((s) => s.parentName === "processItems")).toBe(true);
  });

  it("marks all non-anonymous symbols as isAnonymous=false", () => {
    const project = new Project({ useInMemoryFileSystem: false });
    const result = parseTypeScriptFile(fixture, project);
    const named = result.symbols.filter((s) => !s.isAnonymous);
    expect(named.length).toBeGreaterThan(0);
    for (const sym of named) {
      expect(sym.name).not.toMatch(/^<anonymous/);
    }
  });
});
