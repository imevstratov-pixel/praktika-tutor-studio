const NODE_WIDTH = 218;
const NODE_HEIGHT = 92;
const COLUMN_GAP = 118;
const ROW_GAP = 52;
const PADDING = 48;
const list = value => Array.isArray(value) ? value : [];

// Condense cycles before assigning levels. A real concept relation may point
// backwards or form a cycle; neither is a reason to drop it from the drawing.
function conceptLevels(nodes, edges) {
  const ids = new Set(nodes.map(node => node.id));
  const adjacency = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) if (ids.has(edge.from) && ids.has(edge.to)) adjacency.get(edge.from).push(edge.to);
  let sequence = 0;
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), groups = [];
  function visit(id) {
    index.set(id, sequence); low.set(id, sequence++); stack.push(id); onStack.add(id);
    for (const target of adjacency.get(id)) {
      if (!index.has(target)) { visit(target); low.set(id, Math.min(low.get(id), low.get(target))); }
      else if (onStack.has(target)) low.set(id, Math.min(low.get(id), index.get(target)));
    }
    if (low.get(id) === index.get(id)) {
      const group = [];
      let member;
      do { member = stack.pop(); onStack.delete(member); group.push(member); } while (member !== id);
      groups.push(group);
    }
  }
  for (const node of nodes) if (!index.has(node.id)) visit(node.id);
  const groupOf = new Map(groups.flatMap((group, i) => group.map(id => [id, i])));
  const outgoing = groups.map(() => new Set()), incoming = groups.map(() => 0), levels = groups.map(() => 0);
  for (const edge of edges) {
    const from = groupOf.get(edge.from), to = groupOf.get(edge.to);
    if (from === undefined || to === undefined || from === to || outgoing[from].has(to)) continue;
    outgoing[from].add(to); incoming[to]++;
  }
  const queue = groups.map((_, i) => i).filter(i => incoming[i] === 0);
  for (let i = 0; i < queue.length; i++) {
    for (const target of outgoing[queue[i]]) {
      levels[target] = Math.max(levels[target], levels[queue[i]] + 1);
      if (--incoming[target] === 0) queue.push(target);
    }
  }
  return new Map(nodes.map(node => [node.id, levels[groupOf.get(node.id)]]));
}

function curve(from, to, lane, index) {
  const sx = from.x + from.width / 2, sy = from.y + from.height / 2;
  const tx = to.x + to.width / 2, ty = to.y + to.height / 2;
  let start, end, c1, c2;
  if (from.id === to.id) {
    start = { x: from.x + from.width + 5, y: sy - 15 };
    end = { x: sx, y: from.y - 6 };
    c1 = { x: start.x + 70 + lane * 24, y: start.y - 95 };
    c2 = { x: end.x + 60, y: end.y - 65 };
  } else if (Math.abs(tx - sx) < 1) {
    const side = index % 2 === 0 ? 1 : -1;
    start = { x: sx + side * (from.width / 2 + 5), y: sy };
    end = { x: tx + side * (to.width / 2 + 7), y: ty };
    const reach = 72 + lane * 28;
    c1 = { x: start.x + side * reach, y: sy };
    c2 = { x: end.x + side * reach, y: ty };
  } else {
    const direction = tx > sx ? 1 : -1;
    start = { x: sx + direction * (from.width / 2 + 5), y: sy };
    end = { x: tx - direction * (to.width / 2 + 7), y: ty };
    const reach = Math.max(38, Math.abs(end.x - start.x) * 0.47);
    const bend = lane ? (lane % 2 ? 1 : -1) * Math.ceil(lane / 2) * 30 : 0;
    c1 = { x: start.x + direction * reach, y: sy + bend };
    c2 = { x: end.x - direction * reach, y: ty + bend };
  }
  const round = number => Math.round(number * 10) / 10;
  const point = p => `${round(p.x)},${round(p.y)}`;
  return {
    path: `M${point(start)} C${point(c1)} ${point(c2)} ${point(end)}`,
    labelX: round((start.x + 3 * c1.x + 3 * c2.x + end.x) / 8),
    labelY: round((start.y + 3 * c1.y + 3 * c2.y + end.y) / 8),
    bounds: { left: Math.min(start.x, end.x, c1.x, c2.x), right: Math.max(start.x, end.x, c1.x, c2.x), top: Math.min(start.y, end.y, c1.y, c2.y), bottom: Math.max(start.y, end.y, c1.y, c2.y) },
  };
}

