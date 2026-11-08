import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SQLNamespace } from '@codemirror/lang-sql';
import {
  Lightbulb,
  ListChecks,
  PanelRight,
  Play,
  Plus,
  Save,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { mascot } from '@/lib/mascot';
import { aiService } from '@/lib/aiService';
import { tauriService } from '@/lib/tauri';
import { csvRow, rowsToJson } from '@/lib/exportFormat';
import { buildXlsx } from '@/lib/xlsx';
import { evaluateScript, type GateDecision, type Provenance } from '@/lib/sqlPolicy';
import { previewImpact, type ImpactEstimate, type PreviewRunner } from '@/lib/impactPreview';
import { activePolicy, auditableStatements, isYolo, recordDecision, ReadOnlyConnectionError } from '@/lib/queryGate';
import { canValidate, validateScript } from '@/lib/sqlValidator';
import { classifyStatement } from '@/lib/sqlClassifier';
import type { AuditDecision, AuditOutcome } from '@/lib/auditLog';
import { placeAfterStatement, statementAt, statementRanges, type StatementRange } from '@/lib/sqlCursor';
import { completionName } from '@/lib/types';
import type { ColumnCatalog } from '@/lib/sqlComplete';
import { loadTabs, newTab, saveTabs, titleFromSql, type EditorTab, type EditorTabsState } from '@/lib/editorTabs';
import { addHistory } from '@/lib/queryHistory';
import { shortcutLabel, useAppCommand } from '@/lib/commands';
import { dbCancel, newQueryId, type RunError, type StatementResult } from '@/lib/db/native';
import { setInTransaction, visibleTables, type OpenConnection } from '@/lib/db/connections';
import { PgClient } from '@/lib/db/pgClient';
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import { ApprovalDialog } from './ApprovalDialog';
import { SqlCodeEditor, type SqlCodeEditorHandle } from './SqlCodeEditor';
import { AiQueryDialog } from './AiQueryDialog';
import { ResultPanel, type RunOutcome } from './ResultPanel';
import { ExplainPanel, type ExplainState } from './ExplainPanel';
import { FixDialog, type FixState } from './FixDialog';
import { SidePanel, type SavedScript } from './SidePanel';

interface SqlEditorProps {
  conn: OpenConnection;
  refreshTables?: () => Promise<void> | void;
  /**
   * Text to SQL asked for from elsewhere (Star, the palette): opens the AI bar
   * once, starting the prompt with `seed` when a table was dropped on Star.
   */
  requestAiDialog?: { seed?: string } | null;
  onAiDialogRequested?: () => void;
}

/**
 * Who wrote the script being run, and what they asked for. Carried with the
 * script rather than read from state, because YOLO runs a generated script in
 * the same tick it arrives, before React has flushed it into the editor.
 */
interface ScriptOrigin {
  provenance: Provenance;
  prompt: string | null;
  /** The script as written, so a failure can be explained or fixed. */
  script: string;
}

/** The last run that failed: what ran, what the database said, and where it sits in the editor. */
interface Failure {
  sql: string;
  error: string;
  range: StatementRange | null;
}

const ROW_LIMITS = [100, 500, 1000, 5000, 10000];
const LIMIT_KEY = 'editorRowLimit';
const SCRIPTS_KEY = 'savedScripts';

function readLimit(): number | null {
  try {
    const raw = localStorage.getItem(LIMIT_KEY);
    if (raw === 'none') return null;
    const n = Number(raw);
    return ROW_LIMITS.includes(n) ? n : 1000;
  } catch {
    return 1000;
  }
}

function readScripts(): SavedScript[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SCRIPTS_KEY) || '[]');
    return Array.isArray(parsed) ? (parsed as SavedScript[]) : [];
  } catch {
    return [];
  }
}

/** BEGIN, COMMIT and friends in the script: the user is managing the transaction. */
function managesTransaction(statements: string[]): boolean {
  return statements.some((s) => /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE)\b/i.test(s));
}

/** Rows as objects keyed by column, with repeated names kept apart. */
function resultObjects(result: StatementResult): { columns: string[]; rows: Record<string, unknown>[] } {
  const seen = new Map<string, number>();
  const columns = result.columns.map((c) => {
    const n = seen.get(c) ?? 0;
    seen.set(c, n + 1);
    return n === 0 ? c : `${c}_${n + 1}`;
  });
  return {
    columns,
    rows: result.rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]]))),
  };
}

