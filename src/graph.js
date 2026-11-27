// Graph helpers shared by the validator and the orchestrator (#流水线:#10).
// Node ids are strings; edges only contribute from/to; nothing here uses an
// object as a Map/Set key.
export function stronglyConnectedIds(ids, edges) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of edges) if (adj.has(e.from)) adj.get(e.from).push(e.to);
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      out.push(comp);
    }
  };
  for (const id of ids) if (!idx.has(id)) visit(id);
  return out;
}
