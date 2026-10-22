import { describe, it, expect } from "vitest";
import {
  filterNodes,
  filterEdges,
  applyFilterPanel,
  filterLayers,
  withInheritedLayerMembership,
} from "../filters";
import type {
  GraphNode,
  GraphEdge,
  Layer,
} from "@understand-anything/core/types";
import type {
  FilterState,
  NodeType,
  Complexity,
  EdgeCategory,
} from "../../store";
import {
  ALL_NODE_TYPES,
  ALL_COMPLEXITIES,
  ALL_EDGE_CATEGORIES,
} from "../../store";

function node(
  id: string,
  type: NodeType = "file",
  complexity: Complexity = "simple",
): GraphNode {
  return {
    id,
    type,
    name: id,
    summary: "",
    complexity,
    tags: [],
  } as GraphNode;
}

function edge(source: string, target: string, type = "imports"): GraphEdge {
  return { source, target, type } as GraphEdge;
}

function defaultFilters(overrides: Partial<FilterState> = {}): FilterState {
  return {
    nodeTypes: new Set<NodeType>(ALL_NODE_TYPES),
    complexities: new Set<Complexity>(ALL_COMPLEXITIES),
    layerIds: new Set<string>(),
    edgeCategories: new Set<EdgeCategory>(ALL_EDGE_CATEGORIES),
    ...overrides,
  };
}

function indexLayers(layers: Layer[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const l of layers) {
    for (const nid of l.nodeIds) {
      let set = m.get(nid);
      if (!set) {
        set = new Set<string>();
        m.set(nid, set);
      }
      set.add(l.id);
    }
  }
  return m;
}

