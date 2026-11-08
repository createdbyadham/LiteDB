import type { ReactNode } from 'react';
import { cellText } from '@/lib/db/sqlLiteral';

/** How a grid cell shows a value when the caller has no renderer of its own. */
export function defaultCell(value: unknown): ReactNode {
  if (value === null || value === undefined) return <span className="text-muted-foreground/70 italic">NULL</span>;
  if (value instanceof Uint8Array) {
    return <span className="text-muted-foreground">{value.length.toLocaleString()} bytes</span>;
  }
  if (typeof value === 'boolean') return <span className="font-mono">{value ? 'true' : 'false'}</span>;
  const text = cellText(value);
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}
