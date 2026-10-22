import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KnowledgeGraph, GraphNode, GraphEdge } from "../types.js";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

// Import after mocking
import { execFileSync } from "child_process";
import {
  getChangedFiles,
  isStale,
  mergeGraphUpdate,
} from "../staleness.js";

const mockedExecFileSync = vi.mocked(execFileSync);

const makeNode = (
  overrides: Partial<GraphNode> & { id: string; name: string },
): GraphNode => ({
  type: "file",
  summary: "",
  tags: [],
  complexity: "simple",
  ...overrides,
});

const makeEdge = (
  overrides: Partial<GraphEdge> & { source: string; target: string },
): GraphEdge => ({
  type: "imports",
  direction: "forward",
  weight: 1,
  ...overrides,
});

function makeGraph(overrides?: Partial<KnowledgeGraph>): KnowledgeGraph {
  return {
    version: "1.0.0",
    project: {
      name: "test-project",
      languages: ["typescript"],
      frameworks: [],
      description: "A test project",
      analyzedAt: "2026-01-01T00:00:00.000Z",
      gitCommitHash: "abc123",
    },
    nodes: [],
    edges: [],
    layers: [],
    tour: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getChangedFiles", () => {
  it("returns changed file list from git diff", () => {
    mockedExecFileSync.mockReturnValue("src/index.ts\nsrc/utils.ts\n");

    const result = getChangedFiles("/project", "abc1234");

    expect(result).toEqual(["src/index.ts", "src/utils.ts"]);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-only", "--end-of-options", "abc1234..HEAD", "--"],
      expect.objectContaining({ cwd: "/project", encoding: "utf-8", timeout: 5_000 }),
    );
  });

  it("returns empty array when no changes", () => {
    mockedExecFileSync.mockReturnValue("");

    const result = getChangedFiles("/project", "abc1234");

    expect(result).toEqual([]);
  });

  it("returns null (unknown) on git error", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("fatal: bad revision");
    });

    const result = getChangedFiles("/project", "abc1234");

    expect(result).toBeNull();
  });

  it.each([
    "",
    "abc123", // too short to be a commit id
    "--output=/tmp/pwned",
    "-abcdef0",
    "HEAD~1",
    "main",
    "abc1234..def5678",
    "abc1234 --stat",
    "abc1234\n--output=/tmp/x",
    "g".repeat(40),
    "a".repeat(65),
  ])("never runs git for the invalid hash %j", (hash) => {
    const result = getChangedFiles("/project", hash);

    expect(result).toBeNull();
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("accepts full SHA-1 and SHA-256 hashes in any case", () => {
    mockedExecFileSync.mockReturnValue("");

    expect(getChangedFiles("/project", "a".repeat(40))).toEqual([]);
    expect(getChangedFiles("/project", "AB12CD3")).toEqual([]);
    expect(getChangedFiles("/project", "0123456789abcdef".repeat(4))).toEqual([]);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
  });

  it("puts the hash after --end-of-options so it can never be read as a flag", () => {
    mockedExecFileSync.mockReturnValue("");

    getChangedFiles("/project", "abc1234");

    const args = mockedExecFileSync.mock.calls[0][1] as string[];
    expect(args.indexOf("--end-of-options")).toBeLessThan(args.indexOf("abc1234..HEAD"));
  });
});

describe("isStale", () => {
  it("returns stale when files have changed", () => {
    mockedExecFileSync.mockReturnValue("src/index.ts\n");

    const result = isStale("/project", "abc1234");

    expect(result).toEqual({
      stale: true,
      changedFiles: ["src/index.ts"],
    });
  });

  it("returns not stale when no files changed", () => {
    mockedExecFileSync.mockReturnValue("");

    const result = isStale("/project", "abc1234");

    expect(result).toEqual({
      stale: false,
      changedFiles: [],
    });
  });

  it("reports stale + unknown (not fresh) when git fails", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });

    const result = isStale("/project", "abc1234");

    expect(result).toEqual({ stale: true, changedFiles: [], unknown: true });
  });

  it("reports stale + unknown for an invalid hash without calling git", () => {
    const result = isStale("/project", "--output=/tmp/pwned");

    expect(result).toEqual({ stale: true, changedFiles: [], unknown: true });
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});

