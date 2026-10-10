/** Tarjan's strongly connected components. Returns components in reverse topological order (sinks first). */
export function tarjan(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];

  // Iterative to avoid stack overflow on big PRs.
  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work: { v: string; it: Iterator<string> }[] = [];
    const visit = (v: string) => {
      idx.set(v, index);
      low.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      work.push({ v, it: (edges.get(v) ?? new Set<string>()).values() });
    };
    visit(start);
    while (work.length) {
      const top = work[work.length - 1];
      const next = top.it.next();
      if (!next.done) {
        const w = next.value;
        if (!idx.has(w)) visit(w);
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
      }
      if (low.get(top.v) === idx.get(top.v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== top.v);
        out.push(comp.sort());
      }
    }
  }
  return out;
}

/**
 * Depth of every node = longest path (in SCC-condensed graph) to a node with no outgoing edges.
 * Edges point from importer to imported, so depth 0 = depends on no other node in the graph.
 */
export function computeDepths(nodes: string[], edges: Map<string, Set<string>>) {
  const comps = tarjan(nodes, edges);
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => c.forEach((n) => compOf.set(n, i)));
  const compDepth = new Array<number>(comps.length).fill(0);
  // tarjan emits sinks first, so a component's successors are always computed before it.
  comps.forEach((comp, i) => {
    let d = 0;
    for (const n of comp) {
      for (const w of edges.get(n) ?? []) {
        const j = compOf.get(w);
        if (j === undefined || j === i) continue;
        d = Math.max(d, compDepth[j] + 1);
      }
    }
    compDepth[i] = d;
  });
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n, compDepth[compOf.get(n)!]);
  const cycleOf = new Map<string, string[]>();
  for (const c of comps) if (c.length > 1) for (const n of c) cycleOf.set(n, c);
  return { depth, cycleOf, components: comps };
}
