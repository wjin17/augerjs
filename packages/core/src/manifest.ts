import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const ManifestSchema = z.object({
  version: z.literal(1),
  project: z.object({ name: z.string() }),
  languages: z.array(
    z.union([
      z.object({ name: z.literal("typescript"), tsconfig: z.string().optional() }),
      z.object({
        name: z.literal("ruby"),
        rails: z.boolean().optional(),
        routes: z.string().optional(),
      }),
    ])
  ),
  include: z.array(z.string()),
  exclude: z.array(z.string()).optional(),
  output: z.object({ path: z.string() }).optional(),
  watch: z.object({ debounce: z.number().default(300) }).optional(),
  mcp: z
    .object({
      transport: z.enum(["stdio", "http"]).default("stdio"),
      port: z.number().default(7827),
    })
    .optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function loadManifest(path: string): Manifest {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw);
  return ManifestSchema.parse(parsed);
}

export function defaultManifest(rootDir: string): Manifest {
  return {
    version: 1,
    project: { name: basename(rootDir) },
    languages: [{ name: "typescript" }, { name: "ruby" }],
    include: ["**/*"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "out/**",
      "build/**",
      ".git/**",
      "**/*.d.ts",
      "**/*.min.js",
    ],
    watch: { debounce: 300 },
  };
}

export function resolveManifest(rootDir: string): Manifest {
  const manifestPath = join(rootDir, ".auger.yml");
  return existsSync(manifestPath) ? loadManifest(manifestPath) : defaultManifest(rootDir);
}
