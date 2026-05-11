import { describe, it, expect } from "vitest";
import { parseRubyFile } from "./ruby";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ruby parser", () => {
  const fixturePath = resolve(__dirname, "../../../../fixtures/ruby/sample.rb");

  it("extracts module as class kind", () => {
    const result = parseRubyFile(fixturePath);
    const formatter = result.symbols.find((s) => s.name === "Formatter");
    expect(formatter).toBeDefined();
    expect(formatter?.kind).toBe("class");
  });

  it("extracts singleton_method inside module with correct parentName", () => {
    const result = parseRubyFile(fixturePath);
    const titleize = result.symbols.find((s) => s.name === "titleize");
    expect(titleize).toBeDefined();
    expect(titleize?.kind).toBe("method");
    expect(titleize?.parentName).toBe("Formatter");
  });

  it("extracts attr_accessor symbols", () => {
    const result = parseRubyFile(fixturePath);
    const name = result.symbols.find((s) => s.name === "name" && s.parentName === "Person");
    const age = result.symbols.find((s) => s.name === "age" && s.parentName === "Person");
    expect(name?.kind).toBe("method");
    expect(age?.kind).toBe("method");
  });

  it("extracts attr_reader symbol", () => {
    const result = parseRubyFile(fixturePath);
    const id = result.symbols.find((s) => s.name === "id" && s.parentName === "Person");
    expect(id?.kind).toBe("method");
  });

  it("extracts class method create with correct parentName", () => {
    const result = parseRubyFile(fixturePath);
    const create = result.symbols.find((s) => s.name === "create");
    expect(create?.kind).toBe("method");
    expect(create?.parentName).toBe("Person");
  });

  it("extracts docstring on greet", () => {
    const result = parseRubyFile(fixturePath);
    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet?.docstring).toBe("Returns a greeting.");
  });

  it("extracts docstring on initialize", () => {
    const result = parseRubyFile(fixturePath);
    const init = result.symbols.find((s) => s.name === "initialize");
    expect(init?.docstring).toBe("Creates a new person.");
  });

  it("extracts class and instance methods", () => {
    const result = parseRubyFile(fixturePath);
    const names = result.symbols.map((s) => s.name).sort();
    expect(names).toContain("Person");
    expect(names).toContain("greet");
    expect(names).toContain("format_name");
  });

  it("extracts callees from greet", () => {
    const result = parseRubyFile(fixturePath);
    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet?.callees).toContain("titleize");
  });
});

describe("ruby parser — imports", () => {
  const personPath = resolve(__dirname, "../../../../fixtures/ruby/person.rb");
  const formatterPath = resolve(__dirname, "../../../../fixtures/ruby/formatter.rb");

  it("extracts require_relative as a wildcard import entry", () => {
    const result = parseRubyFile(personPath);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].sourcePath).toBe(formatterPath);
    expect(result.imports[0].exportedName).toBe("*");
  });

  it("returns no imports for a file with no requires", () => {
    const result = parseRubyFile(formatterPath);
    expect(result.imports).toHaveLength(0);
  });
});
