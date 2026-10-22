import type { GraphNode, GraphEdge, Layer } from "@understand-anything/core/types";
import type { FilterState, NodeType, Complexity, EdgeCategory } from "../store";
import { EDGE_CATEGORY_MAP } from "../store";

/**
 * Filter nodes based on active filters.
 *
 * Pass `nodeIdToLayerIds` from the store (precomputed once on `setGraph`)
 * so the layer-membership check is O(1) per node. The previous shape took
 * `Layer[]` and ran `layer.nodeIds.includes(node.id)` per node-per-layer,
 * which was O(N × L × K) and dominated export time on large graphs (#102).
 *
 * Membership semantics are any-layer-wins, matching the prior shape: a
 * node in L1 and L2 with only L2 selected passes. The store's other
 * index, `nodeIdToLayerId`, is first-wins and is for navigation, not
 * filtering — using it here would silently drop multi-layer nodes whose
 * first declared layer isn't selected.
 */
export function filterNodes(
  nodes: GraphNode[],
  nodeIdToLayerIds: Map<string, Set<string>>,
  filters: FilterState,
): GraphNode[] {
  const hasLayerFilter = filters.layerIds.size > 0;
  return nodes.filter((node) => {
    // Filter by node type
    if (!filters.nodeTypes.has(node.type as NodeType)) {
      return false;
    }

    // Filter by complexity
    if (node.complexity && !filters.complexities.has(node.complexity as Complexity)) {
      return false;
    }

    // Filter by layer (if any layers are selected)
    if (hasLayerFilter) {
      const layerIds = nodeIdToLayerIds.get(node.id);
      if (!layerIds) return false;
      let inSelected = false;
      for (const lid of layerIds) {
        if (filters.layerIds.has(lid)) {
          inSelected = true;
          break;
        }
      }
      if (!inSelected) return false;
    }

    return true;
  });
}

/**
 * Filter edges based on visible nodes and active edge category filters
 */
export function filterEdges(
  edges: GraphEdge[],
  visibleNodeIds: Set<string>,
  filters: FilterState,
): GraphEdge[] {
  return edges.filter((edge) => {
    // Only keep edges between visible nodes
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) {
      return false;
    }

    // Filter by edge category
    const edgeCategory = getEdgeCategory(edge.type);
    if (edgeCategory && !filters.edgeCategories.has(edgeCategory)) {
      return false;
    }

    return true;
  });
}

/**
 * Extend the layer index so each child node (e.g. a function or class inside
 * a file) counts as a member of its parent's layers. Layers usually list only
 * file nodes; without this a layer filter would hide every sub-file node.
 * `parentByChild` maps child node id -> parent node id. Returns the input map
 * untouched when there is nothing to inherit.
 */
export function withInheritedLayerMembership(
  nodeIdToLayerIds: Map<string, Set<string>>,
  parentByChild: Map<string, string>,
): Map<string, Set<string>> {
  if (parentByChild.size === 0) return nodeIdToLayerIds;
  const merged = new Map(nodeIdToLayerIds);
  for (const [childId, parentId] of parentByChild) {
    if (merged.has(childId)) continue;
    const parentLayers = nodeIdToLayerIds.get(parentId);
    if (parentLayers) merged.set(childId, parentLayers);
  }
  return merged;
}

/**
 * Apply the filter-panel state to the nodes and edges a graph view is about
 * to render: node type, complexity and layer on nodes, then edge category on
 * the edges between the surviving nodes. This is what the structural view
 * calls so the panel's checkboxes actually change the canvas.
 *
 * `parentByChild` (optional) lets sub-file nodes inherit their parent's
 * layers for the layer filter.
 */
export function applyFilterPanel(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeIdToLayerIds: Map<string, Set<string>>,
  filters: FilterState,
  parentByChild?: Map<string, string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const membership =
    parentByChild && filters.layerIds.size > 0
      ? withInheritedLayerMembership(nodeIdToLayerIds, parentByChild)
      : nodeIdToLayerIds;
  const keptNodes = filterNodes(nodes, membership, filters);
  const keptIds = new Set(keptNodes.map((n) => n.id));
  return { nodes: keptNodes, edges: filterEdges(edges, keptIds, filters) };
}

/**
 * Layers still visible under the filter panel's layer selection (all of them
 * when none is selected). Used by the layer-overview canvas.
 */
export function filterLayers(layers: Layer[], filters: FilterState): Layer[] {
  if (filters.layerIds.size === 0) return layers;
  return layers.filter((layer) => filters.layerIds.has(layer.id));
}

/**
 * Determine which category an edge type belongs to
 */
// Reverse index (edge type → category), built once at module load. Replaces a
// per-edge linear scan over every category's type array — `getEdgeCategory`
// runs for every edge in `filterEdges`. First category wins, matching the
// original `Object.entries` scan order.
const EDGE_TYPE_TO_CATEGORY: Map<string, EdgeCategory> = (() => {
  const m = new Map<string, EdgeCategory>();
  for (const [category, types] of Object.entries(EDGE_CATEGORY_MAP)) {
    for (const t of types) {
      if (!m.has(t)) m.set(t, category as EdgeCategory);
    }
  }
  return m;
})();

function getEdgeCategory(edgeType: string): EdgeCategory | null {
  return EDGE_TYPE_TO_CATEGORY.get(edgeType) ?? null;
}
