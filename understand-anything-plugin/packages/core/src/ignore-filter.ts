import ignore, { type Ignore } from "ignore";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveUaDir } from "./persistence/index.js";
import { safeReadFile } from "./persistence/safe-io.js";

/**
 * Hardcoded default ignore patterns matching the project-scanner agent's
 * exclusion rules, plus bin/obj for .NET projects.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  // Dependency directories
  "node_modules/",
  ".git/",
  "vendor/",
  "venv/",
  ".venv/",
  "__pycache__/",

  // Build output
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".cache/",
  ".turbo/",
  "target/",
  "obj/",

  // Lock files
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",

  // Binary/asset files
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.svg",
  "*.ico",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.mp3",
  "*.mp4",
  "*.pdf",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.webp",
  "*.avif",
  "*.bmp",
  "*.mov",
  "*.webm",
  "*.avi",
  "*.mkv",
  "*.wav",
  "*.flac",
  "*.ogg",
  "*.m4a",
  "*.otf",
  "*.tgz",
  "*.bz2",
  "*.xz",
  "*.7z",
  "*.rar",

  // Compiled / native / packaged artefacts
  "*.wasm",
  "*.so",
  "*.dylib",
  "*.dll",
  "*.exe",
  "*.o",
  "*.a",
  "*.jar",
  "*.war",
  "*.class",
  "*.whl",
  "*.dmg",
  "*.iso",

  // Databases, datasets and ML model weights
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  "*.parquet",
  "*.onnx",
  "*.pt",
  "*.pth",
  "*.ckpt",
  "*.safetensors",
  "*.h5",
  "*.npy",
  "*.npz",

  // Generated files
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.generated.*",

  // IDE/editor
  ".idea/",
  ".vscode/",

  // Misc
  "LICENSE",
  ".gitignore",
  ".understandignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc*",
  "*.log",

  // Source-tree rescue. `build/`, `out/` and `vendor/` above match at any
  // depth so that monorepo modules (`packages/api/build/`) are dropped too,
  // but the same names are ordinary package segments under a source root
  // (`src/main/java/com/acme/build/Compiler.java`). Anything below a `src`
  // directory is real source, so re-include it. Order matters: this must come
  // after the patterns it overrides, and user patterns still win over both.
  "!**/src/**/build/",
  "!**/src/**/out/",
  "!**/src/**/vendor/",
];

export interface IgnoreFilter {
  /** Returns true if the given relative path should be excluded from analysis. */
  isIgnored(relativePath: string): boolean;
}

/**
 * Creates an IgnoreFilter that merges hardcoded defaults with user-defined
 * patterns from .understandignore files and CLI-provided exclude patterns.
 *
 * Pattern load order (later entries can override earlier ones via ! negation):
 * 1. Hardcoded defaults
 * 2. <ua-dir>/.understandignore (if exists — `.ua/`, or the legacy
 *    `.understand-anything/` when that directory already exists)
 * 3. .understandignore at project root (if exists)
 * 4. CLI --exclude patterns (highest priority)
 */
export function createIgnoreFilter(projectRoot: string, extraPatterns: string[] = []): IgnoreFilter {
  const ig: Ignore = ignore();

  // Layer 1: hardcoded defaults
  ig.add(DEFAULT_IGNORE_PATTERNS);

  // Layer 2: <ua-dir>/.understandignore
  // Read through the symlink-refusing helper: the data dir is repo content.
  const projectIgnore = safeReadFile(
    projectRoot,
    resolveUaDir(projectRoot),
    ".understandignore",
  );
  if (projectIgnore !== null) {
    ig.add(projectIgnore);
  }

  // Layer 3: .understandignore at project root
  const rootIgnorePath = join(projectRoot, ".understandignore");
  if (existsSync(rootIgnorePath)) {
    const content = readFileSync(rootIgnorePath, "utf-8");
    ig.add(content);
  }

  // Layer 4: CLI --exclude patterns (highest priority)
  if (extraPatterns.length > 0) {
    ig.add(extraPatterns);
  }

  return {
    isIgnored(relativePath: string): boolean {
      return ig.ignores(relativePath);
    },
  };
}
