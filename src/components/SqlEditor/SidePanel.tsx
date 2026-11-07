import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Search, Trash, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { clearHistory, listHistory, onHistoryChanged, type HistoryEntry } from '@/lib/queryHistory';
import { AuditLogView } from './AuditLogView';

export interface SavedScript {
  name: string;
  sql: string;
}

function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface SidePanelProps {
  tab: 'history' | 'saved' | 'audit';
  onTabChange: (tab: 'history' | 'saved' | 'audit') => void;
  onClose: () => void;
  connectionId: string;
  onOpen: (sql: string) => void;
  savedScripts: SavedScript[];
  onDeleteScript: (name: string) => void;
}

export function SidePanel({ tab, onTabChange, onClose, connectionId, onOpen, savedScripts, onDeleteScript }: SidePanelProps) {
  const [history, setHistory] = useState<HistoryEntry[]>(() => listHistory());
  const [query, setQuery] = useState('');
  const [allConnections, setAllConnections] = useState(false);

  useEffect(() => onHistoryChanged(() => setHistory(listHistory())), []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter((h) => (allConnections || h.connectionId === connectionId) && (!q || h.sql.toLowerCase().includes(q)));
  }, [history, query, allConnections, connectionId]);

  const scripts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return savedScripts.filter((s) => !q || s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q));
  }, [savedScripts, query]);

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l bg-background">
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as SidePanelProps['tab'])} className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 items-center gap-2 border-b px-2">
          <TabsList className="h-7">
            <TabsTrigger value="history" className="h-6 text-xs">History</TabsTrigger>
            <TabsTrigger value="saved" className="h-6 text-xs">Saved</TabsTrigger>
            <TabsTrigger value="audit" className="h-6 text-xs">Audit</TabsTrigger>
          </TabsList>
          <Button variant="ghost" size="icon" className="ml-auto h-6 w-6" onClick={onClose} aria-label="Close panel">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {tab !== 'audit' && (
          <div className="border-b p-2">
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === 'history' ? 'Search history' : 'Search saved scripts'} className="h-7 pl-7 text-xs" />
            </div>
          </div>
        )}
        <TabsContent value="history" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-muted-foreground">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={allConnections} onChange={(e) => setAllConnections(e.target.checked)} />
              All connections
            </label>
            {visible.length > 0 && (
              <button type="button" className="hover:text-foreground" onClick={() => clearHistory(allConnections ? undefined : connectionId)}>
                Clear
              </button>
            )}
          </div>
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">Queries you run appear here.</p>
          ) : (
            <ul className="divide-y">
              {visible.map((entry) => (
                <li key={entry.id}>
                  <button type="button" onClick={() => onOpen(entry.sql)} className="block w-full px-3 py-2 text-left hover:bg-muted/50" title="Open in the editor">
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {entry.ok ? <CheckCircle2 className="h-3 w-3 text-positive" /> : <AlertCircle className="h-3 w-3 text-destructive" />}
                      <span>{when(entry.at)}</span>
                      <span className="tabular-nums">{entry.durationMs} ms</span>
                      {entry.rows !== null && <span className="tabular-nums">· {entry.rows.toLocaleString()} rows</span>}
                      {allConnections && <span className="truncate">· {entry.connectionName}</span>}
                    </div>
                    <pre className={cn('mt-1 line-clamp-3 whitespace-pre-wrap break-all font-mono text-[11px]', !entry.ok && 'text-destructive/90')}>{entry.sql}</pre>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="saved" className="m-0 min-h-0 flex-1 overflow-y-auto">
          {scripts.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">Save a script from the toolbar to keep it here.</p>
          ) : (
            <ul className="divide-y">
              {scripts.map((script) => (
                <li key={script.name} className="group flex items-start gap-2 px-3 py-2 hover:bg-muted/50">
                  <button type="button" onClick={() => onOpen(script.sql)} className="min-w-0 flex-1 text-left">
                    <div className="truncate text-xs font-medium">{script.name}</div>
                    <pre className="mt-1 line-clamp-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{script.sql}</pre>
                  </button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => onDeleteScript(script.name)} aria-label={`Delete ${script.name}`}>
                    <Trash className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="audit" className="m-0 min-h-0 flex-1 overflow-hidden p-2">
          <AuditLogView />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
