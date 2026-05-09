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
  isAnonymous: boolean;
};

export type ExtractedFile = {
  path: string;
  language: "typescript" | "ruby";
  hash: string;
  symbols: ExtractedSymbol[];
};

type FnInterface = {
  isAsync(): boolean;
  getParameters(): Array<{ getText(): string }>;
  getReturnTypeNode(): { getText(): string } | undefined;
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
      isAnonymous: false,
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
      isAnonymous: false,
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
        isAnonymous: false,
      });
    }

    for (const prop of cls.getProperties()) {
      const init = prop.getInitializer();
      if (!init) continue;
      const initKind = init.getKind();
      if (initKind !== SyntaxKind.ArrowFunction && initKind !== SyntaxKind.FunctionExpression) continue;
      symbols.push({
        name: prop.getName(),
        kind: "method",
        signature: buildArrowSignature(prop.getName(), init as unknown as FnInterface),
        docstring: getJsDoc(prop),
        startLine: prop.getStartLineNumber(),
        endLine: prop.getEndLineNumber(),
        parentName: className,
        callees: extractCallees(init),
        isAnonymous: false,
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
      isAnonymous: false,
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
      isAnonymous: false,
    });
  }

  for (const varStmt of sf.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
      const init = decl.getInitializer();
      if (!init) continue;
      const initKind = init.getKind();
      const varName = decl.getName();

      if (initKind === SyntaxKind.ArrowFunction || initKind === SyntaxKind.FunctionExpression) {
        symbols.push({
          name: varName,
          kind: "function",
          signature: buildArrowSignature(varName, init as unknown as FnInterface),
          docstring: getJsDoc(varStmt),
          startLine: varStmt.getStartLineNumber(),
          endLine: varStmt.getEndLineNumber(),
          parentName: null,
          callees: extractCallees(init),
          isAnonymous: false,
        });
      } else if (initKind === SyntaxKind.ObjectLiteralExpression) {
        symbols.push({
          name: varName,
          kind: "constant",
          signature: `const ${varName} = {...}`,
          docstring: getJsDoc(varStmt),
          startLine: varStmt.getStartLineNumber(),
          endLine: varStmt.getEndLineNumber(),
          parentName: null,
          callees: [],
          isAnonymous: false,
        });
        for (const prop of (init as any).getProperties() as Node[]) {
          const propKind = prop.getKind();
          if (propKind === SyntaxKind.MethodDeclaration) {
            const method = prop as any;
            const methodName = method.getName?.() as string | undefined;
            if (!methodName) continue;
            symbols.push({
              name: methodName,
              kind: "method",
              signature: (method.getText() as string).split("{")[0]?.trim() ?? "",
              docstring: getJsDoc(method),
              startLine: method.getStartLineNumber() as number,
              endLine: method.getEndLineNumber() as number,
              parentName: varName,
              callees: extractCallees(prop),
              isAnonymous: false,
            });
          } else if (propKind === SyntaxKind.PropertyAssignment) {
            const pa = prop as any;
            const nameNode = pa.getNameNode?.() as Node | undefined;
            if (!nameNode || nameNode.getKind() === SyntaxKind.ComputedPropertyName) continue;
            const paInit = pa.getInitializer?.() as Node | undefined;
            if (!paInit) continue;
            const paKind = paInit.getKind();
            if (paKind !== SyntaxKind.ArrowFunction && paKind !== SyntaxKind.FunctionExpression) continue;
            const propName = pa.getName() as string;
            symbols.push({
              name: propName,
              kind: "method",
              signature: buildArrowSignature(propName, paInit as unknown as FnInterface),
              docstring: getJsDoc(pa),
              startLine: pa.getStartLineNumber() as number,
              endLine: pa.getEndLineNumber() as number,
              parentName: varName,
              callees: extractCallees(paInit),
              isAnonymous: false,
            });
          }
        }
      }
    }
  }

  // Anonymous callbacks: ArrowFunction/FunctionExpression not bound to a named symbol
  const handledParentKinds = new Set([
    SyntaxKind.VariableDeclaration,
    SyntaxKind.PropertyDeclaration,
    SyntaxKind.PropertyAssignment,
  ]);
  const anonLineCount = new Map<number, number>();

  for (const node of [
    ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ]) {
    const parent = node.getParent();
    if (parent && handledParentKinds.has(parent.getKind())) continue;
    const line = node.getStartLineNumber();
    const idx = anonLineCount.get(line) ?? 0;
    anonLineCount.set(line, idx + 1);
    const anonName = idx === 0 ? `<anonymous:${line}>` : `<anonymous:${line}:${idx}>`;
    symbols.push({
      name: anonName,
      kind: "function",
      signature: buildArrowSignature(anonName, node as unknown as FnInterface),
      docstring: null,
      startLine: line,
      endLine: node.getEndLineNumber(),
      parentName: findEnclosingName(node),
      callees: extractCallees(node),
      isAnonymous: true,
    });
  }

  project.removeSourceFile(sf);
  return { path: filePath, language: "typescript", hash, symbols };
}

function buildArrowSignature(name: string, fn: FnInterface): string {
  const asyncPrefix = fn.isAsync() ? "async " : "";
  const params = fn.getParameters().map((p) => p.getText()).join(", ");
  const ret = fn.getReturnTypeNode()?.getText();
  return `const ${name} = ${asyncPrefix}(${params})${ret ? `: ${ret}` : ""}`;
}

function findEnclosingName(node: Node): string | null {
  let p = node.getParent();
  while (p) {
    const k = p.getKind();
    if (k === SyntaxKind.FunctionDeclaration || k === SyntaxKind.MethodDeclaration) {
      return (p as any).getName?.() ?? null;
    }
    if (k === SyntaxKind.PropertyDeclaration) {
      return (p as any).getName?.() ?? null;
    }
    if (k === SyntaxKind.VariableDeclaration) {
      const nameNode = (p as any).getNameNode?.() as Node | undefined;
      if (nameNode?.getKind() === SyntaxKind.Identifier) {
        // Only use module-level var bindings as a parent context, not local vars inside function bodies.
        // VarDecl → VarDeclList → VarStatement → parent: SourceFile = module-level
        const stmtParent = p.getParent()?.getParent()?.getParent();
        if (stmtParent?.getKind() === SyntaxKind.SourceFile) {
          return nameNode.getText();
        }
      }
    }
    if (k === SyntaxKind.ClassDeclaration) {
      return (p as any).getName?.() ?? null;
    }
    p = p.getParent();
  }
  return null;
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
