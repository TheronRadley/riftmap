/**
 * Change history.
 *
 * Commits over time, churn over time, top contributors and most-changed files,
 * all computed from the retrieved commit list for the selected window. When the
 * repository is shallow, has no history, or Git is unavailable, the view says
 * exactly that instead of drawing an empty chart.
 */

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCount, formatDate, formatPercent } from '@riftmap/shared';
import { useApp } from '../state/store.js';
import { Bar as MiniBar, EmptyState, ErrorState, Panel, ScoreBadge, StatCard, Tag, cx } from '../components/primitives.js';
import { WindowSelector } from '../components/TopBar.js';
import { FilterBar, useFilteredFiles } from '../components/FilterBar.js';
import { DetailsPanel } from '../components/DetailsPanel.js';

const AXIS = { stroke: '#55606f', fontSize: 10 };
const TOOLTIP_STYLE = {
  backgroundColor: '#12151a',
  border: '1px solid #2a313a',
  borderRadius: 6,
  fontSize: 11,
  color: '#e7ebf1',
};

interface Bucket {
  label: string;
  commits: number;
  insertions: number;
  deletions: number;
  files: number;
}

export function HistoryView(): JSX.Element {
  const { analysis, selectedPath, select } = useApp();
  const files = analysis?.files ?? [];
  const filtered = useFilteredFiles(files);

  const buckets = useMemo<Bucket[]>(() => {
    if (!analysis) return [];
    const commits = analysis.commits;
    if (commits.length === 0) return [];

    const times = commits.map((commit) => commit.authorDate).sort((a, b) => a - b);
    const span = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
    const day = 86_400_000;
    // Aim for ~40 buckets, snapped to a whole number of days.
    const target = 40;
    const rawStep = Math.max(day, Math.ceil(span / target / day) * day);

    const first = times[0] ?? 0;
    const last = times[times.length - 1] ?? first + day;
    const count = Math.max(1, Math.ceil((last - first + 1) / rawStep));

    const list: Bucket[] = Array.from({ length: count }, (_, index) => ({
      label: formatDate(first + index * rawStep),
      commits: 0,
      insertions: 0,
      deletions: 0,
      files: 0,
    }));

    for (const commit of commits) {
      const index = Math.min(count - 1, Math.max(0, Math.floor((commit.authorDate - first) / rawStep)));
      const bucket = list[index];
      if (!bucket) continue;
      bucket.commits += 1;
      for (const file of commit.files) {
        bucket.insertions += file.added;
        bucket.deletions += file.deleted;
        bucket.files += 1;
      }
    }
    return list;
  }, [analysis]);

  const contributors = useMemo(() => {
    if (!analysis) return [];
    const counts = new Map<string, { author: string; commits: number; insertions: number; deletions: number }>();
    for (const commit of analysis.commits) {
      const author = `${commit.authorName} <${commit.authorEmail}>`;
      const entry = counts.get(author) ?? { author, commits: 0, insertions: 0, deletions: 0 };
      entry.commits += 1;
      for (const file of commit.files) {
        entry.insertions += file.added;
        entry.deletions += file.deleted;
      }
      counts.set(author, entry);
    }
    return [...counts.values()].sort((a, b) => b.commits - a.commits).slice(0, 20);
  }, [analysis]);

  const mostChanged = useMemo(
    () =>
      [...filtered]
        .filter((file) => file.git !== null)
        .sort((a, b) => (b.git?.changeCount ?? 0) - (a.git?.changeCount ?? 0))
        .slice(0, 25),
    [filtered],
  );

  const selected = useMemo(
    () => (analysis ? (analysis.files.find((file) => file.path === selectedPath) ?? null) : null),
    [analysis, selectedPath],
  );

  if (!analysis) {
    return (
      <div className="p-6">
        <EmptyState title="No repository analysed yet" description="Open a folder to see its change history." />
      </div>
    );
  }

  const git = analysis.git;
  const hasHistory = analysis.commits.length > 0;

  return (
    <div className="flex min-h-0 flex-col">
      <FilterBar files={files} showBand={false} showMinChanges={false} extra={<div className="ml-auto" />} />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {!git.isGitRepo ? (
          <ErrorState
            title="No Git history available"
            message={git.error ?? 'This folder is not a Git repository.'}
            hint="Source metrics on the other tabs are unaffected: they come from the native scanner, not from Git."
          />
        ) : null}

        {git.isGitRepo && !hasHistory ? (
          <ErrorState
            title="No commits found"
            message={
              git.commitCount === null
                ? 'This repository has no commits yet, so there is no change history to show.'
                : `No commits fall inside the selected window. The repository has ${formatCount(git.commitCount)} commits in total - try "All".`
            }
            hint="Riftmap never invents history. Switch the window in the top right to widen it."
          />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Commits in window" value={formatCount(git.summary.commitsInWindow)} sub={`${formatCount(git.summary.commitsRetrieved)} retrieved`} />
          <StatCard label="Files changed" value={formatCount(git.summary.filesChangedInWindow)} sub="within the window" />
          <StatCard label="Insertions" value={formatCount(git.summary.insertionsInWindow)} tone="accent" />
          <StatCard label="Deletions" value={formatCount(git.summary.deletionsInWindow)} />
          <StatCard label="Contributors" value={formatCount(git.summary.contributorsInWindow)} sub="distinct author identities" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {git.isShallow ? <Tag tone="warn">shallow clone — history is truncated upstream</Tag> : null}
          {git.truncated ? <Tag tone="warn">commit history hit the retrieval safety limit</Tag> : null}
          {git.hasUncommittedChanges ? (
            <Tag tone="warn">{formatCount(git.uncommittedFileCount)} uncommitted files</Tag>
          ) : (
            <Tag>working tree clean</Tag>
          )}
          <Tag>read-only analysis</Tag>
          <div className="ml-auto">
            <WindowSelector />
          </div>
        </div>

        {hasHistory ? (
          <>
            <Panel title="Commit activity over time" note="Commits per interval inside the selected window" className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={buckets} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                  <CartesianGrid stroke="#22282f" vertical={false} />
                  <XAxis dataKey="label" tick={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: '#1c2128' }} />
                  <Bar dataKey="commits" name="Commits" fill="#22d3ee" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            <Panel title="Churn over time" note="Lines added and removed per interval" className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={buckets} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                  <CartesianGrid stroke="#22282f" vertical={false} />
                  <XAxis dataKey="label" tick={AXIS} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#a6b0c0' }} />
                  <Line type="monotone" dataKey="insertions" name="Insertions" stroke="#22d3ee" strokeWidth={1.6} dot={false} />
                  <Line type="monotone" dataKey="deletions" name="Deletions" stroke="#f59e0b" strokeWidth={1.6} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>

            <div className="grid gap-4 xl:grid-cols-2">
              <Panel title="Contributors" note="Distinct name/e-mail identities in the window" bodyClassName="overflow-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th">Author</th>
                      <th className="th w-20 text-right">Commits</th>
                      <th className="th w-24 text-right">+ / −</th>
                      <th className="th w-24">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contributors.map((entry) => (
                      <tr key={entry.author}>
                        <td className="td max-w-[16rem] truncate" title={entry.author}>
                          {entry.author}
                        </td>
                        <td className="td num text-right">{formatCount(entry.commits)}</td>
                        <td className="td num text-right">
                          <span className="text-accent">+{formatCount(entry.insertions)}</span>{' '}
                          <span className="text-attention-high">−{formatCount(entry.deletions)}</span>
                        </td>
                        <td className="td">
                          <MiniBar
                            value={entry.commits}
                            max={contributors[0]?.commits ?? 1}
                            height={5}
                            title={formatPercent(entry.commits / Math.max(1, analysis.git.summary.commitsInWindow))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>

              <Panel title="Most changed files" note="Commits touching each file inside the window" bodyClassName="overflow-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th">File</th>
                      <th className="th w-16 text-right">Commits</th>
                      <th className="th w-16 text-right">Churn</th>
                      <th className="th w-20 text-right">Attention</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mostChanged.map((file) => (
                      <tr
                        key={file.path}
                        className={cx('cursor-pointer hover:bg-graphite-800', file.path === selectedPath && 'bg-graphite-800')}
                        onClick={() => select(file.path)}
                      >
                        <td className="td font-mono text-2xs" title={file.path}>
                          {file.path}
                        </td>
                        <td className="td num text-right">{formatCount(file.git?.changeCount ?? 0)}</td>
                        <td className="td num text-right">{formatCount(file.git?.churn ?? 0)}</td>
                        <td className="td text-right">
                          <ScoreBadge score={file.score.score} band={file.score.band} />
                        </td>
                      </tr>
                    ))}
                    {mostChanged.length === 0 ? (
                      <tr>
                        <td className="td text-graphite-400" colSpan={4}>
                          No files with commits in this window.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </Panel>
            </div>

            <Panel title="Recent commits" note="Newest first, as returned by git log" bodyClassName="overflow-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th w-24">Hash</th>
                    <th className="th w-32">Date</th>
                    <th className="th w-48">Author</th>
                    <th className="th">Subject</th>
                    <th className="th w-32 text-right">Files · +/−</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.commits.slice(0, 200).map((commit) => {
                    const added = commit.files.reduce((acc, file) => acc + file.added, 0);
                    const deleted = commit.files.reduce((acc, file) => acc + file.deleted, 0);
                    return (
                      <tr key={commit.hash}>
                        <td className="td font-mono text-2xs text-graphite-400">{commit.hash.slice(0, 8)}</td>
                        <td className="td num">{formatDate(commit.authorDate)}</td>
                        <td className="td truncate" title={`${commit.authorName} <${commit.authorEmail}>`}>
                          {commit.authorName}
                        </td>
                        <td className="td whitespace-normal">{commit.subject}</td>
                        <td className="td num text-right">
                          {formatCount(commit.files.length)} ·{' '}
                          <span className="text-accent">+{formatCount(added)}</span>{' '}
                          <span className="text-attention-high">−{formatCount(deleted)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {analysis.commits.length > 200 ? (
                <p className="p-3 text-2xs text-graphite-500">
                  Showing the newest 200 of {formatCount(analysis.commits.length)} retrieved commits.
                </p>
              ) : null}
            </Panel>
          </>
        ) : null}

        <div className="xl:col-span-2">
          <DetailsPanel file={selected} analysis={analysis} />
        </div>
      </div>
    </div>
  );
}
