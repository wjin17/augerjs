import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtractedFile, ExtractedSymbol, ImportEntry } from "./typescript.js";

// TODO(rails): When manifest.languages includes { ruby: { rails: true } },
// also parse config/routes.rb for routes, scan ApplicationRecord subclasses
// for has_many/belongs_to associations, and tag controller actions
// (public methods on classes ending in 'Controller' under app/controllers).

const parser = new Parser();
parser.setLanguage(Ruby as any);

const ATTR_METHODS = new Set(["attr_reader", "attr_writer", "attr_accessor"]);

export function parseRubyFile(filePath: string): ExtractedFile {
  const content = readFileSync(filePath, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const tree = parser.parse(content);
  const symbols: ExtractedSymbol[] = [];

  walk(tree.rootNode, null, content, symbols);

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
  // Walk back through consecutive comment siblings immediately above this node.
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

function walk(
  node: Parser.SyntaxNode,
  parentName: string | null,
  source: string,
  out: ExtractedSymbol[]
) {
  if (node.type === "method") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      out.push({
        name: source.slice(nameNode.startIndex, nameNode.endIndex),
        kind: "method",
        signature: firstLine(source.slice(node.startIndex, node.endIndex)),
        docstring: extractDocstring(node),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parentName,
        callees: extractRubyCallees(node, source),
        isAnonymous: false,
      });
    }
  } else if (node.type === "singleton_method") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      out.push({
        name: source.slice(nameNode.startIndex, nameNode.endIndex),
        kind: "method",
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
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i)!, containerName, source, out);
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
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i)!, parentName, source, out);
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
