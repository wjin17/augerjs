import { workerData, parentPort } from "node:worker_threads";
import { Project } from "ts-morph";
import { parseTypeScriptFile } from "./parsers/typescript.js";
import { parseRubyFile } from "./parsers/ruby.js";
import type { ExtractedFile } from "./parsers/typescript.js";

const { files } = workerData as {
  files: Array<{ path: string; language: "typescript" | "ruby" }>;
};

const project = new Project({ useInMemoryFileSystem: false });

const results: ExtractedFile[] = [];
const errors: Array<{ path: string; error: string }> = [];

for (const { path, language } of files) {
  try {
    const extracted =
      language === "typescript"
        ? parseTypeScriptFile(path, project)
        : parseRubyFile(path);
    results.push(extracted);
  } catch (err) {
    errors.push({ path, error: String(err) });
  }
}

parentPort!.postMessage({ results, errors });
