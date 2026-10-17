/** Shared filter controls for the hotspot, treemap and file views. */

import { useMemo } from 'react';
import { ATTENTION_BAND_LABEL } from '@riftmap/shared';
import type { AnalyzedFile, AttentionBand } from '@riftmap/shared';
import { useApp } from '../state/store.js';
import { cx } from './primitives.js';

export const TOP_LEVEL_DIRECTORY_LIMIT = 400;

export function useFilteredFiles(files: readonly AnalyzedFile[]): AnalyzedFile[] {
  const { filters } = useApp();
  return useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    return files.filter((file) => {
      if (filters.language !== 'all' && file.language !== filters.language) return false;
      if (filters.directory !== 'all') {
        const dir = file.dir === '' ? '.' : file.dir;
        if (!(dir === filters.directory || dir.startsWith(`${filters.directory}/`))) return false;
      }
      if (filters.band !== 'all' && file.score.band !== filters.band) return false;
      if (filters.minChanges > 0 && (file.git?.changeCount ?? 0) < filters.minChanges) return false;
      if (needle && !file.path.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [files, filters]);
}

export function useDirectoryOptions(files: readonly AnalyzedFile[]): string[] {
  return useMemo(() => {
    const set = new Set<string>();
    for (const file of files) set.add(file.dir === '' ? '.' : file.dir);
    return [...set].sort().slice(0, TOP_LEVEL_DIRECTORY_LIMIT);
  }, [files]);
}

export function FilterBar({
  files,
  showBand = true,
  showMinChanges = true,
  showDirectory = true,
  extra,
}: {
  files: readonly AnalyzedFile[];
  showBand?: boolean;
  showMinChanges?: boolean;
  showDirectory?: boolean;
  extra?: React.ReactNode;
}): JSX.Element {
  const { filters, setFilters, resetFilters, analysis } = useApp();
  const directories = useDirectoryOptions(files);
  const languages = analysis?.languages ?? [];

  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-graphite-800 bg-graphite-900/60 px-4 py-2.5">
      <div className="min-w-[12rem] flex-1">
        <label className="label" htmlFor="filter-search">
          Search path
        </label>
        <input
          id="filter-search"
          type="search"
          className="input mt-1"
          placeholder="src/components/…"
          value={filters.search}
          onChange={(event) => setFilters({ search: event.target.value })}
        />
      </div>

      <div>
        <label className="label" htmlFor="filter-language">
          Language
        </label>
        <select
          id="filter-language"
          className="input mt-1 w-40"
          value={filters.language}
          onChange={(event) => setFilters({ language: event.target.value })}
        >
          <option value="all">All languages</option>
          {languages.map((language) => (
            <option key={language.id} value={language.id}>
              {language.name}
            </option>
          ))}
        </select>
      </div>

      {showDirectory ? (
        <div>
          <label className="label" htmlFor="filter-dir">
            Directory
          </label>
          <select
            id="filter-dir"
            className="input mt-1 w-48"
            value={filters.directory}
            onChange={(event) => setFilters({ directory: event.target.value })}
          >
            <option value="all">All directories</option>
            {directories.map((directory) => (
              <option key={directory} value={directory}>
                {directory}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {showBand ? (
        <div>
          <label className="label" htmlFor="filter-band">
            Attention band
          </label>
          <select
            id="filter-band"
            className="input mt-1 w-40"
            value={filters.band}
            onChange={(event) => setFilters({ band: event.target.value as 'all' | AttentionBand })}
          >
            <option value="all">All bands</option>
            {(Object.keys(ATTENTION_BAND_LABEL) as AttentionBand[]).map((band) => (
              <option key={band} value={band}>
                {ATTENTION_BAND_LABEL[band]}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {showMinChanges ? (
        <div>
          <label className="label" htmlFor="filter-changes">
            Min changes
          </label>
          <input
            id="filter-changes"
            type="number"
            min={0}
            className="input mt-1 w-24"
            value={filters.minChanges}
            onChange={(event) => setFilters({ minChanges: Math.max(0, Number(event.target.value) || 0) })}
          />
        </div>
      ) : null}

      {extra}

      <button type="button" className="btn btn-ghost" onClick={resetFilters}>
        Reset
      </button>
    </div>
  );
}

export function Toggle({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: string; label: string; hint?: string }>;
  value: string;
  onChange: (value: string) => void;
  label: string;
}): JSX.Element {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-graphite-700" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.hint}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cx(
            'px-2.5 py-1 text-2xs font-medium transition-colors',
            value === option.value
              ? 'bg-accent-dim/30 text-accent-strong'
              : 'bg-graphite-800 text-graphite-400 hover:bg-graphite-750 hover:text-graphite-200',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
