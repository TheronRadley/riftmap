/** Overview dashboard: real aggregate metrics, plus an explicit coverage report. */

import { useMemo } from 'react';
import { formatBytes, formatCount, formatDate, formatDuration, formatPercent } from '@riftmap/shared';
import { useApp } from '../state/store.js';
import { BandPill, Bar, EmptyState, Panel, ScoreBadge, StatCard, Tag } from '../components/primitives.js';

export function OverviewView(): JSX.Element {
  const { analysis, select, setView, appInfo } = useApp();

  const top = useMemo(
    () => (analysis ? [...analysis.files].sort((a, b) => b.score.score - a.score.score).slice(0, 10) : []),
    [analysis],
  );

  const languageRows = useMemo(() => {
    if (!analysis) return [];
    const max = Math.max(1, ...analysis.languages.map((language) => language.bytes));
    return [...analysis.languages].sort((a, b) => b.bytes - a.bytes).map((language) => ({ language, max }));
  }, [analysis]);

  if (!analysis) {
    return (
      <div className="p-6">
        <EmptyState title="No repository analysed yet" description="Open a folder to see its structure and activity." />
      </div>
    );
  }

  const { summary, coverage, git } = analysis;
  const windowLabel = analysis.historyWindowDays === 'all' ? 'all retrieved history' : `last ${analysis.historyWindowDays} days`;

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:col-span-2 xl:grid-cols-3">
        <StatCard label="Files scanned" value={formatCount(summary.fileCount)} sub={`${formatCount(summary.directoryCount)} directories`} />
        <StatCard
          label="Code lines"
          value={formatCount(summary.codeLines)}
          sub={`${formatCount(summary.commentLines)} comment · ${formatCount(summary.blankLines)} blank`}
          tone="accent"
        />
        <StatCard label="Source size" value={formatBytes(summary.totalBytes)} sub={`${formatCount(summary.totalLines)} physical lines`} />
        <StatCard
          label="Commits"
          value={formatCount(git.summary.commitsInWindow)}
          sub={`${windowLabel} · ${formatCount(git.summary.commitsRetrieved)} retrieved`}
        />
        <StatCard
          label="Contributors"
          value={formatCount(git.summary.contributorsInWindow)}
          sub={
            git.summary.oldestCommit
              ? `${formatDate(git.summary.oldestCommit)} → ${formatDate(git.summary.newestCommit)}`
              : 'no commits in window'
          }
        />
        <StatCard
          label="Resolved dependencies"
          value={formatCount(summary.resolvedEdgeCount)}
          sub={`${formatCount(summary.unresolvedEdgeCount)} unresolved · ${formatCount(summary.externalEdgeCount)} external`}
          tone="accent"
        />
      </div>

      <CoveragePanel />

      <Panel
        title="Highest attention"
        note="Top 10 by attention score in the selected window"
        className="xl:col-span-2"
        bodyClassName="overflow-auto"
        actions={
          <button type="button" className="btn btn-ghost" onClick={() => setView('hotspots')}>
            Open Hotspots →
          </button>
        }
      >
        <table className="w-full">
          <thead>
            <tr>
              <th className="th w-10">Score</th>
              <th className="th">File</th>
              <th className="th w-20">Band</th>
              <th className="th w-16 text-right">Changes</th>
              <th className="th w-16 text-right">Complexity</th>
              <th className="th w-20 text-right">Size</th>
            </tr>
          </thead>
          <tbody>
            {top.map((file) => (
              <tr
                key={file.path}
                className="cursor-pointer hover:bg-graphite-800"
                onClick={() => {
                  select(file.path);
                  setView('hotspots');
                }}
              >
                <td className="td">
                  <ScoreBadge score={file.score.score} band={file.score.band} />
                </td>
                <td className="td font-mono text-2xs" title={file.path}>
                  {file.path}
                </td>
                <td className="td">
                  <BandPill band={file.score.band} />
                </td>
                <td className="td num text-right">{file.git ? formatCount(file.git.changeCount) : '—'}</td>
                <td className="td num text-right">{file.cyclomatic === null ? '—' : formatCount(file.cyclomatic)}</td>
                <td className="td num text-right">{formatBytes(file.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {top.length === 0 ? <p className="p-4 text-xs text-graphite-400">No files with measurable metrics.</p> : null}
      </Panel>

      <Panel title="Languages" note="Share of scanned source bytes">
        <ul className="space-y-2">
          {languageRows.map(({ language, max }) => (
            <li key={language.id}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-graphite-200">
                  {language.name}
                  {!language.complexitySupported ? (
                    <span className="ml-1.5 text-2xs text-graphite-500">no complexity</span>
                  ) : null}
                </span>
                <span className="num shrink-0 text-graphite-400">
                  {formatCount(language.fileCount)} files · {formatBytes(language.bytes)}
                </span>
              </div>
              <div className="mt-1">
                <Bar value={language.bytes} max={max} height={6} />
              </div>
            </li>
          ))}
          {languageRows.length === 0 ? <li className="text-xs text-graphite-400">No recognised source files.</li> : null}
        </ul>
      </Panel>

      <Panel title="Git status" note="Read-only; Riftmap never writes to a repository" className="xl:col-span-1">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-graphite-400">Repository</dt>
          <dd className="text-right text-graphite-100">{git.isGitRepo ? 'yes' : 'no'}</dd>
          <dt className="text-graphite-400">Total commits</dt>
          <dd className="num text-right text-graphite-100">{git.commitCount === null ? 'none' : formatCount(git.commitCount)}</dd>
          <dt className="text-graphite-400">Shallow clone</dt>
          <dd className="text-right">{git.isShallow ? <Tag tone="warn">yes — history truncated</Tag> : 'no'}</dd>
          <dt className="text-graphite-400">Uncommitted changes</dt>
          <dd className="num text-right text-graphite-100">
            {git.hasUncommittedChanges ? `${formatCount(git.uncommittedFileCount)} files` : 'clean'}
          </dd>
          <dt className="text-graphite-400">HEAD</dt>
          <dd className="truncate text-right font-mono text-2xs text-graphite-300" title={git.headCommit ?? ''}>
            {git.headCommit ? git.headCommit.slice(0, 10) : 'none'}
          </dd>
          <dt className="text-graphite-400">History truncated</dt>
          <dd className="text-right text-graphite-100">{git.truncated ? <Tag tone="warn">safety limit</Tag> : 'no'}</dd>
        </dl>
        {!git.isGitRepo && git.error ? (
          <p className="mt-3 text-2xs leading-relaxed text-attention-high">{git.error}</p>
        ) : null}
        {git.root && git.root !== analysis.repository.path ? (
          <p className="mt-3 text-2xs text-graphite-500">Git root: {git.root}</p>
        ) : null}
      </Panel>

      <Panel
        title={`Scan notes (${analysis.warnings.length})`}
        note="Files and directories that could not be measured"
        className="xl:col-span-2"
        bodyClassName="overflow-auto"
      >
        {analysis.warnings.length === 0 ? (
          <p className="text-xs text-graphite-400">No warnings: every scanned file was read successfully.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th w-44">Code</th>
                <th className="th w-1/2">Path</th>
                <th className="th">Detail</th>
              </tr>
            </thead>
            <tbody>
              {analysis.warnings.slice(0, 300).map((warning, index) => (
                <tr key={`${warning.code}-${warning.path ?? index}`}>
                  <td className="td">
                    <Tag tone="warn">{warning.code}</Tag>
                  </td>
                  <td className="td font-mono text-2xs" title={warning.path ?? ''}>
                    {warning.path ?? '—'}
                  </td>
                  <td className="td whitespace-normal text-graphite-400">{warning.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {analysis.warnings.length > 300 ? (
          <p className="mt-2 text-2xs text-graphite-500">+{analysis.warnings.length - 300} more (capped at 300 shown)</p>
        ) : null}
      </Panel>

      <Panel title="Engine" note="Native scanner (Zig)" className="xl:col-span-1">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-graphite-400">Version</dt>
          <dd className="text-right text-graphite-100">{analysis.engine.version}</dd>
          <dt className="text-graphite-400">Zig</dt>
          <dd className="text-right text-graphite-100">{analysis.engine.zigVersion}</dd>
          <dt className="text-graphite-400">Build</dt>
          <dd className="text-right text-graphite-100">{analysis.engine.buildMode}</dd>
          <dt className="text-graphite-400">Scan time</dt>
          <dd className="num text-right text-graphite-100">{formatDuration(analysis.engine.elapsedMs)}</dd>
          <dt className="text-graphite-400">Total time</dt>
          <dd className="num text-right text-graphite-100">{formatDuration(analysis.repository.durationMs)}</dd>
          <dt className="text-graphite-400">Import languages</dt>
          <dd className="text-right text-graphite-100">
            {analysis.engine.limitations.importLanguages.join(', ')}
          </dd>
        </dl>
        {appInfo?.engine?.path ? (
          <p className="mt-3 truncate text-2xs text-graphite-500" title={appInfo.engine.path}>
            {appInfo.engine.path}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

function CoveragePanel(): JSX.Element | null {
  const { analysis } = useApp();
  if (!analysis) return null;
  const { coverage } = analysis;
  return (
    <Panel
      title="Data coverage"
      note="How much of this repository Riftmap was actually able to measure"
      className="row-span-2"
      bodyClassName="overflow-auto"
    >
      <div className="space-y-3">
        <CoverageBar label="Complexity measured" value={coverage.complexityCoveragePct} detail={`${formatCount(coverage.filesWithComplexity)} / ${formatCount(coverage.filesTotal)} files`} />
        <CoverageBar label="Git history matched" value={coverage.gitCoveragePct} detail={`${formatCount(coverage.filesWithGitHistory)} / ${formatCount(coverage.filesTotal)} files`} />
        <ul className="space-y-1 text-2xs text-graphite-400">
          {coverage.notes.map((note) => (
            <li key={note} className="flex gap-1.5">
              <span className="text-graphite-600">·</span>
              <span className="leading-relaxed">{note}</span>
            </li>
          ))}
        </ul>
        {coverage.languagesWithoutComplexity.length > 0 ? (
          <p className="text-2xs text-graphite-500">
            No complexity for: {coverage.languagesWithoutComplexity.join(', ')}.
          </p>
        ) : null}
        <p className="text-2xs leading-relaxed text-graphite-500">
          Coverage gaps are shown rather than filled in. Files without history or without complexity are scored on
          the metrics that do exist, and their attention bands reflect that reduced evidence.
        </p>
      </div>
    </Panel>
  );
}

function CoverageBar({ label, value, detail }: { label: string; value: number; detail: string }): JSX.Element {
  const color = value >= 90 ? '#22d3ee' : value >= 50 ? '#67e8f9' : '#f59e0b';
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-graphite-200">{label}</span>
        <span className="num text-2xs text-graphite-400">
          {formatPercent(value / 100)} · {detail}
        </span>
      </div>
      <div className="mt-1">
        <Bar value={value} max={100} height={7} color={color} />
      </div>
    </div>
  );
}
