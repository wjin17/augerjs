import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ExtractedFile, ExtractedSymbol, ImportEntry } from "./typescript.js";

const REQUIRE_METHODS = new Set(["require_relative", "require"]);

const parser = new Parser();
parser.setLanguage(Ruby as any);

const ATTR_METHODS = new Set(["attr_reader", "attr_writer", "attr_accessor"]);
const ASSOCIATION_METHODS = new Set(["has_many", "has_one", "belongs_to", "has_and_belongs_to_many"]);
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

export type RubyParseOptions = { rails?: boolean };

export function parseRubyFile(filePath: string, options: RubyParseOptions = {}): ExtractedFile {
  const rails = options.rails ?? false;
  const content = readFileSync(filePath, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const tree = parser.parse(content, undefined, { bufferSize: Buffer.byteLength(content) + 4 });
  const symbols: ExtractedSymbol[] = [];

  const isRoutesFile =
    rails &&
    basename(filePath) === "routes.rb" &&
    basename(dirname(filePath)) === "config";

  if (isRoutesFile) {
    symbols.push(...parseRoutes(tree.rootNode, content));
    return { path: filePath, language: "ruby" as const, hash, symbols, imports: [] };
  }

  walk(tree.rootNode, null, content, symbols, rails, null);

  const imports = extractRubyImports(tree.rootNode, filePath, content);
  return { path: filePath, language: "ruby" as const, hash, symbols, imports };
}

function extractRubyImports(rootNode: Parser.SyntaxNode, filePath: string, source: string): ImportEntry[] {
  const imports: ImportEntry[] = [];
  const dir = dirname(filePath);

  function visit(node: Parser.SyntaxNode) {
    if (node.type === "call") {
      const methodNode = node.childForFieldName("method");
      if (methodNode) {
        const methodName = source.slice(methodNode.startIndex, methodNode.endIndex);
        if (methodName === "require_relative" || methodName === "require") {
          const argList = node.childForFieldName("arguments");
          if (argList && argList.namedChildCount > 0) {
            const arg = argList.namedChild(0)!;
            if (arg.type === "string") {
              const specifier = getStringContent(arg);
              if (specifier) {
                const isRelative =
                  methodName === "require_relative" ||
                  specifier.startsWith("./") ||
                  specifier.startsWith("../");
                if (isRelative) {
                  const resolved = resolveRubyPath(dir, specifier);
                  if (resolved) {
                    imports.push({ localName: resolved, exportedName: "*", sourcePath: resolved });
                  }
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!);
  }

  visit(rootNode);
  return imports;
}

function getStringContent(stringNode: Parser.SyntaxNode): string | null {
  for (let i = 0; i < stringNode.childCount; i++) {
    const child = stringNode.child(i)!;
    if (child.type === "string_content") return child.text;
  }
  return null;
}

function resolveRubyPath(dir: string, specifier: string): string | null {
  const base = resolve(dir, specifier);
  return existsSync(base + ".rb") ? base + ".rb" : existsSync(base) ? base : null;
}

function extractDocstring(node: Parser.SyntaxNode): string | null {
  const comments: string[] = [];
  let sib = node.previousNamedSibling;
  let expectedEndRow = node.startPosition.row - 1;
  while (sib && sib.type === "comment" && sib.endPosition.row === expectedEndRow) {
    comments.unshift(sib.text.replace(/^#\s?/, ""));
    expectedEndRow = sib.startPosition.row - 1;
    sib = sib.previousNamedSibling;
  }
  return comments.length > 0 ? comments.join("\n") : null;
}

// Scans the class subtree (not into method bodies) for the first bare private/protected.
// In tree-sitter-ruby, bare `private` is an `identifier` node; `private :foo` is a `call`.
// Returns the 1-based start line, or null if not found.
function findFirstPrivateLine(classNode: Parser.SyntaxNode, source: string): number | null {
  function scan(node: Parser.SyntaxNode): number | null {
    if (node.type === "method" || node.type === "singleton_method") return null;

    if (node.type === "identifier") {
      const name = source.slice(node.startIndex, node.endIndex);
      if (name === "private" || name === "protected") return node.startPosition.row + 1;
    }

    if (node.type === "call") {
      const m = node.childForFieldName("method");
      if (m) {
        const name = source.slice(m.startIndex, m.endIndex);
        if (name === "private" || name === "protected") {
          const args = node.childForFieldName("arguments");
          // bare call with no args: `private` (fallback if parser wraps it as a call)
          if (!args || args.namedChildCount === 0) return node.startPosition.row + 1;
          // `private :method_name` — marks individual methods, not a line boundary; skip subtree
          return null;
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const result = scan(node.namedChild(i)!);
      if (result !== null) return result;
    }
    return null;
  }
  return scan(classNode);
}

// actionPublicUntil:
//   null     — not inside a controller class
//   Infinity — inside a controller, no private found (all methods are public actions)
//   N        — inside a controller; methods at line >= N are private
function walk(
  node: Parser.SyntaxNode,
  parentName: string | null,
  source: string,
  out: ExtractedSymbol[],
  rails: boolean,
  actionPublicUntil: number | null,
) {
  if (node.type === "method" || node.type === "singleton_method") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      const isAction =
        actionPublicUntil !== null && node.startPosition.row + 1 < actionPublicUntil;
      out.push({
        name: source.slice(nameNode.startIndex, nameNode.endIndex),
        kind: isAction ? "action" : "method",
        signature: firstLine(source.slice(node.startIndex, node.endIndex)),
        docstring: extractDocstring(node),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parentName,
        callees: extractRubyCallees(node, source),
        isAnonymous: false,
      });
    }
  } else if (node.type === "class" || node.type === "module") {
    const nameNode = node.childForFieldName("name");
    const containerName = nameNode
      ? source.slice(nameNode.startIndex, nameNode.endIndex)
      : "<anonymous>";
    out.push({
      name: containerName,
      kind: "class",
      signature: `${node.type} ${containerName}`,
      docstring: null,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      parentName: null,
      callees: [],
      isAnonymous: false,
    });

    const isControllerClass = rails && containerName.endsWith("Controller");
    const newActionPublicUntil: number | null = isControllerClass
      ? (findFirstPrivateLine(node, source) ?? Infinity)
      : null;

    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i)!, containerName, source, out, rails, newActionPublicUntil);
    }
    return;
  } else if (node.type === "call") {
    const methodNode = node.childForFieldName("method");
    if (methodNode) {
      const methodName = source.slice(methodNode.startIndex, methodNode.endIndex);
      if (ATTR_METHODS.has(methodName)) {
        const argList = node.childForFieldName("arguments");
        const callSignature = firstLine(source.slice(node.startIndex, node.endIndex));
        if (argList) {
          for (let i = 0; i < argList.namedChildCount; i++) {
            const arg = argList.namedChild(i)!;
            if (arg.type === "simple_symbol") {
              const symName = source.slice(arg.startIndex, arg.endIndex).slice(1);
              out.push({
                name: symName,
                kind: "method",
                signature: callSignature,
                docstring: null,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                parentName,
                callees: [],
                isAnonymous: false,
              });
            }
          }
        }
        return;
      }

      if (rails && ASSOCIATION_METHODS.has(methodName)) {
        const argList = node.childForFieldName("arguments");
        if (argList && argList.namedChildCount > 0) {
          const arg = argList.namedChild(0)!;
          if (arg.type === "simple_symbol") {
            const assocName = source.slice(arg.startIndex, arg.endIndex).slice(1);
            out.push({
              name: assocName,
              kind: "method",
              signature: firstLine(source.slice(node.startIndex, node.endIndex)),
              docstring: extractDocstring(node),
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              parentName,
              callees: [],
              isAnonymous: false,
            });
          }
        }
        return;
      }
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i)!, parentName, source, out, rails, actionPublicUntil);
  }
}

function firstLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? "";
}

function extractRubyCallees(node: Parser.SyntaxNode, source: string): string[] {
  const callees = new Set<string>();
  function visit(n: Parser.SyntaxNode) {
    if (n.type === "call" || n.type === "method_call") {
      const methodNode = n.childForFieldName("method") ?? n.childForFieldName("name");
      if (methodNode) {
        const name = source.slice(methodNode.startIndex, methodNode.endIndex);
        if (/^[a-z_][\w]*[?!=]?$/.test(name)) callees.add(name);
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i)!);
  }
  visit(node);
  return [...callees];
}

// ── Routes parser ─────────────────────────────────────────────────────────────

function findBlock(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "do_block" || child.type === "brace_block") return child;
  }
  return null;
}

function extractRouteTo(argsNode: Parser.SyntaxNode, source: string): string | null {
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const arg = argsNode.namedChild(i)!;
    if (arg.type === "pair") {
      const key = arg.childForFieldName("key");
      const val = arg.childForFieldName("value");
      if (key && val) {
        const keyStr = source.slice(key.startIndex, key.endIndex).replace(/[:'"\s]/g, "");
        if (keyStr === "to") {
          return getStringContent(val) ?? source.slice(val.startIndex, val.endIndex).replace(/^["']|["']$/g, "");
        }
      }
    }
  }
  return null;
}

function parseRoutes(rootNode: Parser.SyntaxNode, source: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  function visit(node: Parser.SyntaxNode, scope: string) {
    if (node.type === "call") {
      const methodNode = node.childForFieldName("method");
      if (methodNode) {
        const verb = source.slice(methodNode.startIndex, methodNode.endIndex);
        const args = node.childForFieldName("arguments");

        if (HTTP_VERBS.has(verb) && args && args.namedChildCount > 0) {
          const pathArg = args.namedChild(0)!;
          const path = getStringContent(pathArg);
          if (path) {
            const fullPath = scope ? `${scope}${path.startsWith("/") ? path : `/${path}`}` : path;
            const to = extractRouteTo(args, source);
            symbols.push({
              name: `${verb.toUpperCase()} ${fullPath}`,
              kind: "route",
              signature: to
                ? `${verb.toUpperCase()} ${fullPath} → ${to}`
                : `${verb.toUpperCase()} ${fullPath}`,
              docstring: null,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              parentName: scope || null,
              callees: [],
              isAnonymous: false,
            });
          }
          return;
        }

        if (verb === "root" && args && args.namedChildCount > 0) {
          const arg = args.namedChild(0)!;
          const to =
            getStringContent(arg) ??
            source.slice(arg.startIndex, arg.endIndex).replace(/^["']|["']$/g, "");
          symbols.push({
            name: "GET /",
            kind: "route",
            signature: `root → ${to}`,
            docstring: null,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            parentName: scope || null,
            callees: [],
            isAnonymous: false,
          });
          return;
        }

        if ((verb === "resources" || verb === "resource") && args && args.namedChildCount > 0) {
          const arg = args.namedChild(0)!;
          if (arg.type === "simple_symbol") {
            const resourceName = source.slice(arg.startIndex, arg.endIndex).slice(1);
            const fullPath = scope ? `${scope}/${resourceName}` : `/${resourceName}`;
            symbols.push({
              name: `${verb} :${resourceName}`,
              kind: "route",
              signature: `${verb} :${resourceName}`,
              docstring: null,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              parentName: scope || null,
              callees: [],
              isAnonymous: false,
            });
            const block = findBlock(node);
            if (block) {
              for (let i = 0; i < block.namedChildCount; i++) {
                visit(block.namedChild(i)!, fullPath);
              }
              return;
            }
          }
          return;
        }

        if ((verb === "namespace" || verb === "scope") && args && args.namedChildCount > 0) {
          const arg = args.namedChild(0)!;
          let ns = "";
          if (arg.type === "simple_symbol") {
            ns = source.slice(arg.startIndex, arg.endIndex).slice(1);
          } else if (arg.type === "string") {
            ns = getStringContent(arg) ?? "";
          }
          const newScope = ns ? (scope ? `${scope}/${ns}` : `/${ns}`) : scope;
          const block = findBlock(node);
          if (block) {
            for (let i = 0; i < block.namedChildCount; i++) {
              visit(block.namedChild(i)!, newScope);
            }
            return;
          }
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      visit(node.namedChild(i)!, scope);
    }
  }

  visit(rootNode, "");
  return symbols;
}
