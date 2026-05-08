import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtractedFile, ExtractedSymbol } from "./typescript.js";

// TODO(rails): When manifest.languages includes { ruby: { rails: true } },
// also parse config/routes.rb for routes, scan ApplicationRecord subclasses
// for has_many/belongs_to associations, and tag controller actions
// (public methods on classes ending in 'Controller' under app/controllers).

const parser = new Parser();
parser.setLanguage(Ruby as any);

export function parseRubyFile(filePath: string): ExtractedFile {
  const content = readFileSync(filePath, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const tree = parser.parse(content);
  const symbols: ExtractedSymbol[] = [];

  walk(tree.rootNode, null, content, symbols);

  return { path: filePath, language: "typescript", hash, symbols };
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
        docstring: null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parentName,
        callees: extractRubyCallees(node, source),
      });
    }
  } else if (node.type === "class") {
    const nameNode = node.childForFieldName("name");
    const className = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : "<anonymous>";
    out.push({
      name: className,
      kind: "class",
      signature: `class ${className}`,
      docstring: null,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      parentName: null,
      callees: [],
    });
    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i)!, className, source, out);
    }
    return;
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
