import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutKnowledgeGraph } from '../src/lib/graph-layout.mjs';

function pack(nodes, edges) {
  return {
    title: 'Граф занятия',
    topics: nodes.filter(node => node.type === 'topic').map(node => ({ id: node.id, name: node.label, summary: 'Содержание темы.', evidenceIds: ['e1'] })),
    terms: nodes.filter(node => node.type !== 'topic').map(node => ({ id: node.id, name: node.label, definition: 'Проверенная трактовка.', evidenceIds: ['e1'], topicIds: [] })),
    excerpts: [{ id: 'e1', text: 'Дословный фрагмент лекции.' }],
    graph: { nodes, edges },
  };
}
const topic = (id, label = id) => ({ id, label, type: 'topic' });
const term = (id, label = id) => ({ id, label, type: 'term' });
const edge = (from, to, relation = 'содержит термин') => ({ from, to, relation, evidenceIds: ['e1'] });

function assertUsableGeometry(layout) {
  assert(Number.isFinite(layout.width) && layout.width > 0);
  assert(Number.isFinite(layout.height) && layout.height > 0);
  assert(Number.isFinite(layout.offsetX) && Number.isFinite(layout.offsetY));
  for (const node of layout.nodes) {
    assert([node.x, node.y, node.width, node.height].every(Number.isFinite));
    assert(node.width >= 180 && node.height >= 44, 'Nodes remain readable and clickable at the default scale');
    assert(node.x + layout.offsetX >= 0 && node.y + layout.offsetY >= 0);
    assert(node.x + node.width + layout.offsetX <= layout.width);
    assert(node.y + node.height + layout.offsetY <= layout.height);
  }
  for (let i = 0; i < layout.nodes.length; i++) {
    for (const other of layout.nodes.slice(i + 1)) {
      const node = layout.nodes[i];
      const overlaps = node.x < other.x + other.width && node.x + node.width > other.x && node.y < other.y + other.height && node.y + node.height > other.y;
      assert(!overlaps, `Nodes ${node.id} and ${other.id} must not overlap`);
    }
  }
  for (const relation of layout.edges) {
    assert(relation.path.startsWith('M') && relation.path.includes(' C'));
    assert(!/NaN|Infinity/u.test(relation.path));
    assert(Number.isFinite(relation.labelX) && Number.isFinite(relation.labelY));
    assert(relation.bounds.left + layout.offsetX >= 0);
    assert(relation.bounds.top + layout.offsetY >= 0);
    assert(relation.bounds.right + layout.offsetX <= layout.width);
    assert(relation.bounds.bottom + layout.offsetY <= layout.height);
    assert(relation.labelX - relation.labelWidth / 2 + layout.offsetX >= 0);
    assert(relation.labelX + relation.labelWidth / 2 + layout.offsetX <= layout.width);
  }
}

test('a term shared by two topics stays one node, with every original relation and citation', () => {
  const input = pack([topic('t1'), topic('t2'), term('k1'), term('k2')], [edge('t1', 'k1'), edge('t2', 'k1'), edge('k1', 'k2')]);
  input.terms[0].topicIds = ['t1', 't2'];
  const layout = layoutKnowledgeGraph(input);
  assert.equal(layout.nodes.filter(node => node.id === 'k1').length, 1);
  assert.equal(layout.edges.length, input.graph.edges.length);
  assert.deepEqual(layout.edges.map(({ from, to, relation, evidenceIds }) => ({ from, to, relation, evidenceIds })), input.graph.edges);
  assert.equal(layout.edges[0].isMembership, true);
  assert.equal(layout.edges[2].isMembership, false, 'A term-to-term relationship is not topic membership, even with the same wording');
  assert.equal(layout.nodes.find(node => node.id === 'k1').definition, input.terms[0].definition);
  assert.deepEqual(layout.nodes.find(node => node.id === 'k1').evidenceIds, ['e1']);
  assertUsableGeometry(layout);
});