function ToolbarButton({ label, shortcut, onClick, disabled, children, variant = 'ghost', iconOnly = false }: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: 'ghost' | 'default' | 'outline' | 'destructive';
  /** No visible text, so the tooltip's label is its name for screen readers. */
  iconOnly?: boolean;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Button variant={variant} size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={onClick} disabled={disabled} aria-label={iconOnly ? label : undefined}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
        {shortcut && <span className="ml-2 text-muted-foreground">{shortcutLabel(shortcut)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

const SqlEditor = ({ conn, refreshTables, requestAiDialog = null, onAiDialogRequested }: SqlEditorProps) => {
  const client = conn.client;
  const dialect = conn.dialect;
  const editorRef = useRef<SqlCodeEditorHandle>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // --- tabs ---------------------------------------------------------------------
  const [tabsState, setTabsState] = useState<EditorTabsState>(() => loadTabs(conn.id));
  const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeId) ?? tabsState.tabs[0];
  const [renaming, setRenaming] = useState<string | null>(null);

  const updateTabs = useCallback(
    (update: (state: EditorTabsState) => EditorTabsState) => {
      setTabsState((current) => {
        const next = update(current);
        saveTabs(conn.id, next);
        return next;
      });
    },
    [conn.id],
  );

  const patchActiveTab = useCallback(
    (changes: Partial<EditorTab>) =>
      updateTabs((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, ...changes } : t)) })),
    [updateTabs],
  );

  const addTab = useCallback(
    (sql = '') =>
      updateTabs((s) => {
        const tab = newTab(s.tabs.length + 1, sql);
        return { tabs: [...s.tabs, tab], activeId: tab.id };
      }),
    [updateTabs],
  );

  const closeTab = (id: string) =>
    updateTabs((s) => {
      if (s.tabs.length === 1) {
        const fresh = newTab(1);
        return { tabs: [fresh], activeId: fresh.id };
      }
      const index = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId = s.activeId === id ? tabs[Math.max(0, index - 1)].id : s.activeId;
      return { tabs, activeId };
    });

  // --- run state ----------------------------------------------------------------
  const [running, setRunning] = useState<{ queryId: string; startedAt: number } | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [useTransaction, setUseTransaction] = useState(true);
  const [rowLimit, setRowLimit] = useState<number | null>(readLimit);
  const [pendingDecision, setPendingDecision] = useState<GateDecision | null>(null);
  const [pendingOrigin, setPendingOrigin] = useState<ScriptOrigin | null>(null);
  const [pendingRanges, setPendingRanges] = useState<StatementRange[] | null>(null);
  const [previews, setPreviews] = useState<ImpactEstimate[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const previewGen = useRef(0);
  const lastRanges = useRef<StatementRange[] | null>(null);

  // --- AI state -------------------------------------------------------------------
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSeed, setAiSeed] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [fixState, setFixState] = useState<FixState | null>(null);
  const [explainState, setExplainState] = useState<ExplainState | null>(null);
  const [panel, setPanel] = useState<'history' | 'saved' | 'audit' | null>(null);
  const [savedScripts, setSavedScripts] = useState<SavedScript[]>(readScripts);
  const [saveOpen, setSaveOpen] = useState(false);
  const [scriptName, setScriptName] = useState('');
  const { policy } = useSafetyPolicy();

  const [editorFraction, setEditorFraction] = useState(0.5);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!requestAiDialog) return;
    setAiSeed(requestAiDialog.seed);
    setAiOpen(true);
    onAiDialogRequested?.();
  }, [requestAiDialog, onAiDialogRequested]);

  // --- schema for autocomplete ---------------------------------------------------
  const [columnsByTable, setColumnsByTable] = useState<Map<string, { name: string; type: string }[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void client
      .getAllColumns()
      .then((columns) => {
        if (!cancelled) setColumnsByTable(columns);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, conn.tables]);

  const pg = client instanceof PgClient ? client : null;
  const schema: SQLNamespace = useMemo(() => {
    // lang-sql inserts a completion object as its label, unquoted, so a column
    // that needs quotes (Postgres `createdAt`, SQLite `Unit Price`) says so.
    const completion = (c: { name: string; type: string }) => {
      const apply = completionName(c.name, dialect);
      return { label: c.name, type: 'property', detail: c.type, ...(apply !== c.name ? { apply } : {}) };
    };
    if (!pg) {
      const ns: Record<string, ReturnType<typeof completion>[]> = {};
      for (const table of conn.tables) ns[table.name] = (columnsByTable.get(table.name) ?? []).map(completion);
      return ns;
    }
    // Postgres: schema → table → columns, so `auth.` completes auth's tables.
    const ns: Record<string, Record<string, ReturnType<typeof completion>[]>> = {};
    for (const table of conn.tables) {
      const schemaName = table.schema ?? pg.defaultSchema;
      ns[schemaName] ??= {};
      ns[schemaName][table.table ?? table.name] = (columnsByTable.get(table.name) ?? []).map(completion);
    }
    return ns;
  }, [conn.tables, columnsByTable, pg, dialect]);

  // The same tables and columns, for column names without `table.` first.
  const catalog: ColumnCatalog = useMemo(
    () => ({
      dialect,
      defaultSchema: pg ? pg.defaultSchema : null,
      tables: conn.tables.map((table) => ({
        schema: pg ? (table.schema ?? pg.defaultSchema) : null,
        table: table.table ?? table.name,
        columns: columnsByTable.get(table.name) ?? [],
      })),
    }),
    [conn.tables, columnsByTable, pg, dialect],
  );

  // --- helpers ----------------------------------------------------------------------

  /** Reads for the impact preview and the validator. Never raises a toast. */
  const previewRunner: PreviewRunner = useCallback(async (sql) => (await client.query(sql)).rows, [client]);

  /**
   * Compile generated SQL against the live database and report the first
   * error, so the model can fix it before it reaches the editor. Compiled
   * with EXPLAIN, never run.
   */
  const validateGeneratedSql = useCallback(
    async (sql: string): Promise<string | null> => {
      try {
        const failed = await validateScript(sql, dialect, async (q) => client.query(q));
        return failed ? failed.error : null;
      } catch (error) {
        console.error('SQL validation failed:', error);
        return null;
      }
    },
    [client, dialect],
  );

  const markError = (error: RunError, ranges: StatementRange[] | null) => {
    const range = ranges?.[error.statement];
    if (!range) return;
    if (error.position) {
      const doc = editorRef.current?.getValue() ?? '';
      const from = range.from + error.position - 1;
      let to = from;
      while (to < doc.length && /[\w."]/.test(doc[to])) to++;
      editorRef.current?.markError(from, Math.max(to, from + 1), error.message);
    } else {
      editorRef.current?.markError(range.from, range.to, error.message);
    }
  };

  // --- running ---------------------------------------------------------------------

  const executeScript = async (
    statements: string[],
    writes: boolean[],
    ranges: StatementRange[] | null,
  ): Promise<{ success: boolean; errors: string[]; rowsAffected: number; failedStatement: number | null }> => {
    const queryId = newQueryId();
    const startedAt = Date.now();
    setRunning({ queryId, startedAt });
    setOutcome(null);
    setExplanation(null);
    editorRef.current?.clearErrors();
    const transaction = useTransaction && statements.length > 1 && !managesTransaction(statements);
    try {
      const response = await client.execute(statements, {
        session: true,
        queryId,
        transaction,
        continueOnError: !transaction,
        maxRows: rowLimit ?? undefined,
        stopAtLimit: statements.length === 1 && rowLimit !== null,
      });
      setInTransaction(conn.id, response.inTransaction);
      const result: RunOutcome = {
        statements,
        results: response.results,
        errors: response.errors,
        elapsedMs: response.elapsedMs,
        rolledBack: response.rolledBack,
        limit: rowLimit,
        writes,
      };
      setOutcome(result);
      const rowsAffected = response.results.reduce((n, r) => (writes[r.statement] ? n + r.rowsAffected : n), 0);
      const success = response.errors.length === 0;
      const lastSet = [...response.results].reverse().find((r) => r.returnsRows);
      addHistory({
        connectionId: conn.id,
        connectionName: conn.name,
        sql: statements.join(';\n'),
        durationMs: response.elapsedMs,
        ok: success,
        rows: lastSet ? lastSet.rows.length : writes.some(Boolean) ? rowsAffected : null,
        error: response.errors[0]?.message,
      });
      if (!success) markError(response.errors[0], ranges);
      // Star cheers at a clean run and winces at a failed one.
      mascot.setMood(success ? 'happy' : 'error', success ? 1200 : 1600);
      if (success && writes.some(Boolean)) {
        toast({
          title: rowsAffected === 0 ? 'No rows changed' : 'Done',
          description: rowsAffected === 0 ? 'The statement ran, but nothing matched.' : `${rowsAffected.toLocaleString()} ${rowsAffected === 1 ? 'row' : 'rows'} changed.`,
        });
      }
      return {
        success,
        errors: response.errors.map((e) => e.message),
        rowsAffected,
        failedStatement: success ? null : response.errors[0].statement,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOutcome({
        statements,
        results: [],
        errors: [{ statement: 0, message, code: null, cancelled: false, position: null }],
        elapsedMs: Date.now() - startedAt,
        rolledBack: false,
        limit: rowLimit,
        writes,
      });
      mascot.setMood('error', 1600);
      if (error instanceof ReadOnlyConnectionError) {
        toast({ title: 'Read-only connection', description: message, variant: 'destructive' });
      }
      return { success: false, errors: [message], rowsAffected: 0, failedStatement: 0 };
    } finally {
      setRunning(null);
    }
  };

  /** Run a script the gate has cleared, and record what happened. */
  const runApproved = async (
    decision: GateDecision,
    auditDecision: AuditDecision,
    origin: ScriptOrigin,
    impact: ImpactEstimate[],
    ranges: StatementRange[] | null,
  ) => {
    const started = performance.now();
    const writes = decision.statements.map((s) => s.kind !== 'read');
    const result = await executeScript(decision.statements.map((s) => s.sql), writes, ranges);
    const outcomeKind: AuditOutcome = result.success ? 'ok' : 'error';

    if (result.success) {
      setFailure(null);
    } else if (!result.errors[0]?.startsWith('Cancelled')) {
      const index = result.failedStatement ?? 0;
      const range = ranges?.[index] ?? null;
      setFailure({ sql: range?.sql ?? decision.statements[index]?.sql ?? origin.script, error: result.errors[0] ?? '', range });
      mascot.say('Click me to explain or fix it', 2800);
    }

    // Anything that changed the database invalidates what the rest of the app shows.
    if (result.success && decision.kind !== 'read' && refreshTables) await Promise.resolve(refreshTables());

    void recordDecision({
      statements: auditableStatements(decision.statements, origin.provenance, decision.appliedPolicy),
      decision: auditDecision,
      outcome: outcomeKind,
      provenance: origin.provenance,
      policy: decision.appliedPolicy,
      error: result.errors.join('; ') || null,
      estimatedRows: impact.reduce<number | null>((total, p) => (p.exactRows === null ? total : (total ?? 0) + p.exactRows), null),
      actualRows: result.success && decision.kind !== 'read' ? result.rowsAffected : null,
      durationMs: Math.round(performance.now() - started),
      prompt: origin.prompt,
      model: origin.provenance === 'ai' ? aiService.activeModelName() : null,
    });
  };

  /**
   * The one entry point to execution: every run from this editor goes through
   * the gate, so the policy cannot be bypassed by a path added later.
   */
  const runScript = async (script: string, origin: ScriptOrigin, baseOffset: number | null) => {
    const gen = ++previewGen.current;
    setPreviews([]);
    if (!script.trim()) {
      toast({ title: 'Nothing to run', description: 'Write a statement first.' });
      return;
    }
    const decision = evaluateScript(script, activePolicy(), origin.provenance);
    if (decision.statements.length === 0) {
      toast({ title: 'Nothing to run', description: 'No SQL statements found.' });
      return;
    }
    const ranges =
      baseOffset === null
        ? null
        : statementRanges(script).map((r) => ({ from: r.from + baseOffset, to: r.to + baseOffset, sql: r.sql }));
    lastRanges.current = ranges;

    if (decision.action === 'block') {
      // A refusal by policy is not an error to fix, so Star offers nothing.
      setFailure(null);
      setExplanation(null);
      setOutcome({
        statements: decision.statements.map((s) => s.sql),
        results: [],
        errors: [{ statement: 0, message: decision.reason, code: null, cancelled: false, position: null }],
        elapsedMs: 0,
        rolledBack: false,
        limit: rowLimit,
        writes: decision.statements.map((s) => s.kind !== 'read'),
      });
      toast({ title: 'Blocked by connection policy', description: decision.reason, variant: 'destructive' });
      void recordDecision({
        statements: auditableStatements(decision.statements, origin.provenance, decision.appliedPolicy),
        decision: 'blocked',
        outcome: 'not-run',
        provenance: origin.provenance,
        policy: decision.appliedPolicy,
        error: decision.reason,
        prompt: origin.prompt,
        model: origin.provenance === 'ai' ? aiService.activeModelName() : null,
      });
      return;
    }

    if (decision.action === 'allow') {
      await runApproved(decision, 'allowed', origin, [], ranges);
      return;
    }

    // Open the dialog first and fill the numbers in as they arrive: the
    // preview issues real queries, and a dialog that waits on them reads as
    // a frozen app.
    setPendingDecision(decision);
    setPendingOrigin(origin);
    setPendingRanges(ranges);
    setIsPreviewing(true);
    try {
      const next = await previewImpact(decision.statements, dialect, previewRunner);
      if (gen !== previewGen.current) return;
      setPreviews(next);
    } catch (error) {
      console.error('Impact preview failed:', error);
    } finally {
      if (gen === previewGen.current) setIsPreviewing(false);
    }
  };

  const currentOrigin = (script: string): ScriptOrigin => ({
    provenance: activeTab.provenance,
    prompt: activeTab.aiPrompt,
    script,
  });

  /** Mod-Enter: the selection, or the statement under the cursor. */
  const runStatement = () => {
    const editor = editorRef.current;
    if (!editor || running) return;
    const selection = editor.getSelection();
    if (selection.text.trim()) {
      void runScript(selection.text, currentOrigin(selection.text), selection.from);
      return;
    }
    const doc = editor.getValue();
    const range = statementAt(doc, editor.getCursor());
    if (!range) {
      toast({ title: 'Nothing to run', description: 'Write a statement first.' });
      return;
    }
    editor.select(range.from, range.to);
    void runScript(range.sql, currentOrigin(range.sql), range.from);
  };

  /** Shift-Mod-Enter or F5: every statement in the tab. */
  const runAll = () => {
    const editor = editorRef.current;
    if (!editor || running) return;
    const doc = editor.getValue();
    void runScript(doc, currentOrigin(doc), 0);
  };

  const cancel = async () => {
    if (!running) return;
    try {
      await dbCancel(running.queryId);
    } catch (error) {
      console.error('Cancel failed:', error);
    }
  };

  const handleApprove = async () => {
    const decision = pendingDecision;
    const origin = pendingOrigin;
    const impact = previews;
    const ranges = pendingRanges;
    if (!decision || !origin) return;
    previewGen.current += 1;
    setPendingDecision(null);
    setPendingOrigin(null);
    setPendingRanges(null);
    setPreviews([]);
    setIsPreviewing(false);
    await runApproved(decision, 'approved', origin, impact, ranges);
  };

  const handleDecline = () => {
    const decision = pendingDecision;
    const origin = pendingOrigin;
    previewGen.current += 1;
    setPendingDecision(null);
    setPendingOrigin(null);
    setPendingRanges(null);
    setPreviews([]);
    setIsPreviewing(false);
    if (!decision || !origin) return;
    void recordDecision({
      statements: auditableStatements(decision.statements, origin.provenance, decision.appliedPolicy),
      decision: 'declined',
      outcome: 'not-run',
      provenance: origin.provenance,
      policy: decision.appliedPolicy,
      prompt: origin.prompt,
      model: origin.provenance === 'ai' ? aiService.activeModelName() : null,
    });
  };

  // --- AI: Text to SQL, explain, fix ------------------------------------------------

  /**
   * Text to SQL wrote `query`. An empty tab takes it whole; otherwise it goes in
   * after the statement the cursor is in, so nothing already there is split or
   * replaced. It is left selected, so Run takes exactly it.
   */
  const placeGenerated = (query: string, prompt: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const place = placeAfterStatement(editor.getValue(), editor.getSelection().to, query);
    editor.replaceRange(place.from, place.to, place.insert);
    const from = place.start;
    editor.select(from, from + query.length);
    patchActiveTab({ provenance: 'ai', aiPrompt: prompt });
    setFailure(null);
    setExplanation(null);
    if (isYolo()) {
      // Nobody is reviewing this, so Star rattles.
      mascot.gesture('rattle');
      mascot.say('Running it now, no review', 1800);
      void runScript(query, { provenance: 'ai', prompt, script: query }, from);
    }
  };

  /** Ask the model why the last run failed; the answer shows under the error. */
  const explainFailure = async (f: Failure) => {
    setExplaining(true);
    setExplanation(null);
    mascot.setMood('thinking');
    mascot.say('Reading the error', 60_000);
    try {
      const text = await aiService.explainError(f.sql, f.error);
      setExplanation(text);
      mascot.setMood('idle');
      mascot.say(null);
      requestAnimationFrame(() => mascot.glance(resultsRef.current, 1200));
    } catch (error) {
      mascot.setMood('error', 1600);
      mascot.say(null);
      toast({
        variant: 'destructive',
        title: 'Could not explain the error',
        description: error instanceof Error ? error.message : 'Check your AI provider in Settings and try again.',
      });
    } finally {
      setExplaining(false);
    }
  };

  /** Apply a fix: into the failing statement's place, marked as generated. */
  const applyFix = (f: Failure, fixed: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const doc = editor.getValue();
    const range = f.range && doc.slice(f.range.from, f.range.to) === f.range.sql ? f.range : null;
    if (range) editor.replaceRange(range.from, range.to, fixed);
    else editor.replaceRange(0, doc.length, fixed);
    const prompt = `Fix this error: ${f.error}`;
    patchActiveTab({ provenance: 'ai', aiPrompt: prompt });
    setFailure(null);
    setExplanation(null);
    setFixState(null);
    if (isYolo()) {
      mascot.gesture('rattle');
      mascot.say('Fixed. Running it now, no review', 2000);
      void runScript(fixed, { provenance: 'ai', prompt, script: fixed }, range ? range.from : 0);
    } else {
      mascot.setMood('happy', 1400);
      mascot.say('Fixed. Look it over, then run it', 2600);
    }
  };

  /**
   * Ask for a corrected query. Shown side by side first; nothing in the
   * editor changes until Apply. In YOLO the fix goes straight in and runs,
   * as all generated SQL does there.
   */
  const fixFailure = async (f: Failure) => {
    setFixState({ original: f.sql, error: f.error, fixed: null, loading: true, failure: null });
    mascot.setMood('thinking');
    mascot.say('Fixing it', 60_000);
    try {
      const fixed = await aiService.fixQuery(f.sql, f.error, validateGeneratedSql);
      mascot.say(null);
      if (isYolo()) {
        applyFix(f, fixed);
        return;
      }
      setFixState({ original: f.sql, error: f.error, fixed, loading: false, failure: null });
      mascot.setMood('happy', 1200);
    } catch (error) {
      mascot.setMood('error', 1600);
      mascot.say(null);
      setFixState({
        original: f.sql,
        error: f.error,
        fixed: null,
        loading: false,
        failure: error instanceof Error ? error.message : 'Check your AI provider in Settings and try again.',
      });
    }
  };

  // Star offers to explain or fix while a failure is on screen and nothing is running.
  const helpers = useRef({ explainFailure, fixFailure });
  helpers.current = { explainFailure, fixFailure };
  useEffect(() => {
    if (!failure || explaining || fixState?.loading) {
      mascot.offerHelp(null);
      return;
    }
    mascot.offerHelp({
      explain: () => void helpers.current.explainFailure(failure),
      fix: () => void helpers.current.fixFailure(failure),
    });
  }, [failure, explaining, fixState?.loading]);
  useEffect(() => () => mascot.offerHelp(null), []);

  // Results arriving are something that changed: Star glances at them.
  useEffect(() => {
    if (!outcome) return;
    const raf = requestAnimationFrame(() => mascot.glance(resultsRef.current, 1000));
    return () => cancelAnimationFrame(raf);
  }, [outcome]);

  /** Mod-Shift-E: what the selection or the statement under the cursor does, and its plan. */
  const explainQuery = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.getSelection();
    const sql = selection.text.trim() || statementAt(editor.getValue(), editor.getCursor())?.sql || '';
    if (!sql) {
      toast({ title: 'Nothing to explain', description: 'Put the cursor in a statement, or select one.' });
      return;
    }
    setPanel(null);
    setExplainState({ sql, plan: null, text: null, error: null, loading: true });
    let plan: string | null = null;
    // Plain EXPLAIN describes a statement without running it. Never ANALYZE.
    const statement = classifyStatement(sql);
    if (canValidate(statement, dialect)) {
      try {
        const result = await client.query(dialect === 'postgres' ? `EXPLAIN ${sql.replace(/;\s*$/, '')}` : `EXPLAIN QUERY PLAN ${sql.replace(/;\s*$/, '')}`);
        plan =
          dialect === 'postgres'
            ? result.rows.map((r) => String(r[0] ?? '')).join('\n')
            : result.rows.map((r) => String(r[r.length - 1] ?? '')).join('\n');
      } catch {
        plan = null;
      }
    }
    setExplainState({ sql, plan, text: null, error: null, loading: true });
    try {
      const text = await aiService.explainQuery(sql, plan);
      setExplainState({ sql, plan, text, error: null, loading: false });
    } catch (error) {
      setExplainState({
        sql,
        plan,
        text: null,
        error: error instanceof Error ? error.message : 'Check your AI provider in Settings and try again.',
        loading: false,
      });
    }
  };

  // --- other actions ------------------------------------------------------------------

  const exportResult = async (result: StatementResult, format: 'csv' | 'json' | 'xlsx') => {
    try {
      const { columns, rows } = resultObjects(result);
      let data: string | Uint8Array;
      if (format === 'csv') data = [csvRow(columns), ...rows.map((r) => csvRow(columns.map((c) => r[c])))].join('\n') + '\n';
      else if (format === 'json') data = JSON.stringify(rowsToJson(rows), null, 2);
      else data = buildXlsx([{ name: 'Query result', columns, rows }]);
      const saved = await tauriService.exportDatabase(data, format);
      if (saved.success) toast({ title: 'Exported', description: saved.filePath });
      else if (saved.error !== 'Export cancelled') toast({ title: 'Export failed', description: saved.error, variant: 'destructive' });
    } catch (error) {
      toast({ title: 'Export failed', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    }
  };

  const openSql = (sql: string) => {
    if (!activeTab.sql.trim()) {
      patchActiveTab({ sql, provenance: 'user', aiPrompt: null });
    } else {
      addTab(sql);
    }
  };

  const saveScript = () => {
    const name = scriptName.trim();
    if (!name) return;
    const next = [...savedScripts.filter((s) => s.name !== name), { name, sql: activeTab.sql }];
    setSavedScripts(next);
    try {
      localStorage.setItem(SCRIPTS_KEY, JSON.stringify(next));
    } catch {
      // Ignore: the list still shows for this session.
    }
    patchActiveTab({ title: name, named: true });
    setSaveOpen(false);
    toast({ title: 'Saved', description: `"${name}" is in Saved scripts.` });
  };

  const deleteScript = (name: string) => {
    const next = savedScripts.filter((s) => s.name !== name);
    setSavedScripts(next);
    try {
      localStorage.setItem(SCRIPTS_KEY, JSON.stringify(next));
    } catch {
      // Ignore.
    }
  };

  useAppCommand((command) => {
    if (command.type === 'runQuery') runStatement();
    if (command.type === 'newQueryTab') addTab();
  });

  const startSplitDrag = (event: React.MouseEvent) => {
    event.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (e: MouseEvent) => {
      const fraction = (e.clientY - rect.top) / rect.height;
      setEditorFraction(Math.min(0.85, Math.max(0.15, fraction)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const tabTitle = (tab: EditorTab) => (tab.named ? tab.title : titleFromSql(tab.sql, tab.title));
  const tablesForPlaceholder = visibleTables(conn).slice(0, 1)[0]?.name;

  return (
    <div className="flex h-full flex-col animate-fade-in">
      <ApprovalDialog
        open={pendingDecision !== null}
        decision={pendingDecision}
        previews={previews}
        isPreviewing={isPreviewing}
        isRunning={running !== null}
        onApprove={() => void handleApprove()}
        onCancel={handleDecline}
      />

      {/* Tabs and toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar">
          {tabsState.tabs.map((tab) => {
            const selected = tab.id === activeTab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  'group flex h-7 max-w-[200px] shrink-0 items-center gap-1 rounded-md pl-2.5 pr-1 text-xs transition-colors',
                  selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                {renaming === tab.id ? (
                  <input
                    autoFocus
                    defaultValue={tabTitle(tab)}
                    onBlur={(e) => {
                      const title = e.target.value.trim();
                      if (title) updateTabs((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, title, named: true } : t)) }));
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    className="w-28 bg-transparent outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    className="truncate"
                    onClick={() => updateTabs((s) => ({ ...s, activeId: tab.id }))}
                    onDoubleClick={() => setRenaming(tab.id)}
                    title={`${tabTitle(tab)} · double-click to rename`}
                  >
                    {tab.provenance === 'ai' && <Sparkles className="mr-1 inline h-3 w-3 text-key" aria-label="Written by AI" />}
                    {tabTitle(tab)}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => closeTab(tab.id)}
                  className={cn('rounded p-0.5 hover:bg-background', selected ? 'opacity-70' : 'opacity-0 group-hover:opacity-70')}
                  aria-label={`Close ${tabTitle(tab)}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => addTab()} aria-label="New query tab" title="New query tab">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {running ? (
            <ToolbarButton label="Cancel the running query" onClick={() => void cancel()} variant="outline">
              <Square className="h-3 w-3" /> Cancel
            </ToolbarButton>
          ) : (
            <>
              <ToolbarButton label="Run the selection, or the statement under the cursor" shortcut="Mod+Enter" onClick={runStatement} variant="default" disabled={pendingDecision !== null}>
                <Play className="h-3 w-3" /> Run
              </ToolbarButton>
              <ToolbarButton label="Run every statement in this tab" shortcut="Shift+Mod+Enter" onClick={runAll} disabled={pendingDecision !== null}>
                <ListChecks className="h-3.5 w-3.5" /> Run all
              </ToolbarButton>
            </>
          )}
          <div className="mx-1 h-4 w-px bg-border" />
          <ToolbarButton label={policy === 'yolo' ? 'Ask AI (YOLO: runs what it writes)' : 'Ask AI to write SQL'} shortcut="Mod+K" onClick={() => setAiOpen(true)}>
            <Sparkles className={cn('h-3.5 w-3.5', policy === 'yolo' ? 'text-destructive' : 'text-key')} /> Ask AI
          </ToolbarButton>
          <ToolbarButton label="Explain the selection or the statement under the cursor" shortcut="Mod+Shift+E" onClick={() => void explainQuery()}>
            <Lightbulb className="h-3.5 w-3.5" /> Explain
          </ToolbarButton>
          <div className="mx-1 h-4 w-px bg-border" />
          <Select
            value={rowLimit === null ? 'none' : String(rowLimit)}
            onValueChange={(v) => {
              const next = v === 'none' ? null : Number(v);
              setRowLimit(next);
              try {
                localStorage.setItem(LIMIT_KEY, v);
              } catch {
                // Ignore.
              }
            }}
          >
            <SelectTrigger className="h-7 w-[112px] text-xs" title="Rows kept per result. The rest are not fetched.">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROW_LIMITS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n.toLocaleString()} rows
                </SelectItem>
              ))}
              <SelectItem value="none">No limit</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground" title="Run all statements in one transaction: all or nothing">
            <Switch checked={useTransaction} onCheckedChange={setUseTransaction} className="scale-75" />
            Transaction
          </label>
          <ToolbarButton label="Save this script" iconOnly onClick={() => {
            setScriptName(activeTab.title.startsWith('Query ') ? '' : activeTab.title);
            setSaveOpen(true);
          }} disabled={!activeTab.sql.trim()}>
            <Save className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton label="History, saved scripts and the audit log" iconOnly onClick={() => setPanel((p) => (p ? null : 'history'))}>
            <PanelRight className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      </div>

      {conn.inTransaction && (
        <div className="flex items-center gap-3 border-b bg-warning/10 px-3 py-1.5 text-xs">
          <span className="font-medium text-warning">Transaction open</span>
          <span className="text-muted-foreground">Changes are not visible to anyone else until you commit.</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => void runScript('COMMIT', { provenance: 'user', prompt: null, script: 'COMMIT' }, null)}>
              Commit
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => void runScript('ROLLBACK', { provenance: 'user', prompt: null, script: 'ROLLBACK' }, null)}>
              Roll back
            </Button>
          </div>
        </div>
      )}

      <AiQueryDialog
        open={aiOpen}
        onOpenChange={(open) => {
          setAiOpen(open);
          if (!open) setAiSeed(undefined);
        }}
        seed={aiSeed}
        validate={validateGeneratedSql}
        onQueryGenerated={placeGenerated}
      />

      <div className="flex min-h-0 flex-1">
        <div ref={splitRef} className="flex min-w-0 flex-1 flex-col">
          <div style={{ height: `${editorFraction * 100}%` }} className="min-h-0">
            <SqlCodeEditor
              ref={editorRef}
              docKey={activeTab.id}
              value={activeTab.sql}
              onChange={(sql) => {
                // Provenance is sticky: editing generated SQL does not make the
                // user its author. Emptying the box is the one edit that clears it.
                const cleared = !sql.trim();
                patchActiveTab({ sql, ...(cleared ? { provenance: 'user' as Provenance, aiPrompt: null } : {}) });
                // Fixing would overwrite these edits, so the offer goes once the text changes.
                if (failure) setFailure(null);
              }}
              dialect={dialect}
              schema={schema}
              defaultSchema={pg?.defaultSchema}
              catalog={catalog}
              placeholder={
                tablesForPlaceholder
                  ? `SELECT * FROM ${tablesForPlaceholder} LIMIT 10;   ${shortcutLabel('Mod+Enter')} runs the statement under the cursor · ${shortcutLabel('Mod+K')} asks AI`
                  : `Write SQL here. ${shortcutLabel('Mod+Enter')} runs the statement under the cursor · ${shortcutLabel('Mod+K')} asks AI`
              }
              onRunStatement={runStatement}
              onRunAll={runAll}
              onAi={() => setAiOpen(true)}
              onExplain={() => void explainQuery()}
            />
          </div>
          <div
            onMouseDown={startSplitDrag}
            className="h-1.5 shrink-0 cursor-row-resize border-y bg-muted/40 hover:bg-key/30"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize editor and results"
          />
          <div ref={resultsRef} className="min-h-0 flex-1">
            <ResultPanel
              outcome={outcome}
              running={running}
              onCancel={() => void cancel()}
              onFix={() => failure && void fixFailure(failure)}
              onExplainError={() => failure && void explainFailure(failure)}
              explanation={explanation}
              explaining={explaining}
              onExport={(result, format) => void exportResult(result, format)}
              dialect={dialect}
              aiConfigured
            />
          </div>
        </div>
        {explainState && <ExplainPanel state={explainState} onClose={() => setExplainState(null)} />}
        {panel && (
          <SidePanel
            tab={panel}
            onTabChange={setPanel}
            onClose={() => setPanel(null)}
            connectionId={conn.id}
            onOpen={openSql}
            savedScripts={savedScripts}
            onDeleteScript={deleteScript}
          />
        )}
      </div>

      <FixDialog
        state={fixState}
        onApply={(fixed) => failure && applyFix(failure, fixed)}
        onClose={() => setFixState(null)}
      />

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveScript();
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>Save script</DialogTitle>
            </DialogHeader>
            <Input autoFocus value={scriptName} onChange={(e) => setScriptName(e.target.value)} placeholder="Name" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaveOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!scriptName.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SqlEditor;
