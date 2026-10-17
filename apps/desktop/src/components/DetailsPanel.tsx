/**
 * The file inspector.
 *
 * Shows the measured metrics for one file, the full attention-score breakdown
 * (weights, normalised values and contributions), and a bounded source
 * preview. The preview is fetched through the main process, capped in size and
 * never executed or evaluated.
 */

import { useEffect, useMemo } from 'react';
import { formatBytes, formatCount, formatDate, formatRelative, ATTENTION_BAND_LABEL } from '@riftmap/shared';
import type { AnalyzedFile, RepositoryAnalysis } from '@riftmap/shared';
import { useApp } from '../state/store.js';
import { BandPill, Bar, BAND_COLOR, Panel, ScoreBadge, Skeleton, Tag, cx } from './primitives.js';

export function DetailsPanel({ file, analysis }: { file: AnalyzedFile | null; analysis: RepositoryAnalysis }): JSX.Element {
  const { repoPath, preview, previewLoading, requestPreview, select } = useApp();

  useEffect(() => {
    requestPreview(file?.path ?? null);
  }, [file?.path, requestPreview]);

  const edges = useMemo(() => {
    if (!file) return { dependsOn: [] as string[], usedBy: [] as string[] };
    return {
      dependsOn: analysis.edges.filter((edge) => edge.from === file.path && edge.confidence === 'resolved').map((edge) => edge.to as string),
      usedBy: analysis.edges.filter((edge) => edge.to === file.path && edge.confidence === 'resolved').map((edge) => edge.from),
    };
  }, [analysis.edges, file]);

  const unresolved = useMemo(
    () => (file ? analysis.edges.filter((edge) => edge.from === file.path && edge.confidence !== 'resolved') : []),
    [analysis.edges, file],
  );

  if (!file) {
    return (
      <Panel title="Inspector" note="Select a file to inspect its metrics">
        <p className="text-xs leading-relaxed text-graphite-400">
          Nothing selected. Click a point in the Hotspot Explorer, a node in the dependency graph, a rectangle in
          the treemap, or a row in the file table.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={<span className="font-mono text-xs">{file.path}</span>}
      note={repoPath ? `${repoPath} · ${formatBytes(file.bytes)} · ${file.languageName}` : file.languageName}
      actions={<button type="button" className="btn btn-ghost" onClick={() => select(null)} aria-label="Close inspector">✕</button>}
      bodyClassName="overflow-auto"
    >
      <div className="space-y-5 p-4">
        <div className="flex items-center gap-3">
          <ScoreBadge score={file.score.score} band={file.score.band} />
          <BandPill band={file.score.band} />
          <span className="text-2xs text-graphite-400">attention score 0–100</span>
        </div>

        <ScoreBreakdown file={file} />

        <Section title="Source metrics">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Row label="Size" value={formatBytes(file.bytes)} />
            <Row label="Physical lines" value={formatCount(file.lines)} />
            <Row label="Code lines" value={file.codeLines === null ? 'not measured' : formatCount(file.codeLines)} />
            <Row
              label="Comment lines"
              value={file.commentLines === null ? 'not measured' : formatCount(file.commentLines)}
            />
            <Row label="Blank lines" value={file.blankLines === null ? 'not measured' : formatCount(file.blankLines)} />
            <Row label="Est. functions" value={file.functionCount === null ? 'not measured' : formatCount(file.functionCount)} />
            <Row
              label="Est. complexity"
              value={file.cyclomatic === null ? 'not measured' : formatCount(file.cyclomatic)}
            />
            <Row label="Branches" value={file.branchCount === null ? '—' : formatCount(file.branchCount)} />
            <Row label="Loops" value={file.loopCount === null ? '—' : formatCount(file.loopCount)} />
            <Row label="Max nesting" value={file.maxNesting === null ? '—' : formatCount(file.maxNesting)} />
            <Row label="Imports" value={`${file.resolvedImportCount} resolved / ${file.importCount} total`} />
            <Row label="Content scanned" value={file.contentScanned ? 'yes' : 'no (size limit)'} />
          </dl>
          {!file.contentScanned ? (
            <p className="mt-2 text-2xs text-attention-high">
              This file exceeded the size limit, so lexical metrics were not measured. Only size and, if enabled,
              the physical line count are known.
            </p>
          ) : null}
        </Section>

        <Section title="Change activity">
          {file.git ? (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <Row label="Commits (window)" value={formatCount(file.git.changeCount)} />
                <Row label="Authors (window)" value={formatCount(file.git.authors)} />
                <Row label="Insertions" value={formatCount(file.git.insertions)} />
                <Row label="Deletions" value={formatCount(file.git.deletions)} />
                <Row label="Churn" value={formatCount(file.git.churn)} />
                <Row label="Last modified" value={formatRelative(file.git.lastModified)} />
              </dl>
              {file.git.authorCounts.length > 0 ? (
                <div className="mt-3">
                  <p className="label mb-1.5">Contributors</p>
                  <ul className="space-y-1">
                    {file.git.authorCounts.slice(0, 5).map((entry) => (
                      <li key={entry.author} className="flex items-center gap-2 text-2xs">
                        <span className="w-40 shrink-0 truncate text-graphite-300" title={entry.author}>
                          {entry.author}
                        </span>
                        <Bar value={entry.commits} max={file.git?.authorCounts[0]?.commits ?? 1} height={5} />
                        <span className="num w-8 shrink-0 text-right text-graphite-400">{entry.commits}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-graphite-400">
              No Git history for this file in the selected window. That is reported as missing data, not as zero
              activity - the change-frequency component is dropped and its weight redistributed.
            </p>
          )}
        </Section>

        <Section title={`Dependencies (${edges.dependsOn.length}) and dependents (${edges.usedBy.length})`}>
          {edges.dependsOn.length === 0 && edges.usedBy.length === 0 ? (
            <p className="text-xs text-graphite-400">No resolved intra-repository edges for this file.</p>
          ) : (
            <div className="grid gap-3">
              <PathList label="Depends on" paths={edges.dependsOn} onSelect={select} />
              <PathList label="Used by" paths={edges.usedBy} onSelect={select} />
            </div>
          )}
          {unresolved.length > 0 ? (
            <div className="mt-3">
              <p className="label mb-1">Unresolved or external specifiers</p>
              <ul className="flex flex-wrap gap-1">
                {unresolved.slice(0, 24).map((edge, index) => (
                  <li key={`${edge.raw}-${index}`}>
                    <Tag tone={edge.confidence === 'external' ? 'default' : 'warn'}>
                      {edge.raw}
                      {edge.confidence === 'external' ? ' · external' : ' · unresolved'}
                    </Tag>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>

        <Section title="Source preview">
          {previewLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : preview === null ? (
            <p className="text-xs text-graphite-400">No preview loaded.</p>
          ) : preview.ok ? (
            <>
              {preview.note ? <p className="mb-1.5 text-2xs text-attention-high">{preview.note}</p> : null}
              <pre className="max-h-80 overflow-auto rounded border border-graphite-700 bg-graphite-950 p-2 text-2xs leading-relaxed text-graphite-200">
                <code>{preview.content}</code>
              </pre>
            </>
          ) : (
            <p className="text-xs text-graphite-400">{preview.message}</p>
          )}
          <p className="mt-2 text-2xs text-graphite-500">
            Read-only preview. Riftmap never executes, imports or evaluates code found in scanned repositories.
          </p>
        </Section>
      </div>
    </Panel>
  );
}

function ScoreBreakdown({ file }: { file: AnalyzedFile }): JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="label">Score breakdown</p>
        <p className="text-2xs text-graphite-400">
          {ATTENTION_BAND_LABEL[file.score.band]} · {file.score.score.toFixed(1)} / 100
        </p>
      </div>
      <ul className="space-y-2">
        {file.score.components.map((component) => (
          <li key={component.key}>
            <div className="flex items-baseline justify-between gap-2 text-2xs">
              <span className="truncate text-graphite-200">{component.label}</span>
              <span className="num shrink-0 text-graphite-400">
                {component.available
                  ? `${(component.appliedWeight * 100).toFixed(0)}% weight · contributes ${component.contribution.toFixed(1)}`
                  : 'not available'}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Bar
                value={component.available ? component.contribution : 0}
                max={100}
                height={5}
                color={component.available ? BAND_COLOR[file.score.band] : '#3a4350'}
                title={`${component.label}: ${component.rawLabel}`}
              />
              <span className="num w-32 shrink-0 text-right text-2xs text-graphite-500">{component.rawLabel}</span>
            </div>
            {!component.available && component.unavailableReason ? (
              <p className="mt-0.5 text-2xs text-graphite-500">{component.unavailableReason}</p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-2xs leading-relaxed text-graphite-500">
        Each component is ranked against the other files in this repository (percentile, 0–100) and weighted. When a
        component cannot be measured its weight is redistributed proportionally across the remaining ones, so files
        with no Git history are never penalised for it. The score describes where attention has been going; it does
        not predict defects.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <p className="label mb-2">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="text-graphite-400">{label}</dt>
      <dd className="num text-right text-graphite-100">{value}</dd>
    </>
  );
}

function PathList({
  label,
  paths,
  onSelect,
}: {
  label: string;
  paths: string[];
  onSelect: (path: string) => void;
}): JSX.Element {
  if (paths.length === 0) {
    return (
      <div>
        <p className="label mb-1">{label}</p>
        <p className="text-2xs text-graphite-500">none</p>
      </div>
    );
  }
  return (
    <div>
      <p className="label mb-1">
        {label} <span className="text-graphite-500">({paths.length})</span>
      </p>
      <ul className="max-h-28 space-y-0.5 overflow-auto">
        {paths.slice(0, 50).map((path) => (
          <li key={path}>
            <button
              type="button"
              className={cx('block w-full truncate text-left font-mono text-2xs text-graphite-300 hover:text-accent')}
              onClick={() => onSelect(path)}
              title={path}
            >
              {path}
            </button>
          </li>
        ))}
      </ul>
      {paths.length > 50 ? <p className="mt-1 text-2xs text-graphite-500">+{paths.length - 50} more</p> : null}
    </div>
  );
}

export function formatWindowLabel(analysis: RepositoryAnalysis): string {
  const first = analysis.git.summary.oldestCommit;
  const last = analysis.git.summary.newestCommit;
  if (first === null || last === null) return 'no commits';
  return `${formatDate(first)} → ${formatDate(last)}`;
}
