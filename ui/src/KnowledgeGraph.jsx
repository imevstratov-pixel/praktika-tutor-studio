import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, BookOpen, Circle, Focus, Minus, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { typeClass } from '@/lib/type-scale';
import { layoutKnowledgeGraph } from '@/lib/graph-layout.mjs';
import './knowledge-graph.css';

const MIN_ZOOM = 0.005;
const MAX_ZOOM = 1.8;
const normalize = value => value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
const kind = node => node.type === 'topic' ? 'Тема' : 'Термин';

function highlightedQuote(text, name) {
  if (!name) return text;
  const literal = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return text.split(new RegExp(`(${literal})`, 'giu')).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part);
}

function Inspector({ node, pack, edges, byId, onSelect }) {
  const inspector = useRef(null);
  useLayoutEffect(() => { if (inspector.current) inspector.current.scrollTop = 0; }, [node?.id]);
  const fragments = useMemo(() => new Map((pack.excerpts || []).map(fragment => [fragment.id, fragment])), [pack.excerpts]);
  const evidence = node ? [...new Set(node.evidenceIds)].map(id => fragments.get(id)).filter(Boolean) : [];
  const related = node ? edges.filter(edge => edge.from === node.id || edge.to === node.id) : [];
  return <aside ref={inspector} className="kg-inspector" role="region" aria-label="Сведения об узле">
    {node ? <>
      <div className="kg-inspector-heading">
        <span className={`kg-kind kg-kind-${node.type} ${typeClass('caption')}`}>{node.type === 'topic' ? <BookOpen size={15} aria-hidden="true"/> : <Circle size={13} aria-hidden="true"/>}{kind(node)}</span>
        <h4 className={typeClass('title')}>{node.name}</h4>
      </div>
      <div className={`kg-definition ${typeClass('body')}`}>
        <h5 className={typeClass('caption')}>{node.type === 'topic' ? 'Содержание темы' : 'Определение'}</h5>
        <p>{node.type === 'topic' ? (node.summary || 'Для этой темы пока нет описания.') : (node.definition || 'Для этого термина пока нет проверенного определения.')}</p>
      </div>
      <section className="kg-evidence">
        <h5 className={typeClass('subtitle')}>Опора в лекции</h5>
        <p className={`kg-lesson ${typeClass('caption')}`}>Лекция «{pack.title || 'Учебный материал'}»</p>
        {evidence.length ? evidence.map(fragment => <figure key={fragment.id}>
          <figcaption className={typeClass('caption')}>Фрагмент {fragment.id}</figcaption>
          <blockquote className={typeClass('body')} data-evidence-id={fragment.id}>{highlightedQuote(fragment.text, node.name)}</blockquote>
        </figure>) : <p className={typeClass('body')}>Для этого узла не указан опорный фрагмент.</p>}
      </section>
      {related.length > 0 && <section className="kg-connections">
        <h5 className={typeClass('subtitle')}>Связи узла</h5>
        <ul>{related.map(edge => {
          const outgoing = edge.from === node.id;
          const other = byId.get(outgoing ? edge.to : edge.from);
          return <li key={edge.index}>
            <span className={`kg-relation ${typeClass('caption')}`}>{outgoing ? <ArrowUpRight size={15} aria-hidden="true"/> : <ArrowDownLeft size={15} aria-hidden="true"/>}<span>{outgoing ? 'От этого узла: ' : 'К этому узлу: '}{edge.relation}</span></span>
            <Button variant="ghost" className="kg-neighbor" aria-label={`Перейти к узлу: ${other.name}`} onClick={() => onSelect(other.id, true)}>{other.name}</Button>
          </li>;
        })}</ul>
      </section>}
    </> : <div className="kg-inspector-empty">
      <BookOpen size={28} aria-hidden="true"/>
      <h4 className={typeClass('subtitle')}>Выберите термин или тему</h4>
      <p className={typeClass('body')}>Здесь появятся определение, связи и точные фрагменты лекции, на которых основан узел.</p>
    </div>}
  </aside>;
}