test('cycles, disconnected concepts and isolated topics remain visible without overlapping nodes', () => {
  const input = pack([topic('t1'), topic('empty'), term('a'), term('b'), term('c'), term('alone')], [
    edge('t1', 'a'), edge('a', 'b', 'влияет на'), edge('b', 'c', 'требует'), edge('c', 'a', 'определяет'),
  ]);
  const layout = layoutKnowledgeGraph(input);
  assert.deepEqual(new Set(layout.nodes.map(node => node.id)), new Set(input.graph.nodes.map(node => node.id)));
  assert.equal(layout.edges.length, 4);
  assertUsableGeometry(layout);
});

test('parallel and reverse relations have separate paths instead of overwriting one another', () => {
  const input = pack([term('a'), term('b')], [edge('a', 'b', 'включает'), edge('a', 'b', 'зависит от'), edge('b', 'a', 'влияет на')]);
  const layout = layoutKnowledgeGraph(input);
  assert.equal(layout.edges.length, 3);
  assert.equal(new Set(layout.edges.map(relation => relation.path)).size, 3);
  assert.deepEqual(layout.edges.map(relation => relation.index), [0, 1, 2]);
  assertUsableGeometry(layout);
});

test('layout is deterministic and leaves the reviewed package and export unchanged', () => {
  const input = pack([topic('t'), term('x'), term('y')], [edge('t', 'x'), edge('x', 'y', 'определяет')]);
  const before = structuredClone(input);
  const first = layoutKnowledgeGraph(input);
  assert.deepEqual(layoutKnowledgeGraph(input), first);
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(input), JSON.stringify(before));
  assertUsableGeometry(first);
});

test('long labels are preserved for accessible names and inspector rather than truncated in data', () => {
  const label = 'Длинное название понятия '.repeat(11) + '😀';
  const input = pack([term('k', label)], []);
  const layout = layoutKnowledgeGraph(input);
  assert.equal(layout.nodes[0].name, label);
  assert.equal(layout.nodes[0].name.isWellFormed(), true);
  assertUsableGeometry(layout);
});

test('large branching graphs and long concept chains keep every node and edge in finite scroll bounds', () => {
  for (const chain of [false, true]) {
    const nodes = [topic('t'), ...Array.from({ length: 160 }, (_, i) => term('k' + i))];
    const relations = nodes.slice(1).map(node => edge('t', node.id));
    if (chain) for (let i = 0; i < 159; i++) relations.push(edge('k' + i, 'k' + (i + 1), 'предшествует'));
    const layout = layoutKnowledgeGraph(pack(nodes, relations));
    assert.equal(layout.nodes.length, nodes.length);
    assert.equal(layout.edges.length, relations.length);
    assertUsableGeometry(layout);
  }
});

test('empty data is safe and an invalid endpoint is reported separately rather than fabricated', () => {
  for (const input of [null, {}, pack([], [])]) {
    const layout = layoutKnowledgeGraph(input);
    assert.deepEqual(layout.nodes, []);
    assert.deepEqual(layout.edges, []);
    assertUsableGeometry(layout);
  }
  const layout = layoutKnowledgeGraph(pack([term('k')], [edge('k', 'missing')]));
  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.edges.length, 0);
  assert.equal(layout.unresolvedEdges.length, 1);
  assert.equal(layout.unresolvedEdges[0].edge.to, 'missing');
});

test('a self relation is drawn as a finite loop and remains part of the graph', () => {
  const layout = layoutKnowledgeGraph(pack([term('k')], [edge('k', 'k', 'ссылается на')]));
  assert.equal(layout.edges.length, 1);
  assertUsableGeometry(layout);
});

test('a long label on a left-facing relation remains inside the reachable canvas', () => {
  const input=pack([topic('t1'),topic('t2'),term('k')],[edge('t1','k'),edge('t2','t1','определяет дополнительные условия для выполнения')]);
  const layout=layoutKnowledgeGraph(input);
  assert.equal(layout.edges[1].relation,input.graph.edges[1].relation);
  assertUsableGeometry(layout);
});