describe("filterNodes", () => {
  it("returns all nodes when no filters narrow the set", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const out = filterNodes(nodes, new Map(), defaultFilters());
    expect(out).toHaveLength(3);
  });

  it("filters by node type", () => {
    const nodes = [node("a", "file"), node("b", "function"), node("c", "class")];
    const filters = defaultFilters({ nodeTypes: new Set(["file"]) });
    const out = filterNodes(nodes, new Map(), filters);
    expect(out.map((n) => n.id)).toEqual(["a"]);
  });

  it("filters by complexity", () => {
    const nodes = [
      node("a", "file", "simple"),
      node("b", "file", "moderate"),
      node("c", "file", "complex"),
    ];
    const filters = defaultFilters({ complexities: new Set(["complex"]) });
    const out = filterNodes(nodes, new Map(), filters);
    expect(out.map((n) => n.id)).toEqual(["c"]);
  });

  it("keeps a node only when its layer is selected", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const idx = indexLayers([
      { id: "L1", name: "L1", description: "", nodeIds: ["a", "b"] },
      { id: "L2", name: "L2", description: "", nodeIds: ["c"] },
    ]);
    const filters = defaultFilters({ layerIds: new Set(["L1"]) });
    const out = filterNodes(nodes, idx, filters);
    expect(out.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("drops nodes that aren't in any layer when a layer filter is active", () => {
    const nodes = [node("a"), node("orphan")];
    const idx = indexLayers([
      { id: "L1", name: "L1", description: "", nodeIds: ["a"] },
    ]);
    const filters = defaultFilters({ layerIds: new Set(["L1"]) });
    const out = filterNodes(nodes, idx, filters);
    expect(out.map((n) => n.id)).toEqual(["a"]);
  });

  it("keeps a multi-layer node when any of its layers is selected (any-layer-wins)", () => {
    // Regression for the silent first-wins behavior change in #112: a node
    // X listed in both L1 (declared first) and L2, with only L2 selected,
    // must still pass — matching the prior `layers.some(...)` shape. The
    // first-wins `nodeIdToLayerId` index that drives navigation would
    // have dropped X here.
    const nodes = [node("x"), node("y")];
    const idx = indexLayers([
      { id: "L1", name: "L1", description: "", nodeIds: ["x"] },
      { id: "L2", name: "L2", description: "", nodeIds: ["x", "y"] },
    ]);
    const filters = defaultFilters({ layerIds: new Set(["L2"]) });
    const out = filterNodes(nodes, idx, filters);
    expect(out.map((n) => n.id).sort()).toEqual(["x", "y"]);
  });

  it("ignores layer filter when no layers are selected (parity with prior shape)", () => {
    const nodes = [node("a"), node("orphan")];
    // idx maps "a"; "orphan" isn't in any layer. With layer filter empty,
    // the orphan must still pass through.
    const idx = indexLayers([
      { id: "L1", name: "L1", description: "", nodeIds: ["a"] },
    ]);
    const out = filterNodes(nodes, idx, defaultFilters());
    expect(out.map((n) => n.id).sort()).toEqual(["a", "orphan"]);
  });

  it("scales linearly: 10k nodes × 100 layers under 50ms (#102 regression guard)", () => {
    // The pre-fix path was O(N × L × K) — `layers.some(layer => filters.layerIds.has(layer.id) && layer.nodeIds.includes(node.id))`.
    // For a 10k-node / 100-layer graph with half the layers selected, that
    // measured ~50ms locally on node 22 just for the filter step.
    const nodes: GraphNode[] = [];
    const layers: Layer[] = [];
    for (let li = 0; li < 100; li++) {
      const nodeIds: string[] = [];
      for (let ni = 0; ni < 100; ni++) {
        const id = `n-${li}-${ni}`;
        nodes.push(node(id));
        nodeIds.push(id);
      }
      layers.push({ id: `L${li}`, name: `L${li}`, description: "", nodeIds });
    }
    const idx = indexLayers(layers);
    const selected = new Set<string>(layers.slice(0, 50).map((l) => l.id));
    const filters = defaultFilters({ layerIds: selected });

    const t0 = performance.now();
    const out = filterNodes(nodes, idx, filters);
    const elapsedMs = performance.now() - t0;

    expect(out.length).toBe(50 * 100);
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe("filterEdges", () => {
  it("keeps only edges whose endpoints are visible", () => {
    const edges = [edge("a", "b"), edge("a", "missing"), edge("c", "b")];
    const visible = new Set(["a", "b"]);
    const out = filterEdges(edges, visible, defaultFilters());
    expect(out).toEqual([edge("a", "b")]);
  });

  it("filters by edge category", () => {
    const edges = [
      edge("a", "b", "imports"),    // structural
      edge("a", "b", "calls"),      // behavioral
      edge("a", "b", "reads_from"), // data-flow
    ];
    const visible = new Set(["a", "b"]);
    const filters = defaultFilters({
      edgeCategories: new Set<EdgeCategory>(["structural"]),
    });
    const out = filterEdges(edges, visible, filters);
    expect(out.map((e) => e.type)).toEqual(["imports"]);
  });

  it("passes through edges with unknown types (no category match)", () => {
    // getEdgeCategory returns null for unknown types, which short-circuits
    // the category filter — pinning current behavior so a future refactor
    // doesn't accidentally start dropping unknown edges.
    const edges = [edge("a", "b", "future-edge-type")];
    const visible = new Set(["a", "b"]);
    const out = filterEdges(edges, visible, defaultFilters());
    expect(out).toHaveLength(1);
  });
});

// These are the pure functions GraphView calls so the Filter panel's
// checkboxes change the canvas (the panel used to write `filters` that only
// the export menu read).
describe("applyFilterPanel (what the structural view applies)", () => {
  const nodes = [
    node("file-simple", "file", "simple"),
    node("file-complex", "file", "complex"),
    node("cfg", "config", "simple"),
    node("cls", "class", "moderate"),
  ];
  const edges = [
    edge("file-simple", "file-complex", "imports"),   // structural
    edge("file-simple", "cfg", "configures"),         // dependencies
    edge("file-complex", "cls", "contains"),          // structural
    edge("cls", "file-simple", "calls"),              // behavioral
  ];

  it("is a no-op with the default (everything on) filters", () => {
    const out = applyFilterPanel(nodes, edges, new Map(), defaultFilters());
    expect(out.nodes).toHaveLength(4);
    expect(out.edges).toHaveLength(4);
  });

  it("hides unchecked node types and the edges that touched them", () => {
    const filters = defaultFilters({
      nodeTypes: new Set<NodeType>(ALL_NODE_TYPES.filter((t) => t !== "config")),
    });
    const out = applyFilterPanel(nodes, edges, new Map(), filters);
    expect(out.nodes.map((n) => n.id)).toEqual(["file-simple", "file-complex", "cls"]);
    expect(out.edges.map((e) => e.target)).not.toContain("cfg");
    expect(out.edges).toHaveLength(3);
  });

  it("hides unchecked complexities", () => {
    const filters = defaultFilters({
      complexities: new Set<Complexity>(["simple", "moderate"]),
    });
    const out = applyFilterPanel(nodes, edges, new Map(), filters);
    expect(out.nodes.map((n) => n.id)).toEqual(["file-simple", "cfg", "cls"]);
    // Edges into the hidden node are gone, the rest survive.
    expect(out.edges.map((e) => `${e.source}>${e.target}`)).toEqual([
      "file-simple>cfg",
      "cls>file-simple",
    ]);
  });

  it("hides unchecked edge categories but keeps every node", () => {
    const filters = defaultFilters({
      edgeCategories: new Set<EdgeCategory>(["structural"]),
    });
    const out = applyFilterPanel(nodes, edges, new Map(), filters);
    expect(out.nodes).toHaveLength(4);
    expect(out.edges.map((e) => e.type)).toEqual(["imports", "contains"]);
  });

  it("restricts to the selected layers", () => {
    const idx = indexLayers([
      { id: "L1", name: "L1", description: "", nodeIds: ["file-simple", "cfg"] },
      { id: "L2", name: "L2", description: "", nodeIds: ["file-complex"] },
    ]);
    const filters = defaultFilters({ layerIds: new Set(["L1"]) });
    const out = applyFilterPanel(nodes, edges, idx, filters);
    expect(out.nodes.map((n) => n.id)).toEqual(["file-simple", "cfg"]);
    expect(out.edges.map((e) => e.type)).toEqual(["configures"]);
  });

  it("lets sub-file nodes inherit their parent file's layer", () => {
    // Layers list files only; a class inside a file in L1 must stay visible
    // when L1 is the selected layer, and vanish when only L2 is selected.
    const idx = indexLayers([
      { id: "L1", name: "L1", description: "", nodeIds: ["file-complex"] },
      { id: "L2", name: "L2", description: "", nodeIds: ["file-simple"] },
    ]);
    const parents = new Map([["cls", "file-complex"]]);

    const l1 = applyFilterPanel(nodes, edges, idx, defaultFilters({ layerIds: new Set(["L1"]) }), parents);
    expect(l1.nodes.map((n) => n.id).sort()).toEqual(["cls", "file-complex"]);

    const l2 = applyFilterPanel(nodes, edges, idx, defaultFilters({ layerIds: new Set(["L2"]) }), parents);
    expect(l2.nodes.map((n) => n.id)).toEqual(["file-simple"]);

    // Without the parent map the class would be dropped (the old behaviour).
    const noParents = applyFilterPanel(nodes, edges, idx, defaultFilters({ layerIds: new Set(["L1"]) }));
    expect(noParents.nodes.map((n) => n.id)).toEqual(["file-complex"]);
  });

  it("does not mutate its inputs", () => {
    const idx = indexLayers([{ id: "L1", name: "L1", description: "", nodeIds: ["file-complex"] }]);
    const before = new Map(idx);
    applyFilterPanel(nodes, edges, idx, defaultFilters({ layerIds: new Set(["L1"]) }), new Map([["cls", "file-complex"]]));
    expect(idx).toEqual(before);
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(4);
  });
});

describe("withInheritedLayerMembership", () => {
  it("returns the same map when there is nothing to inherit", () => {
    const idx = indexLayers([{ id: "L1", name: "L1", description: "", nodeIds: ["a"] }]);
    expect(withInheritedLayerMembership(idx, new Map())).toBe(idx);
  });

  it("does not override a child's own layers", () => {
    const idx = indexLayers([
      { id: "L1", name: "L1", description: "", nodeIds: ["parent"] },
      { id: "L2", name: "L2", description: "", nodeIds: ["child"] },
    ]);
    const merged = withInheritedLayerMembership(idx, new Map([["child", "parent"]]));
    expect([...(merged.get("child") ?? [])]).toEqual(["L2"]);
  });
});

describe("filterLayers (overview canvas)", () => {
  const layers: Layer[] = [
    { id: "L1", name: "L1", description: "", nodeIds: [] },
    { id: "L2", name: "L2", description: "", nodeIds: [] },
  ];

  it("shows every layer when none is selected", () => {
    expect(filterLayers(layers, defaultFilters())).toBe(layers);
  });

  it("shows only the selected layers", () => {
    expect(filterLayers(layers, defaultFilters({ layerIds: new Set(["L2"]) })).map((l) => l.id)).toEqual(["L2"]);
  });
});
