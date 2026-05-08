import { Project, SyntaxKind, type Node } from "ts-morph";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type ExtractedSymbol = {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "constant";
  signature: string;
  docstring: string | null;
  startLine: number;
  endLine: number;
  parentName: string | null;
  callees: string[];
};

export type ExtractedFile = {
  path: string;
  language: "typescript";
  hash: string;
  symbols: ExtractedSymbol[];
};

export function parseTypeScriptFile(filePath: string, project: Project): ExtractedFile {
  const content = readFileSync(filePath, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const sf = project.addSourceFileAtPath(filePath);

  const symbols: ExtractedSymbol[] = [];

  for (const fn of sf.getFunctions()) {
    symbols.push({
      name: fn.getName() ?? "<anonymous>",
      kind: "function",
      signature: fn.getText().split("{")[0]?.trim() ?? "",
      docstring: getJsDoc(fn),
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      parentName: null,
      callees: extractCallees(fn),
    });
  }

  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? "<anonymous>";
    symbols.push({
      name: className,
      kind: "class",
      signature: `class ${className}`,
      docstring: getJsDoc(cls),
      startLine: cls.getStartLineNumber(),
      endLine: cls.getEndLineNumber(),
      parentName: null,
      callees: [],
    });

    for (const method of cls.getMethods()) {
      symbols.push({
        name: method.getName(),
        kind: "method",
        signature: method.getText().split("{")[0]?.trim() ?? "",
        docstring: getJsDoc(method),
        startLine: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
        parentName: className,
        callees: extractCallees(method),
      });
    }
  }

  for (const iface of sf.getInterfaces()) {
    symbols.push({
      name: iface.getName(),
      kind: "interface",
      signature: `interface ${iface.getName()}`,
      docstring: getJsDoc(iface),
      startLine: iface.getStartLineNumber(),
      endLine: iface.getEndLineNumber(),
      parentName: null,
      callees: [],
    });
  }

  for (const alias of sf.getTypeAliases()) {
    symbols.push({
      name: alias.getName(),
      kind: "type",
      signature: alias.getText().trim(),
      docstring: getJsDoc(alias),
      startLine: alias.getStartLineNumber(),
      endLine: alias.getEndLineNumber(),
      parentName: null,
      callees: [],
    });
  }

  project.removeSourceFile(sf);
  return { path: filePath, language: "typescript", hash, symbols };
}

function getJsDoc(node: { getJsDocs?: () => Array<{ getDescription: () => string }> }): string | null {
  const docs = node.getJsDocs?.() ?? [];
  if (docs.length === 0) return null;
  return docs.map((d) => d.getDescription().trim()).join("\n\n") || null;
}

function extractCallees(node: Node): string[] {
  const callees = new Set<string>();
  node.forEachDescendant((n) => {
    if (n.getKind() === SyntaxKind.CallExpression) {
      const expr = (n as any).getExpression?.();
      if (!expr) return;
      const text = expr.getText();
      const name = text.split(".").pop() ?? text;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) callees.add(name);
    }
  });
  return [...callees];
}
