/**
 * Interactive dependency graph (Cytoscape.js).
 *
 * Nodes are files; edges are resolved intra-repository imports. External and
 * unresolved specifiers are counted and shown in the inspector, never drawn as
 * edges, because they do not connect two files Riftmap knows about.
 *
 * Large repositories fall back to a bounded subgraph: Riftmap draws the most
 * connected files and says plainly how many nodes were left out, rather than
 * trying to lay out tens of thousands of nodes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import { formatCount } from '@riftmap/shared';
import type { AnalyzedFile } from '@riftmap/shared';
import { useApp } from '../state/store.js';
import { EmptyState, Panel, ScoreBadge, Tag, cx } from '../components/primitives.js';
import { BAND_COLOR } from '../components/primitives.js';
import { FilterBar, Toggle, useFilteredFiles } from '../components/FilterBar.js';
import { DetailsPanel } from '../components/DetailsPanel.js';

const NODE_LIMIT_OPTIONS = [150, 300, 600, 1200] as const;
const ABSOLUTE_NODE_LIMIT = 2000;

export function DependenciesView(): JSX.Element {
  const { analysis, selectedPath, select } = useApp();
  const files = analysis?.files ?? [];
  const filtered = useFilteredFiles(files);
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [limit, setLimit] = useState<number>(300);
  const [layout, setLayout] = useState<'cose' | 'breadthfirst' | 'concentric'>('cose');
  const [query, setQuery] = useState('');
  const [truncated, setTruncated] = useState(false);

  const graph = useMemo(() => {
    if (!analysis) return null;
    const allowed = new Set(filtered.map((file) => file.path));
    const resolved = analysis.edges.filter(
      (edge) => edge.confidence === 'resolved' && edge.to !== null && allowed.has(edge.from) && allowed.has(edge.to),
    );

    const degree = new Map<string, number>();
    for (const edge of resolved) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to as string, (degree.get(edge.to as string) ?? 0) + 1);
    }

    // Files with no resolved edges are still interesting on their own, but a
    // graph view is about connections: keep the best connected ones first.
    const ranked = [...filtered].sort((a, b) => {
      const degreeDiff = (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0);
      if (degreeDiff !== 0) return degreeDiff;
      return b.score.score - a.score.score;
    });

    const budget = Math.min(limit, ABSOLUTE_NODE_LIMIT);
    const included = ranked.slice(0, budget);
    const includedSet = new Set(included.map((file) => file.path));
    const edges = resolved.filter((edge) => includedSet.has(edge.from) && includedSet.has(edge.to as string));

    return {
      nodes: included,
      edges,
      omitted: Math.max(0, filtered.length - included.length),
      omittedEdges: Math.max(0, resolved.length - edges.length),
      totalResolved: resolved.length,
    };
  }, [analysis, filtered, limit]);

  useEffect(() => {
    setTruncated(Boolean(graph && graph.omitted > 0));
  }, [graph]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !graph) return;

    const elements: ElementDefinition[] = [
      ...graph.nodes.map((file) => ({
        group: 'nodes' as const,
        data: {
          id: file.path,
          label: file.name,
          degree: (file.dependencyCount + file.dependentCount) as number,
          color: BAND_COLOR[file.score.band],
          score: file.score.score,
        },
      })),
      ...graph.edges.map((edge) => ({
        group: 'edges' as const,
        data: { id: `${edge.from}->${edge.to}`, source: edge.from, target: edge.to as string },
      })),
    ];

    const cy = cytoscape({
      container,
      elements,
      layout: { name: layout, animate: false, padding: 24 } as never,
      minZoom: 0.1,
      maxZoom: 3,
      wheelSensitivity: 0.25,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'background-opacity': 0.5,
            'border-color': 'data(color)',
            'border-width': 1.5,
            label: 'data(label)',
            color: '#cdd4de',
            'font-size': 9,
            'text-valign': 'center',
            'text-halign': 'right',
            'text-margin-x': 4,
            'text-outline-width': 2,
            'text-outline-color': '#12151a',
            width: 'mapData(degree, 0, 30, 14, 60)',
            height: 'mapData(degree, 0, 30, 14, 60)',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1,
            'line-color': '#3a4350',
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#3a4350',
            'arrow-scale': 0.7,
            opacity: 0.55,
          },
        },
        {
          selector: 'node:selected',
          style: { 'border-width': 3, 'border-color': '#67e8f9', 'background-opacity': 0.85 },
        },
        { selector: 'edge.hl', style: { 'line-color': '#22d3ee', 'target-arrow-color': '#22d3ee', opacity: 1, width: 2 } },
        { selector: 'node.hl', style: { 'border-width': 3, 'border-color': '#67e8f9', 'background-opacity': 0.9 } },
        { selector: 'node.faded, edge.faded', style: { opacity: 0.08 } },
        { selector: 'node.hit', style: { 'border-color': '#f59e0b', 'border-width': 3 } },
      ],
    });

    cy.on('tap', 'node', (event) => {
      const id = event.target.id();
      select(id);
      highlight(cy, id);
    });
    cy.on('tap', (event) => {
      if (event.target === cy) {
        cy.elements().removeClass('hl faded');
      }
    });

    cyRef.current = cy;
    const observer = new ResizeObserver(() => cy.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph, layout, select]);

  // Reflect an externally-driven selection (table row, other view) in the graph.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selectedPath) return;
    if (cy.$id(selectedPath).length === 0) return;
    highlight(cy, selectedPath);
  }, [selectedPath, graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !query.trim()) {
      cy?.elements().removeClass('hit');
      return;
    }
    const needle = query.trim().toLowerCase();
    cy.nodes().removeClass('hit');
    cy.nodes().filter((node) => node.id().toLowerCase().includes(needle)).addClass('hit');
  }, [query, graph]);

  const selected = useMemo(
    () => (analysis ? (analysis.files.find((file) => file.path === selectedPath) ?? null) : null),
    [analysis, selectedPath],
  );

  if (!analysis) {
    return (
      <div className="p-6">
        <EmptyState title="No repository analysed yet" description="Open a folder to explore its dependencies." />
      </div>
    );
  }

  const unresolvedCount = analysis.summary.unresolvedEdgeCount + analysis.summary.externalEdgeCount;

  return (
    <div className="flex min-h-0 flex-col">
      <FilterBar
        files={files}
        extra={
          <div className="ml-auto flex items-end gap-3">
            <div>
              <label className="label" htmlFor="dep-search">
                Find file
              </label>
              <input
                id="dep-search"
                className="input mt-1 w-48"
                placeholder="app.ts"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Toggle
              label="Layout"
              value={layout}
              onChange={(value) => setLayout(value as typeof layout)}
              options={[
                { value: 'cose', label: 'Force', hint: 'Force-directed layout' },
                { value: 'breadthfirst', label: 'Hierarchy', hint: 'Layered by dependency direction' },
                { value: 'concentric', label: 'Concentric', hint: 'Rings by connection count' },
              ]}
            />
          </div>
        }
      />

      {truncated ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-attention-high/30 bg-attention-high/10 px-4 py-2">
          <span className="text-2xs text-attention-high">
            Showing the {formatCount(graph?.nodes.length ?? 0)} best-connected files; {formatCount(graph?.omitted ?? 0)}{' '}
            filtered files are not drawn.
          </span>
          <div className="flex items-center gap-1.5">
            <span className="label">Max nodes</span>
            <select
              className="input w-24"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              aria-label="Maximum nodes to draw"
            >
              {NODE_LIMIT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel
          title="Import graph"
          note={`${formatCount(graph?.edges.length ?? 0)} resolved edges drawn · ${formatCount(unresolvedCount)} external or unresolved specifiers are listed in the inspector`}
          className="min-h-[26rem]"
          bodyClassName="relative min-h-0"
          actions={
            <div className="flex items-center gap-2 text-2xs text-graphite-400">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: BAND_COLOR.high }} />
                high
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: BAND_COLOR.moderate }} />
                moderate
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: BAND_COLOR.lower }} />
                lower
              </span>
            </div>
          }
        >
          <div ref={containerRef} className="absolute inset-0" />
          {(graph?.nodes.length ?? 0) === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState
                compact
                title="No dependencies to draw"
                description="No resolved imports between the filtered files. Try widening the filters."
              />
            </div>
          ) : null}
          <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1">
            <Tag>drag to pan · scroll to zoom · click a node to inspect</Tag>
            <Tag>node size = connection count · colour = attention band</Tag>
          </div>
        </Panel>

        <div className="min-h-0 space-y-4 overflow-auto">
          <DetailsPanel file={selected} analysis={analysis} />
          <NeighbourList
            files={graph?.nodes ?? []}
            onSelect={select}
            selectedPath={selectedPath}
          />
        </div>
      </div>
    </div>
  );
}

function highlight(cy: Core, id: string): void {
  const node = cy.$id(id);
  if (node.length === 0) return;
  const neighbourhood = node.closedNeighborhood();
  cy.elements().addClass('faded');
  neighbourhood.removeClass('faded').addClass('hl');
  node.removeClass('faded').addClass('hl');
}

function NeighbourList({
  files,
  onSelect,
  selectedPath,
}: {
  files: AnalyzedFile[];
  onSelect: (path: string) => void;
  selectedPath: string | null;
}): JSX.Element {
  const ranked = useMemo(
    () => [...files].sort((a, b) => b.dependencyCount + b.dependentCount - (a.dependencyCount + a.dependentCount)).slice(0, 40),
    [files],
  );
  return (
    <Panel title="Most connected files" note="Drawn subgraph only" bodyClassName="overflow-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">File</th>
            <th className="th w-14 text-right">Score</th>
            <th className="th w-12 text-right">Out</th>
            <th className="th w-12 text-right">In</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((file) => (
            <tr
              key={file.path}
              className={cx('cursor-pointer hover:bg-graphite-800', file.path === selectedPath && 'bg-graphite-800')}
              onClick={() => onSelect(file.path)}
            >
              <td className="td font-mono text-2xs" title={file.path}>
                {file.path}
              </td>
              <td className="td text-right">
                <ScoreBadge score={file.score.score} band={file.score.band} />
              </td>
              <td className="td num text-right">{file.dependencyCount}</td>
              <td className="td num text-right">{file.dependentCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