/** Pure layout of the actual graph. Membership is a visual distinction, never
 * a filter. The input package and its pedagogical contents are not rewritten. */
export function layoutKnowledgeGraph(pack) {
  const details = new Map([
    ...list(pack?.topics).map(node => [node.id, { ...node, type: 'topic' }]),
    ...list(pack?.terms).map(node => [node.id, { ...node, type: 'term' }]),
  ]);
  const seen = new Set();
  const nodes = list(pack?.graph?.nodes).filter(node => {
    if (!node || typeof node.id !== 'string' || seen.has(node.id)) return false;
    seen.add(node.id); return true;
  }).map((node, order) => {
    const detail = details.get(node.id) || {};
    return { ...node, ...detail, name: detail.name || node.label || node.id,
      type: detail.type || (node.type === 'topic' ? 'topic' : 'term'), evidenceIds: list(detail.evidenceIds || node.evidenceIds),
      order, width: NODE_WIDTH, height: NODE_HEIGHT };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges = [], unresolvedEdges = [];
  list(pack?.graph?.edges).forEach((edge, index) => {
    if (!edge || !byId.has(edge.from) || !byId.has(edge.to)) { unresolvedEdges.push({ edge, index }); return; }
    edges.push({ ...edge, index, isMembership: byId.get(edge.from).type === 'topic' && byId.get(edge.to).type === 'term' && edge.relation === 'содержит термин' });
  });
  const topics = nodes.filter(node => node.type === 'topic'), terms = nodes.filter(node => node.type === 'term');
  const levels = conceptLevels(terms, edges);
  const columns = new Map();
  for (const node of nodes) {
    // Bound the number of columns for long chains. Late levels share a column;
    // their real direction remains visible in the edge arrows and inspector.
    const column = node.type === 'topic' ? 0 : (topics.length ? 1 : 0) + Math.min(levels.get(node.id) || 0, 3);
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  }
  const topicOrder = new Map(topics.map((node, i) => [node.id, i]));
  const parentOrder = node => {
    const parents = edges.filter(edge => edge.to === node.id && edge.isMembership).map(edge => topicOrder.get(edge.from));
    return parents.length ? parents.reduce((sum, value) => sum + value, 0) / parents.length : topics.length;
  };
  const maxRows = Math.max(1, ...[...columns.values()].map(column => column.length));
  const contentHeight = maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  for (const [column, members] of columns) {
    if (members[0]?.type !== 'topic') members.sort((a, b) => parentOrder(a) - parentOrder(b) || a.order - b.order);
    const height = members.length * NODE_HEIGHT + Math.max(0, members.length - 1) * ROW_GAP;
    members.forEach((node, row) => {
      node.x = PADDING + column * (NODE_WIDTH + COLUMN_GAP);
      node.y = PADDING + (contentHeight - height) / 2 + row * (NODE_HEIGHT + ROW_GAP);
    });
  }
  const lanes = new Map();
  const positionedEdges = edges.map(edge => {
    const key = [edge.from, edge.to].sort().join('\u0000');
    const lane = lanes.get(key) || 0; lanes.set(key, lane + 1);
    return { ...edge, ...curve(byId.get(edge.from), byId.get(edge.to), lane, edge.index),
      labelWidth: Math.max(50, Math.min(224, Array.from(String(edge.relation || 'Связь')).length * 7.5 + 20)) };
  });
  // Leave room for arrows/loops outside the node columns, including backwards
  // and parallel relations, so local scrolling can reach the whole drawing.
  const left = Math.min(0, ...positionedEdges.map(edge => Math.min(edge.bounds.left - 24, edge.labelX - edge.labelWidth / 2 - 12)));
  const top = Math.min(0, ...positionedEdges.map(edge => edge.bounds.top - 24));
  const offsetX = -left, offsetY = -top;
  const width = Math.max(620, ...nodes.map(node => node.x + node.width + PADDING), ...positionedEdges.map(edge => Math.max(edge.bounds.right + PADDING, edge.labelX + edge.labelWidth / 2 + 12))) + offsetX;
  const height = Math.max(420, contentHeight + PADDING * 2, ...positionedEdges.map(edge => edge.bounds.bottom + PADDING)) + offsetY;
  return { nodes, edges: positionedEdges, unresolvedEdges, width, height, offsetX, offsetY };
}
