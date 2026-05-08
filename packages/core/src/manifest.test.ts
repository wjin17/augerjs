import { describe, it, expect } from "vitest";
import { loadManifest } from "./manifest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmp(content: string): string {
  const path = join(tmpdir(), `auger-manifest-${Date.now()}-${Math.random()}.yml`);
  writeFileSync(path, content);
  return path;
}

describe("loadManifest", () => {
  it("parses a minimal valid manifest", () => {
    const path = tmp(`
version: 1
project:
  name: my-app
languages:
  - name: typescript
include:
  - "src/**/*"
`);
    const m = loadManifest(path);
    unlinkSync(path);
    expect(m.project.name).toBe("my-app");
    expect(m.languages).toHaveLength(1);
    expect(m.include).toEqual(["src/**/*"]);
  });

  it("parses typescript and ruby together", () => {
    const path = tmp(`
version: 1
project:
  name: mixed
languages:
  - name: typescript
  - name: ruby
    rails: true
include:
  - "src/**/*"
`);
    const m = loadManifest(path);
    unlinkSync(path);
    expect(m.languages).toHaveLength(2);
    const ruby = m.languages.find((l) => l.name === "ruby");
    expect(ruby).toBeDefined();
  });

  it("applies default debounce when watch key is absent", () => {
    const path = tmp(`
version: 1
project:
  name: test
languages:
  - name: typescript
include:
  - "src/**/*"
`);
    const m = loadManifest(path);
    unlinkSync(path);
    expect(m.watch).toBeUndefined();
  });

  it("respects explicit debounce value", () => {
    const path = tmp(`
version: 1
project:
  name: test
languages:
  - name: typescript
include:
  - "src/**/*"
watch:
  debounce: 500
`);
    const m = loadManifest(path);
    unlinkSync(path);
    expect(m.watch?.debounce).toBe(500);
  });

  it("accepts optional exclude, output, and mcp fields", () => {
    const path = tmp(`
version: 1
project:
  name: test
languages:
  - name: typescript
include:
  - "src/**/*"
exclude:
  - "node_modules/**"
mcp:
  transport: stdio
`);
    const m = loadManifest(path);
    unlinkSync(path);
    expect(m.exclude).toEqual(["node_modules/**"]);
    expect(m.mcp?.transport).toBe("stdio");
  });

  it("throws on wrong version number", () => {
    const path = tmp(`
version: 2
project:
  name: test
languages: []
include: []
`);
    expect(() => loadManifest(path)).toThrow();
    unlinkSync(path);
  });

  it("throws when required fields are missing", () => {
    const path = tmp(`version: 1`);
    expect(() => loadManifest(path)).toThrow();
    unlinkSync(path);
  });

  it("throws on unknown language name", () => {
    const path = tmp(`
version: 1
project:
  name: test
languages:
  - name: python
include:
  - "src/**/*"
`);
    expect(() => loadManifest(path)).toThrow();
    unlinkSync(path);
  });
});
