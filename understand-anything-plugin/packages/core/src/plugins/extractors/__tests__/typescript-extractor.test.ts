import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { TypeScriptExtractor } from "../typescript-extractor.js";

const require = createRequire(import.meta.url);

// Load tree-sitter + TypeScript grammar once
let Parser: any;
let Language: any;
let tsLang: any;
let jsLang: any;

beforeAll(async () => {
  const mod = await import("web-tree-sitter");
  Parser = mod.Parser;
  Language = mod.Language;
  await Parser.init();
  const wasmPath = require.resolve(
    "tree-sitter-typescript/tree-sitter-typescript.wasm",
  );
  tsLang = await Language.load(wasmPath);
  jsLang = await Language.load(
    require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm"),
  );
});

function parse(code: string, lang: any = tsLang) {
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(code);
  const root = tree.rootNode;
  return { tree, parser, root };
}

describe("TypeScriptExtractor", () => {
  const extractor = new TypeScriptExtractor();

  // Regression guard: a plain class is still extracted.
  it("extracts a plain class declaration", () => {
    const { tree, parser, root } = parse(`class Widget {
  run(): void {
    console.log("x");
  }
}
`);
    const result = extractor.extractStructure(root);
    expect(result.classes.some((c) => c.name === "Widget")).toBe(true);
    tree.delete();
    parser.delete();
  });

  // ---- Abstract classes ----

  describe("extractStructure - abstract classes", () => {
    it("extracts an abstract class as a class node with its concrete methods", () => {
      const { tree, parser, root } = parse(`abstract class Repository {
  abstract find(id: string): Promise<string>;
  save(value: string): void {
    this.items.push(value);
  }
  private items: string[] = [];
}
`);
      const result = extractor.extractStructure(root);

      const repo = result.classes.find((c) => c.name === "Repository");
      expect(repo).toBeDefined();
      expect(repo!.methods).toContain("save");
      // abstract method signatures (no body) are captured too
      expect(repo!.methods).toContain("find");

      tree.delete();
      parser.delete();
    });

    it("records an exported abstract class in exports", () => {
      const { tree, parser, root } = parse(`export abstract class Base {
  abstract run(): void;
}
`);
      const result = extractor.extractStructure(root);

      expect(result.classes.some((c) => c.name === "Base")).toBe(true);
      const baseExport = result.exports.find((e) => e.name === "Base");
      expect(baseExport).toBeDefined();
      expect(baseExport!.isDefault).toBe(false);

      tree.delete();
      parser.delete();
    });
  });
  // ---- Re-exports and dynamic imports ----

  describe("extractStructure - re-exports", () => {
    const importsOf = (code: string, lang?: any) => {
      const { tree, parser, root } = parse(code, lang);
      const result = new TypeScriptExtractor().extractStructure(root);
      tree.delete();
      parser.delete();
      return result;
    };

    it("records `export * from` as an import with a * specifier", () => {
      const { imports } = importsOf(`export * from "./a";\n`);
      expect(imports).toEqual([{ source: "./a", specifiers: ["*"], lineNumber: 1 }]);
    });

    it("records `export * as ns from` as a namespace import", () => {
      const { imports } = importsOf(`export * as ns from './b';\n`);
      expect(imports).toEqual([{ source: "./b", specifiers: ["* as ns"], lineNumber: 1 }]);
    });

    it("records `export { a, b as c } from` with the source-side names and still exports the public names", () => {
      const { imports, exports } = importsOf(`\nexport { a, b as c } from './c';\n`);
      expect(imports).toEqual([{ source: "./c", specifiers: ["a", "b"], lineNumber: 2 }]);
      expect(exports.map((e) => e.name)).toEqual(["a", "c"]);
    });

    it("records `export type { T } from` and `export { default as X } from`", () => {
      const { imports } = importsOf(
        `export type { T } from './types';\nexport { default as Foo, bar } from './foo';\n`,
      );
      expect(imports).toEqual([
        { source: "./types", specifiers: ["T"], lineNumber: 1 },
        { source: "./foo", specifiers: ["default", "bar"], lineNumber: 2 },
      ]);
    });

    it("records `export type * from`", () => {
      const { imports } = importsOf(`export type * from './t';\n`);
      expect(imports.map((i) => i.source)).toEqual(["./t"]);
    });

    it("does not record a local `export { x }` (no from clause) as an import", () => {
      const { imports, exports } = importsOf(`const x = 1;\nexport { x };\n`);
      expect(imports).toEqual([]);
      expect(exports.map((e) => e.name)).toEqual(["x"]);
    });

    it("does not mistake `export default \"literal\"` for a re-export source", () => {
      const { imports } = importsOf(`export default "./not-a-module";\n`);
      expect(imports).toEqual([]);
    });

    it("works with the JavaScript grammar", () => {
      const { imports } = importsOf(
        `export * from './a';\nexport { x as y } from './b';\n`,
        jsLang,
      );
      expect(imports.map((i) => i.source)).toEqual(["./a", "./b"]);
    });
  });

  describe("extractStructure - dynamic import()", () => {
    const importsOf = (code: string, lang?: any) => {
      const { tree, parser, root } = parse(code, lang);
      const result = new TypeScriptExtractor().extractStructure(root);
      tree.delete();
      parser.delete();
      return result.imports;
    };

    it("records import('./x') with a string literal anywhere in the file", () => {
      const imports = importsOf(`import('./top').then((m) => m);
async function load() {
  const lazy = await import("./lazy");
  return lazy;
}
const run = () => import(\`./tpl\`);
`);
      expect(imports).toEqual([
        { source: "./top", specifiers: [], lineNumber: 1 },
        { source: "./lazy", specifiers: [], lineNumber: 3 },
        { source: "./tpl", specifiers: [], lineNumber: 6 },
      ]);
    });

    it("ignores computed and interpolated specifiers", () => {
      const imports = importsOf(
        "const name = 'x';\nimport(name);\nimport(`./${name}`);\nimport('./a' + name);\n",
      );
      expect(imports).toEqual([]);
    });

    it("keeps static imports ahead of dynamic ones and works with the JavaScript grammar", () => {
      const imports = importsOf(
        `import a from './a';\nconst b = () => import('./b');\n`,
        jsLang,
      );
      expect(imports.map((i) => i.source)).toEqual(["./a", "./b"]);
    });

    it("does not treat an ordinary call named import-like as dynamic import", () => {
      const imports = importsOf(`obj.import('./x');\nrequire('./y');\n`);
      expect(imports).toEqual([]);
    });
  });
});
