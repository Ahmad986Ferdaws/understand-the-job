import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Contract: the dashboard page makes no requests to other hosts (enforced at
// run time by the Content-Security-Policy). These tests keep remote URLs out
// of the sources so a regression is caught before it reaches the CSP.
const dashboardRoot = path.resolve(__dirname, "..", "..");
const srcRoot = path.join(dashboardRoot, "src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [full] : [];
  });
}

describe("no outbound requests", () => {
  it("index.html loads nothing from another host", () => {
    const html = fs.readFileSync(path.join(dashboardRoot, "index.html"), "utf8");
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
    expect(html).not.toMatch(/rel\s*=\s*["']preconnect["']/i);
  });

  it("source files only mention URLs that are XML namespaces", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
        if (!/^https?:\/\/www\.w3\.org\//.test(match[0])) {
          offenders.push(`${path.relative(srcRoot, file)}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("CSS imports no remote resources", () => {
    const css = fs.readFileSync(path.join(srcRoot, "index.css"), "utf8");
    expect(css).not.toMatch(/@import\s+(?:url\()?["']?(?:https?:)?\/\//i);
    expect(css).not.toMatch(/url\(\s*["']?https?:/i);
  });
});
