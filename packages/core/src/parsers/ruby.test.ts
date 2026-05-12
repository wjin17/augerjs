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

describe("ruby parser — Rails controller actions", () => {
  const controllerPath = resolve(__dirname, "../../../../fixtures/ruby/users_controller.rb");

  it("tags public controller methods as action kind", () => {
    const result = parseRubyFile(controllerPath, { rails: true });
    const index = result.symbols.find((s) => s.name === "index");
    expect(index?.kind).toBe("action");
    expect(index?.parentName).toBe("UsersController");
  });

  it("tags all CRUD actions correctly", () => {
    const result = parseRubyFile(controllerPath, { rails: true });
    const actions = result.symbols.filter((s) => s.kind === "action").map((s) => s.name);
    expect(actions).toContain("index");
    expect(actions).toContain("show");
    expect(actions).toContain("new");
    expect(actions).toContain("create");
  });

  it("does not tag private methods as actions", () => {
    const result = parseRubyFile(controllerPath, { rails: true });
    const setUser = result.symbols.find((s) => s.name === "set_user");
    expect(setUser?.kind).toBe("method");
    const userParams = result.symbols.find((s) => s.name === "user_params");
    expect(userParams?.kind).toBe("method");
  });

  it("does not tag controller methods as actions when rails is false", () => {
    const result = parseRubyFile(controllerPath);
    const index = result.symbols.find((s) => s.name === "index");
    expect(index?.kind).toBe("method");
  });
});

describe("ruby parser — Rails associations", () => {
  const postPath = resolve(__dirname, "../../../../fixtures/ruby/post.rb");

  it("extracts belongs_to as a method symbol", () => {
    const result = parseRubyFile(postPath, { rails: true });
    const user = result.symbols.find((s) => s.name === "user" && s.parentName === "Post");
    expect(user?.kind).toBe("method");
    expect(user?.signature).toMatch(/belongs_to/);
  });

  it("extracts has_many as a method symbol", () => {
    const result = parseRubyFile(postPath, { rails: true });
    const comments = result.symbols.find((s) => s.name === "comments");
    expect(comments?.kind).toBe("method");
  });

  it("extracts has_one as a method symbol", () => {
    const result = parseRubyFile(postPath, { rails: true });
    const metadata = result.symbols.find((s) => s.name === "metadata");
    expect(metadata?.kind).toBe("method");
  });

  it("extracts has_and_belongs_to_many as a method symbol", () => {
    const result = parseRubyFile(postPath, { rails: true });
    const tags = result.symbols.find((s) => s.name === "tags");
    expect(tags?.kind).toBe("method");
  });

  it("does not extract associations when rails is false", () => {
    const result = parseRubyFile(postPath);
    const names = result.symbols.map((s) => s.name);
    expect(names).not.toContain("user");
    expect(names).not.toContain("comments");
  });
});

describe("ruby parser — Rails routes", () => {
  const routesPath = resolve(__dirname, "../../../../fixtures/ruby/config/routes.rb");

  it("extracts root route", () => {
    const result = parseRubyFile(routesPath, { rails: true });
    const root = result.symbols.find((s) => s.name === "GET /");
    expect(root?.kind).toBe("route");
    expect(root?.signature).toMatch(/pages#home/);
  });

  it("extracts GET route with path and target", () => {
    const result = parseRubyFile(routesPath, { rails: true });
    const about = result.symbols.find((s) => s.name === "GET /about");
    expect(about?.kind).toBe("route");
    expect(about?.signature).toMatch(/pages#about/);
  });

  it("extracts POST route", () => {
    const result = parseRubyFile(routesPath, { rails: true });
    const contact = result.symbols.find((s) => s.name === "POST /contact");
    expect(contact?.kind).toBe("route");
  });

  it("extracts resources", () => {
    const result = parseRubyFile(routesPath, { rails: true });
    const users = result.symbols.find((s) => s.name === "resources :users");
    expect(users?.kind).toBe("route");
  });

  it("extracts namespaced resources", () => {
    const result = parseRubyFile(routesPath, { rails: true });
    const apiUsers = result.symbols.find((s) => s.name === "resources :users" && s.parentName === "/api");
    expect(apiUsers).toBeDefined();
  });

  it("returns no symbols when rails is false", () => {
    const result = parseRubyFile(routesPath);
    expect(result.symbols.length).toBe(0);
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
