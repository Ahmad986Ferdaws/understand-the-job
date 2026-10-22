import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createIgnoreFilter, DEFAULT_IGNORE_PATTERNS } from "../ignore-filter";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("IgnoreFilter", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ignore-filter-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, ".understand-anything"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("DEFAULT_IGNORE_PATTERNS", () => {
    it("contains node_modules", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain("node_modules/");
    });

    it("contains .git", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain(".git/");
    });

    it("contains the .understandignore control file", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain(".understandignore");
    });

    it("contains obj for .NET", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain("obj/");
    });

    it("does not contain bin (used by Node/Ruby CLI launchers)", () => {
      expect(DEFAULT_IGNORE_PATTERNS).not.toContain("bin/");
    });

    it("contains build output directories", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain("dist/");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("build/");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("out/");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("coverage/");
    });
  });

  describe("createIgnoreFilter with no user file", () => {
    it("ignores files matching default patterns", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("node_modules/foo/bar.js")).toBe(true);
      expect(filter.isIgnored("dist/index.js")).toBe(true);
      expect(filter.isIgnored(".git/config")).toBe(true);
      expect(filter.isIgnored("obj/Release/net8.0/app.dll")).toBe(true);
    });

    it("does not ignore source files", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("src/index.ts")).toBe(false);
      expect(filter.isIgnored("README.md")).toBe(false);
      expect(filter.isIgnored("package.json")).toBe(false);
    });

    it("ignores lock files", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("pnpm-lock.yaml")).toBe(true);
      expect(filter.isIgnored("package-lock.json")).toBe(true);
      expect(filter.isIgnored("yarn.lock")).toBe(true);
    });

    it("ignores binary/asset files", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("logo.png")).toBe(true);
      expect(filter.isIgnored("font.woff2")).toBe(true);
      expect(filter.isIgnored("doc.pdf")).toBe(true);
    });

    it("ignores generated files", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("bundle.min.js")).toBe(true);
      expect(filter.isIgnored("style.min.css")).toBe(true);
      expect(filter.isIgnored("source.map")).toBe(true);
    });

    it("ignores IDE directories", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored(".idea/workspace.xml")).toBe(true);
      expect(filter.isIgnored(".vscode/settings.json")).toBe(true);
    });
  });

  describe("createIgnoreFilter with user .understandignore", () => {
    it("reads patterns from .understand-anything/.understandignore", () => {
      writeFileSync(
        join(testDir, ".understand-anything", ".understandignore"),
        "# Exclude tests\n__tests__/\n*.test.ts\n"
      );
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("__tests__/foo.test.ts")).toBe(true);
      expect(filter.isIgnored("src/utils.test.ts")).toBe(true);
      expect(filter.isIgnored("src/utils.ts")).toBe(false);
    });

    it("reads patterns from project root .understandignore", () => {
      writeFileSync(
        join(testDir, ".understandignore"),
        "docs/\n"
      );
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("docs/README.md")).toBe(true);
      expect(filter.isIgnored("src/index.ts")).toBe(false);
    });

    it("handles # comments and blank lines", () => {
      writeFileSync(
        join(testDir, ".understand-anything", ".understandignore"),
        "# This is a comment\n\n\nfixtures/\n\n# Another comment\n"
      );
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("fixtures/data.json")).toBe(true);
      expect(filter.isIgnored("src/index.ts")).toBe(false);
    });

    it("supports ! negation to override defaults", () => {
      writeFileSync(
        join(testDir, ".understand-anything", ".understandignore"),
        "!dist/\n"
      );
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("dist/index.js")).toBe(false);
    });

    it("supports ** recursive matching", () => {
      writeFileSync(
        join(testDir, ".understand-anything", ".understandignore"),
        "**/snapshots/\n"
      );
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("src/components/snapshots/Button.snap")).toBe(true);
      expect(filter.isIgnored("snapshots/foo.snap")).toBe(true);
    });

    it("merges .understand-anything/ and root .understandignore", () => {
      writeFileSync(
        join(testDir, ".understand-anything", ".understandignore"),
        "__tests__/\n"
      );
      writeFileSync(
        join(testDir, ".understandignore"),
        "fixtures/\n"
      );
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("__tests__/foo.ts")).toBe(true);
      expect(filter.isIgnored("fixtures/data.json")).toBe(true);
      expect(filter.isIgnored("src/index.ts")).toBe(false);
    });
  });

  describe("createIgnoreFilter with CLI --exclude patterns", () => {
    it("applies CLI exclude patterns alongside defaults", () => {
      const filter = createIgnoreFilter(testDir, ["tests/", "e2e/"]);
      expect(filter.isIgnored("tests/foo.test.ts")).toBe(true);
      expect(filter.isIgnored("e2e/smoke.spec.ts")).toBe(true);
      // Defaults still apply
      expect(filter.isIgnored("node_modules/foo.js")).toBe(true);
      expect(filter.isIgnored("dist/bundle.js")).toBe(true);
      // Non-excluded source files pass through
      expect(filter.isIgnored("src/index.ts")).toBe(false);
      expect(filter.isIgnored("README.md")).toBe(false);
    });

    it("CLI patterns have highest priority over .understandignore files", () => {
      // .understandignore says to include docs/
      writeFileSync(
        join(testDir, ".understand-anything", ".understandignore"),
        "!docs/\n"
      );
      // CLI --exclude says to exclude docs/
      const filter = createIgnoreFilter(testDir, ["docs/"]);
      // CLI patterns are added last, so they override the ! negation from .understandignore
      expect(filter.isIgnored("docs/README.md")).toBe(true);
    });

    it("CLI ! negation can re-include files excluded by defaults", () => {
      // CLI says to include dist/ even though defaults exclude it
      const filter = createIgnoreFilter(testDir, ["!dist/"]);
      expect(filter.isIgnored("dist/bundle.js")).toBe(false);
      // Other defaults still apply
      expect(filter.isIgnored("node_modules/foo.js")).toBe(true);
    });

    it("CLI patterns combined with .understandignore files all apply", () => {
      writeFileSync(
        join(testDir, ".understandignore"),
        "fixtures/\n"
      );
      const filter = createIgnoreFilter(testDir, ["e2e/"]);
      expect(filter.isIgnored("fixtures/data.json")).toBe(true);
      expect(filter.isIgnored("e2e/smoke.spec.ts")).toBe(true);
      expect(filter.isIgnored("src/index.ts")).toBe(false);
    });

    it("empty CLI patterns array has no effect", () => {
      const filter = createIgnoreFilter(testDir, []);
      expect(filter.isIgnored("node_modules/foo.js")).toBe(true);
      expect(filter.isIgnored("src/index.ts")).toBe(false);
      expect(filter.isIgnored("docs/README.md")).toBe(false);
    });
  });

  describe("binary and large artefacts", () => {
    it.each([
      "lib/native.wasm",
      "lib/libfoo.so",
      "lib/libfoo.dylib",
      "bin/foo.dll",
      "tools/app.exe",
      "obj-files/main.o",
      "libs/libfoo.a",
      "libs/app.jar",
      "libs/app.war",
      "Foo.class",
      "data/app.sqlite",
      "data/app.sqlite3",
      "data/app.db",
      "data/train.parquet",
      "models/model.onnx",
      "models/model.pt",
      "models/model.pth",
      "models/model.ckpt",
      "models/model.safetensors",
      "models/model.h5",
      "data/x.npy",
      "data/x.npz",
      "img/photo.webp",
      "img/photo.avif",
      "img/photo.bmp",
      "media/clip.mp4",
      "media/clip.mov",
      "media/clip.webm",
      "media/song.wav",
      "fonts/a.otf",
      "dist.zip",
      "dist.tar",
      "dist.tgz",
      "dist.tar.gz",
      "dist.xz",
      "dist.7z",
      "pkg.whl",
    ])("ignores %s", (path) => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored(path)).toBe(true);
    });

    it("is case-insensitive about the extension", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("lib/Native.WASM")).toBe(true);
      expect(filter.isIgnored("img/Photo.WebP")).toBe(true);
    });

    it("does not swallow source files that merely resemble those names", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("src/sound.ts")).toBe(false);
      expect(filter.isIgnored("src/db.ts")).toBe(false);
      expect(filter.isIgnored("src/db/index.ts")).toBe(false);
      expect(filter.isIgnored("src/model.py")).toBe(false);
      expect(filter.isIgnored("src/Jar.java")).toBe(false);
      expect(filter.isIgnored("src/classes.ts")).toBe(false);
      expect(filter.isIgnored("src/wasm/loader.ts")).toBe(false);
    });
  });

  describe("source packages named build / out / vendor", () => {
    it("keeps real source under a src/ tree", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("src/com/acme/build/Builder.java")).toBe(false);
      expect(filter.isIgnored("src/main/java/com/acme/vendor/VendorService.java")).toBe(false);
      expect(filter.isIgnored("app/src/main/kotlin/io/acme/out/Sink.kt")).toBe(false);
      expect(filter.isIgnored("src/build/index.ts")).toBe(false);
      expect(filter.isIgnored("packages/web/src/vendor/api.ts")).toBe(false);
    });

    it("still drops build output and dependency dirs outside a src/ tree", () => {
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("build/classes/Foo.class")).toBe(true);
      expect(filter.isIgnored("build/output.js")).toBe(true);
      expect(filter.isIgnored("out/main.js")).toBe(true);
      expect(filter.isIgnored("vendor/github.com/x/y/y.go")).toBe(true);
      // monorepo modules keep working: build/ is dropped at any depth
      expect(filter.isIgnored("modules/api/build/libs/api.js")).toBe(true);
      expect(filter.isIgnored("packages/web/vendor/jquery.js")).toBe(true);
      expect(filter.isIgnored("packages/web/dist/bundle.js")).toBe(true);
    });

    it("does not rescue build output that merely lives inside a src/ dir at the top", () => {
      const filter = createIgnoreFilter(testDir);
      // a top-level build/ that happens to contain a src folder stays ignored
      expect(filter.isIgnored("build/src/generated/Foo.java")).toBe(true);
    });

    it("user patterns still override the rescue", () => {
      writeFileSync(join(testDir, ".understandignore"), "src/vendor/\n");
      const filter = createIgnoreFilter(testDir);
      expect(filter.isIgnored("src/vendor/lib.js")).toBe(true);
      expect(filter.isIgnored("src/com/acme/build/Builder.java")).toBe(false);
    });
  });

  describe("data directory hardening", () => {
    it.skipIf(process.platform === "win32")(
      "refuses a symlinked data dir instead of reading its .understandignore",
      () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "ua-ignore-sec-")));
        try {
          const root = join(base, "repo");
          const elsewhere = join(base, "elsewhere");
          mkdirSync(root);
          mkdirSync(elsewhere);
          writeFileSync(join(elsewhere, ".understandignore"), "src/\n");
          symlinkSync(elsewhere, join(root, ".ua"));

          expect(() => createIgnoreFilter(root)).toThrow(/symbolic link/);
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      },
    );

    it.skipIf(process.platform === "win32")(
      "refuses a symlinked .understandignore inside the data dir",
      () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "ua-ignore-sec-")));
        try {
          const root = join(base, "repo");
          mkdirSync(join(root, ".ua"), { recursive: true });
          writeFileSync(join(base, "patterns"), "src/\n");
          symlinkSync(join(base, "patterns"), join(root, ".ua", ".understandignore"));

          expect(() => createIgnoreFilter(root)).toThrow(/symbolic link/);
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      },
    );

    it("works for a project root that does not exist (defaults only)", () => {
      const filter = createIgnoreFilter(join(testDir, "no-such-project"));
      expect(filter.isIgnored("node_modules/x.js")).toBe(true);
      expect(filter.isIgnored("src/index.ts")).toBe(false);
    });
  });
});
