/** Small presentational primitives shared by every view. */

import type { ReactNode } from 'react';
import type { AttentionBand } from '@riftmap/shared';
import { ATTENTION_BAND_LABEL } from '@riftmap/shared';

export const BAND_COLOR: Record<AttentionBand, string> = {
  high: '#f59e0b',
  moderate: '#22d3ee',
  lower: '#55606f',
};

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function ScoreBadge({ score, band }: { score: number; band: AttentionBand }): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-2xs font-semibold tabular-nums"
      style={{
        borderColor: `${BAND_COLOR[band]}66`,
        backgroundColor: `${BAND_COLOR[band]}1a`,
        color: BAND_COLOR[band],
      }}
      title={`Attention score ${score.toFixed(0)} / 100 — ${ATTENTION_BAND_LABEL[band]}`}
    >
      {score.toFixed(0)}
    </span>
  );
}

export function BandPill({ band }: { band: AttentionBand }): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium"
      style={{ backgroundColor: `${BAND_COLOR[band]}1f`, color: BAND_COLOR[band] }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: BAND_COLOR[band] }} />
      {ATTENTION_BAND_LABEL[band]}
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'accent' | 'warn';
  title?: string;
}): JSX.Element {
  const valueClass =
    tone === 'accent' ? 'text-accent' : tone === 'warn' ? 'text-attention-high' : 'text-graphite-100';
  return (
    <div className="panel px-4 py-3" title={title}>
      <div className="stat-label">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-2xs text-graphite-400">{sub}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  note,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}): JSX.Element {
  return (
    <section className={cx('panel flex min-h-0 flex-col', className)}>
      {title ? (
        <header className="panel-header">
          <div className="min-w-0">
            <h2 className="panel-title truncate">{title}</h2>
            {note ? <p className="panel-note mt-0.5">{note}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('min-h-0 flex-1', bodyClassName ?? 'p-4')}>{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}): JSX.Element {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-1 py-6' : 'gap-2 py-12',
      )}
    >
      <p className="text-sm font-medium text-graphite-200">{title}</p>
      {description ? <p className="max-w-md text-xs leading-relaxed text-graphite-400">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  hint,
  details,
  action,
}: {
  title: string;
  message: string;
  hint?: string;
  details?: string | null;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="panel border-attention-high/40 bg-attention-high/5 p-4">
      <p className="text-sm font-semibold text-attention-high">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-graphite-200">{message}</p>
      {hint ? <p className="mt-2 text-2xs text-graphite-300">{hint}</p> : null}
      {details ? (
        <pre className="mt-3 max-h-40 overflow-auto rounded border border-graphite-700 bg-graphite-950 p-2 text-2xs leading-relaxed text-graphite-300">
          {details}
        </pre>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <div className={cx('skeleton', className)} />;
}

export function SkeletonGrid({ rows = 4, cols = 4 }: { rows?: number; cols?: number }): JSX.Element {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {Array.from({ length: rows * cols }, (_, index) => (
        <Skeleton key={index} className="h-16" />
      ))}
    </div>
  );
}

export function Bar({
  value,
  max,
  color = '#22d3ee',
  height = 6,
  title,
}: {
  value: number;
  max: number;
  color?: string;
  height?: number;
  title?: string;
}): JSX.Element {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className="w-full overflow-hidden rounded-full bg-graphite-750"
      style={{ height }}
      title={title}
      role="presentation"
    >
      <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color }} />
    </div>
  );
}

export function Tag({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'accent' | 'warn' }): JSX.Element {
  const cls =
    tone === 'accent'
      ? 'border-accent-dim/60 text-accent'
      : tone === 'warn'
        ? 'border-attention-high/50 text-attention-high'
        : 'border-graphite-700 text-graphite-300';
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-2xs ${cls}`}>{children}</span>;
}