export default function KnowledgeGraph({ pack }) {
  const layout = useMemo(() => layoutKnowledgeGraph(pack), [pack]);
  const byId = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout]);
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(1);
  const viewport = useRef(null);
  const buttons = useRef(new Map());
  const pendingCenter = useRef(null);
  const drag = useRef(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/gu, '');
  const marker = `kg-arrow-${uid}`;
  const searchId = `kg-search-${uid}`;
  const selected = byId.get(selectedId) || null;
  const normalizedQuery = normalize(query);
  const matches = normalizedQuery ? layout.nodes.filter(node => normalize(node.name).includes(normalizedQuery)) : [];
  const matchIds = new Set(matches.map(node => node.id));
  const connected = new Set(selected ? layout.edges.filter(edge => edge.from === selected.id || edge.to === selected.id).flatMap(edge => [edge.from, edge.to]) : []);

  function centerOn(node, scale = zoom) {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({ left: (node.x + node.width / 2 + layout.offsetX) * scale - element.clientWidth / 2,
      top: (node.y + node.height / 2 + layout.offsetY) * scale - element.clientHeight / 2, behavior: 'instant' });
  }
  function selectNode(id, reveal = false) {
    const node = byId.get(id);
    if (!node) return;
    setSelectedId(id);
    if (reveal) {
      centerOn(node);
      buttons.current.get(id)?.focus({ preventScroll: true });
    }
  }
  function changeZoom(value, resetPosition = false) {
    const element = viewport.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    if (element) pendingCenter.current = resetPosition ? { x: layout.width / 2, y: layout.height / 2 } : {
      x: (element.scrollLeft + element.clientWidth / 2) / zoom,
      y: (element.scrollTop + element.clientHeight / 2) / zoom,
    };
    if (Math.abs(next - zoom) < 0.0001) {
      if (resetPosition && element) element.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      pendingCenter.current = null;
    } else setZoom(next);
  }
  function fitGraph() {
    const element = viewport.current;
    if (element) changeZoom(Math.min(element.clientWidth / layout.width, element.clientHeight / layout.height, 1), true);
  }
  useLayoutEffect(() => {
    const element = viewport.current, center = pendingCenter.current;
    if (element && center) element.scrollTo({ left: center.x * zoom - element.clientWidth / 2, top: center.y * zoom - element.clientHeight / 2, behavior: 'instant' });
    pendingCenter.current = null;
  }, [zoom]);

  function startPan(event) {
    if (event.button !== 0 || event.pointerType === 'touch' || event.target.closest('button')) return;
    const element = viewport.current;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    element.setPointerCapture(event.pointerId);
    element.dataset.panning = 'true';
  }
  function movePan(event) {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    viewport.current.scrollLeft = start.left - (event.clientX - start.x);
    viewport.current.scrollTop = start.top - (event.clientY - start.y);
  }
  function endPan(event) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (viewport.current?.hasPointerCapture(event.pointerId)) viewport.current.releasePointerCapture(event.pointerId);
    if (viewport.current) delete viewport.current.dataset.panning;
  }

  return <div className="kg">
    <div className="kg-toolbar">
      <div className="kg-search">
        <label className={typeClass('caption')} htmlFor={searchId}>Найти тему или термин</label>
        <div className="kg-search-field"><Search size={17} aria-hidden="true"/><Input id={searchId} type="search" value={query} placeholder="Название узла"
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && matches[0]) { event.preventDefault(); selectNode(matches[0].id, true); } }}/></div>
      </div>
      <div className="kg-zoom" role="group" aria-label="Масштаб графа">
        <Button variant="tertiary" size="icon" aria-label="Уменьшить граф" title="Уменьшить граф" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - 0.2)}><Minus size={17} aria-hidden="true"/></Button>
        <output className={typeClass('caption')} aria-label="Текущий масштаб" aria-live="polite">{Math.round(zoom * 100)}%</output>
        <Button variant="tertiary" size="icon" aria-label="Увеличить граф" title="Увеличить граф" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + 0.2)}><Plus size={17} aria-hidden="true"/></Button>
        <Button variant="secondary" leadingIcon={Focus} aria-label="Вписать граф" onClick={fitGraph}>Вписать</Button>
        <Button variant="ghost" aria-label="Масштаб 100%" onClick={() => changeZoom(1)}>100%</Button>
      </div>
    </div>
    {normalizedQuery && <div className="kg-search-results">
      <p className={typeClass('caption')} role="status">{matches.length ? `Найдено узлов: ${matches.length}. Выберите нужный, чтобы показать его на графе.` : 'Ничего не найдено. Попробуйте часть названия.'}{matches.length > 12 ? ' Показаны первые 12; уточните запрос.' : ''}</p>
      {matches.length > 0 && <div>{matches.slice(0, 12).map(node => <Button key={node.id} variant="tertiary" className="kg-search-result" aria-label={`Показать узел: ${node.name}`} onClick={() => selectNode(node.id, true)}>{node.name}</Button>)}</div>}
    </div>}
    <div className={`kg-legend ${typeClass('caption')}`} aria-label="Обозначения графа">
      <span><i className="kg-legend-topic" aria-hidden="true"/>Тема</span><span><i className="kg-legend-term" aria-hidden="true"/>Термин</span><span><i className="kg-legend-membership" aria-hidden="true"/>Тема включает термин</span><span><i className="kg-legend-relation" aria-hidden="true"/>Связь понятий</span>
    </div>
    <div className="kg-layout">
      <div className="kg-drawing">
        <div ref={viewport} className="kg-viewport" role="region" aria-label="Граф знаний: узлы и связи" tabIndex={0}
          aria-describedby={`kg-help-${uid}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            if (['+', '=', '-', '0'].includes(event.key)) {
              event.preventDefault(); changeZoom(event.key === '0' ? 1 : zoom + (event.key === '-' ? -0.2 : 0.2));
            }
          }}>
          {layout.nodes.length ? <div className="kg-scroll-space" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
            <div className="kg-scene" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
              <svg className="kg-edges" width={layout.width} height={layout.height} role="group" aria-label="Направленные связи графа">
                <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>
                <g transform={`translate(${layout.offsetX} ${layout.offsetY})`}>{layout.edges.map(edge => {
                  const active = selected && (edge.from === selected.id || edge.to === selected.id);
                  const label = String(edge.relation || 'Связь');
                  const showLabel = active || (!edge.isMembership && layout.edges.length <= 25);
                  return <g key={edge.index} role="img" aria-label={`${byId.get(edge.from).name} — ${label} → ${byId.get(edge.to).name}`} className={`kg-edge ${edge.isMembership ? 'kg-edge-membership' : 'kg-edge-semantic'} ${active ? 'is-active' : ''}`}>
                    <path data-graph-edge="" data-edge-index={edge.index} data-from={edge.from} data-to={edge.to} data-relation={edge.relation} d={edge.path} markerEnd={`url(#${marker})`}/>
                    {showLabel && <foreignObject className="kg-edge-label" x={edge.labelX - edge.labelWidth / 2} y={edge.labelY - 14} width={edge.labelWidth} height="28" aria-hidden="true"><div className="kg-edge-label-box">{label}</div></foreignObject>}
                  </g>;
                })}</g>
              </svg>
              {layout.nodes.map(node => <button key={node.id} type="button" ref={element => { if (element) buttons.current.set(node.id, element); else buttons.current.delete(node.id); }}
                className={`kg-node kg-node-${node.type} ${selected?.id === node.id ? 'is-selected' : ''} ${connected.has(node.id) ? 'is-connected' : ''} ${matchIds.has(node.id) ? 'is-match' : ''}`}
                style={{ left: node.x + layout.offsetX, top: node.y + layout.offsetY, width: node.width, height: node.height }}
                data-graph-node={node.id} aria-label={`${kind(node)}: ${node.name}`} aria-pressed={selected?.id === node.id} title={node.name}
                onClick={() => selectNode(node.id)} onFocus={event => { if (event.currentTarget.matches(':focus-visible')) centerOn(node); }}>
                <span className={`kg-node-kind ${typeClass('caption')}`}>{node.type === 'topic' ? <BookOpen size={14} aria-hidden="true"/> : <Circle size={11} aria-hidden="true"/>}{kind(node)}</span>
                <span className={`kg-node-name ${typeClass('subtitle')}`}>{node.name}</span>
              </button>)}
            </div>
          </div> : <div className="kg-canvas-empty"><p>В этом занятии пока нет узлов графа.</p></div>}
        </div>
        <p id={`kg-help-${uid}`} className={`kg-canvas-help ${typeClass('caption')}`}>Нажмите узел, чтобы увидеть его содержание. Перетаскивайте свободное поле или прокручивайте граф. С клавиатуры: Tab — узлы, Enter — выбор.</p>
        {layout.unresolvedEdges.length > 0 && <p className={`kg-canvas-help ${typeClass('caption')}`}>Не удалось показать связей: {layout.unresolvedEdges.length}. В данных отсутствуют их узлы.</p>}
      </div>
      <Inspector node={selected} pack={pack} edges={layout.edges} byId={byId} onSelect={selectNode}/>
    </div>
  </div>;
}