describe("mergeGraphUpdate", () => {
  it("replaces nodes for changed files", () => {
    const existingGraph = makeGraph({
      nodes: [
        makeNode({
          id: "file-a",
          name: "a.ts",
          filePath: "src/a.ts",
          summary: "Old summary",
        }),
        makeNode({
          id: "file-b",
          name: "b.ts",
          filePath: "src/b.ts",
          summary: "Unchanged",
        }),
        makeNode({
          id: "func-a1",
          name: "funcA1",
          type: "function",
          filePath: "src/a.ts",
          summary: "Old function",
        }),
      ],
    });

    const newNodes = [
      makeNode({
        id: "file-a-v2",
        name: "a.ts",
        filePath: "src/a.ts",
        summary: "New summary",
      }),
      makeNode({
        id: "func-a2",
        name: "funcA2",
        type: "function",
        filePath: "src/a.ts",
        summary: "New function",
      }),
    ];

    const result = mergeGraphUpdate(
      existingGraph,
      ["src/a.ts"],
      newNodes,
      [],
      "def456",
    );

    // Old nodes from src/a.ts should be gone
    expect(result.nodes.find((n) => n.id === "file-a")).toBeUndefined();
    expect(result.nodes.find((n) => n.id === "func-a1")).toBeUndefined();

    // New nodes should be present
    expect(result.nodes.find((n) => n.id === "file-a-v2")).toBeDefined();
    expect(result.nodes.find((n) => n.id === "func-a2")).toBeDefined();

    // Unchanged file should remain
    expect(result.nodes.find((n) => n.id === "file-b")).toBeDefined();
  });

  it("removes edges originating from changed files", () => {
    const existingGraph = makeGraph({
      nodes: [
        makeNode({ id: "file-a", name: "a.ts", filePath: "src/a.ts" }),
        makeNode({ id: "file-b", name: "b.ts", filePath: "src/b.ts" }),
        makeNode({ id: "file-c", name: "c.ts", filePath: "src/c.ts" }),
      ],
      edges: [
        // Edge from changed file -> should be removed
        makeEdge({ source: "file-a", target: "file-b" }),
        // Edge between unchanged files -> should remain
        makeEdge({ source: "file-b", target: "file-c" }),
        // Edge to changed file from unchanged -> should remain
        makeEdge({ source: "file-c", target: "file-a" }),
      ],
    });

    const newNodes = [
      makeNode({
        id: "file-a-v2",
        name: "a.ts",
        filePath: "src/a.ts",
        summary: "Updated",
      }),
    ];

    const newEdges = [
      makeEdge({ source: "file-a-v2", target: "file-c" }),
    ];

    const result = mergeGraphUpdate(
      existingGraph,
      ["src/a.ts"],
      newNodes,
      newEdges,
      "def456",
    );

    // Old edge from file-a should be removed
    expect(
      result.edges.find(
        (e) => e.source === "file-a" && e.target === "file-b",
      ),
    ).toBeUndefined();

    // Edge between unchanged files should remain
    expect(
      result.edges.find(
        (e) => e.source === "file-b" && e.target === "file-c",
      ),
    ).toBeDefined();

    // Edge to changed file from unchanged should be removed (dangling target)
    expect(
      result.edges.find(
        (e) => e.source === "file-c" && e.target === "file-a",
      ),
    ).toBeUndefined();

    // New edge should be added
    expect(
      result.edges.find(
        (e) => e.source === "file-a-v2" && e.target === "file-c",
      ),
    ).toBeDefined();
  });

  it("updates analyzedAt timestamp and gitCommitHash", () => {
    const existingGraph = makeGraph();

    const before = new Date().toISOString();
    const result = mergeGraphUpdate(existingGraph, [], [], [], "def456");
    const after = new Date().toISOString();

    expect(result.project.gitCommitHash).toBe("def456");
    expect(result.project.analyzedAt >= before).toBe(true);
    expect(result.project.analyzedAt <= after).toBe(true);
  });
});
