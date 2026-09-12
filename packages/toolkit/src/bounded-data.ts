export interface AtlasTreeInspection {
  readonly nodes: number;
  readonly depth: number;
  readonly failure?: 'cycle' | 'depth' | 'nodes';
}

/**
 * Inspects parser-owned trees without recursion before any recursive
 * construction or diagnostic walk. Repeated object identity is rejected so
 * the same helper remains safe for programmatic inputs as well as parser ASTs.
 */
export function inspectAtlasTree<Node extends object>(
  root: Node,
  children: (node: Node) => readonly Node[],
  limits: {
    readonly maximumDepth: number;
    readonly maximumNodes: number;
  },
): AtlasTreeInspection {
  const pending: Array<readonly [Node, number]> = [[root, 1]];
  const seen = new Set<Node>();
  let nodes = 0;
  let depth = 0;

  while (pending.length > 0) {
    const [node, nodeDepth] = pending.pop() as readonly [Node, number];
    if (seen.has(node))
      return Object.freeze({ nodes, depth, failure: 'cycle' });
    seen.add(node);
    nodes += 1;
    depth = Math.max(depth, nodeDepth);
    if (nodes > limits.maximumNodes) {
      return Object.freeze({ nodes, depth, failure: 'nodes' });
    }
    if (nodeDepth > limits.maximumDepth) {
      return Object.freeze({ nodes, depth, failure: 'depth' });
    }
    const descendants = children(node);
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      pending.push([descendants[index] as Node, nodeDepth + 1]);
    }
  }

  return Object.freeze({ nodes, depth });
}
