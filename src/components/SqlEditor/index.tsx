import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { sqliteService } from '@/lib/sqliteService';
import { pgService } from '@/lib/pgService';
import { toast } from '@/hooks/use-toast';
import { AlertCircle, PlayCircle, Save, Trash, CheckCircle2, Info, Sparkles, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { AiQueryDialog } from './AiQueryDialog';
import { ApprovalDialog } from './ApprovalDialog';
import { AuditLogView } from './AuditLogView';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { tauriService } from '@/lib/tauri';
import { evaluateScript, type GateDecision, type Provenance } from '@/lib/sqlPolicy';
import { previewImpact, type ImpactEstimate, type PreviewRunner } from '@/lib/impactPreview';
import { activePolicy, auditableStatements, isYolo, recordDecision } from '@/lib/queryGate';
import { validateScript } from '@/lib/sqlValidator';
import type { AuditDecision, AuditOutcome } from '@/lib/auditLog';
import { aiService } from '@/lib/aiService';

interface SqlEditorProps {
  isPostgres?: boolean;
  refreshTables?: () => Promise<void> | void;
}

/**
 * Who wrote the script being run, and what they asked for.
 *
 * Carried alongside the script rather than read from component state, because
 * YOLO mode runs a generated script in the same tick it arrives — before
 * React has flushed the corresponding `setProvenance` call.
 */
interface ScriptOrigin {
  provenance: Provenance;
  prompt: string | null;
}

const SqlEditor = ({ isPostgres = false, refreshTables }: SqlEditorProps) => {
  const [sqlScript, setSqlScript] = useState('');
  const [useTransaction, setUseTransaction] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<{
    success: boolean;
    affectedTables: string[];
    errors: string[];
    executionTime?: number;
    queryResults?: {
      columns: string[];
      rows: (string | number | boolean | null)[][];
    } | null;
  } | null>(null);
  const [savedScripts, setSavedScripts] = useState<{ name: string; sql: string }[]>([]);
  const [scriptName, setScriptName] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isAiDialogOpen, setIsAiDialogOpen] = useState(false);

  // Write-safety state. `provenance` is what makes the gate treat generated
  // SQL differently from typed SQL, so it is tracked on the editor rather than
  // inferred later: once the text is in the box, nothing can tell them apart.
  const [pendingDecision, setPendingDecision] = useState<GateDecision | null>(null);
  const [pendingOrigin, setPendingOrigin] = useState<ScriptOrigin | null>(null);
  const [previews, setPreviews] = useState<ImpactEstimate[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const previewGen = useRef(0);
  const [provenance, setProvenance] = useState<Provenance>('user');
  const [aiPrompt, setAiPrompt] = useState<string | null>(null);

  const dialect = isPostgres ? 'postgres' : 'sqlite';

  /**
   * Read-only runner for the impact preview.
   *
   * Postgres goes through tauriService rather than pgService because
   * pgService raises a toast on failure — and a failed EXPLAIN is an expected
   * outcome here, not something to interrupt the user with.
   */
  const previewRunner: PreviewRunner = async (sql) => {
    if (isPostgres) {
      const result = await tauriService.executePostgresQuery({ query: sql });
      if (!result || !result.success) throw new Error(result?.error || 'preview query failed');
      return (result.rows ?? []) as unknown as unknown[][];
    }
    return sqliteService.executeQuery(sql)?.rows ?? null;
  };

  /**
   * Compile generated SQL against the live database and report the first
   * error, so the model can fix it before the SQL reaches the editor.
   *
   * This is the answer to the failure that used to reach the user: the model
   * writes an UPDATE naming a column that does not exist, it lands in the box
   * looking plausible, and the error only appears after Execute. Compiling it
   * here turns that into a retry the user never sees.
   */
  const validateGeneratedSql = async (sql: string): Promise<string | null> => {
    try {
      const failure = await validateScript(sql, dialect, previewRunner);
      return failure ? failure.error : null;
    } catch (error) {
      // The checker itself failed — no connection, a driver problem. Report
      // no error rather than a false one: a spurious message would send the
      // model rewriting SQL that was fine.
      console.error('SQL validation failed:', error);
      return null;
    }
  };

  // Function to execute the SQL script
  /**
   * @param reportsRowCount Whether the script changes rows, so a count is
   *   meaningful. Reads are excluded because neither engine gives a clean
   *   answer for them: SQLite's counter still holds the previous write's
   *   value, and Postgres reports rows *returned* in the same field.
   */
  const executeScript = async (statements: string[], reportsRowCount: boolean) => {
    setIsRunning(true);
    setResults(null);

    try {
      const startTime = performance.now();

      let result: {
        success: boolean;
        affectedTables: string[];
        errors: string[];
        rowsAffected: number;
        queryResults?: {
          columns: string[];
          rows: (string | number | boolean | null)[][];
        } | null;
      };


      if (isPostgres) {
        // For PostgreSQL, execute each statement sequentially
        result = { success: true, affectedTables: [], errors: [], rowsAffected: 0, queryResults: null };

        for (const statement of statements) {
          try {
            // Check if this is a SELECT or similar query that returns data
            const isSelectQuery = /^\s*(SELECT|WITH|SHOW|EXPLAIN|ANALYZE|DESC|DESCRIBE)/i.test(statement);

            const queryResult = await pgService.executeQuery(statement);
            if (queryResult) {
              result.rowsAffected += queryResult.rowsAffected;
              // For SELECT queries, we want to display the results
              if (isSelectQuery) {
                // Normalize Postgres object rows to array-of-arrays based on columns (type-safe)
                const isObjectRow = (value: unknown): value is Record<string, unknown> =>
                  typeof value === 'object' && value !== null && !Array.isArray(value);

                let normalizedRows: (string | number | boolean | null)[][] = [];
                if (Array.isArray(queryResult.rows) && queryResult.rows.length > 0) {
                  const firstRowUnknown = queryResult.rows[0] as unknown;
                  if (isObjectRow(firstRowUnknown)) {
                    const objectRows = queryResult.rows as unknown as Array<Record<string, unknown>>;
                    normalizedRows = objectRows.map((r) =>
                      queryResult.columns.map((c) => {
                        const v = r[c];
                        return (v === undefined ? null : (v as string | number | boolean | null));
                      })
                    );
                  } else {
                    normalizedRows = queryResult.rows as (string | number | boolean | null)[][];
                  }
                }

                result.queryResults = {
                  columns: queryResult.columns,
                  rows: normalizedRows
                };
              }

              // Refreshing is handled once in runApproved, for every kind of
              // change rather than only DDL.

              // Try to extract table names from the SQL
              const tableMatches = statement.match(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\s+(?:"|')?(\w+)(?:"|')?/i);
              if (tableMatches && tableMatches[1] && !result.affectedTables.includes(tableMatches[1])) {
                result.affectedTables.push(tableMatches[1]);
              }
            } else {
              result.success = false;
              result.errors.push(`Failed to execute: ${statement}`);
            }
          } catch (error) {
            result.success = false;
            result.errors.push(error instanceof Error ? error.message : "Unknown error");
          }
        }
      } else {
        // For SQLite, check if we have a SELECT query and handle it specially
        const isSelectQuery = /^\s*(SELECT|WITH|SHOW|EXPLAIN|ANALYZE|DESC|DESCRIBE)/i.test(statements[0]);

        if (isSelectQuery && statements.length === 1) {
          try {
            const queryResult = sqliteService.executeQuery(statements[0]);
            result = {
              success: true,
              affectedTables: [],
              errors: [],
              rowsAffected: queryResult?.rowsAffected ?? 0,
              queryResults: queryResult as {
                columns: string[];
                rows: (string | number | boolean | null)[][];
              }
            };
          } catch (error) {
            result = {
              success: false,
              affectedTables: [],
              errors: [error instanceof Error ? error.message : "Unknown error"],
              rowsAffected: 0
            };
          }
        } else {
          // For other SQL statements, use the existing batch operation
          result = sqliteService.executeBatchOperations(statements, useTransaction);
        }
      }

      const endTime = performance.now();

      setResults({
        ...result,
        executionTime: Math.round(endTime - startTime)
      });

      if (result.success) {
        // Row count, not just "success". An UPDATE whose WHERE matches nothing
        // succeeds; without this it reported exactly the same as one that
        // changed thousands, and the user had no way to tell them apart.
        const changed = result.rowsAffected;
        const ran = `Executed ${statements.length} statement${statements.length > 1 ? 's' : ''}`;
        if (!reportsRowCount) {
          toast({ title: "Success", description: `${ran} successfully` });
        } else {
          toast({
            title: changed === 0 ? "No rows changed" : "Success",
            description:
              changed === 0
                ? `${ran}, but nothing matched — 0 rows changed.`
                : `${ran}. ${changed.toLocaleString()} row${changed === 1 ? '' : 's'} changed.`,
          });
        }
      } else {
        toast({
          title: "Execution Error",
          description: `${result.errors.length} error${result.errors.length > 1 ? 's' : ''} occurred`,
          variant: "destructive"
        });
      }

      return { success: result.success, errors: result.errors, rowsAffected: result.rowsAffected };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error occurred";
      setResults({
        success: false,
        affectedTables: [],
        errors: [message]
      });

      toast({
        title: "Execution Failed",
        description: message,
        variant: "destructive"
      });

      return { success: false, errors: [message], rowsAffected: 0 };
    } finally {
      setIsRunning(false);
    }
  };

  /**
   * Run a script the gate has cleared, and record what happened.
   *
   * The audit entry is written after execution rather than before, so it can
   * carry the real outcome. A log of intentions is not a log of events.
   */
  const runApproved = async (
    decision: GateDecision,
    auditDecision: AuditDecision,
    origin: ScriptOrigin,
    impact: ImpactEstimate[],
  ) => {
    const started = performance.now();
    const changesRows = decision.kind !== 'read';
    const outcomeResult = await executeScript(
      decision.statements.map((s) => s.sql),
      changesRows,
    );
    const outcome: AuditOutcome = outcomeResult.success ? 'ok' : 'error';

    // Anything that changed the database invalidates what the rest of the app
    // is showing. This used to fire only for DDL, matched with a regex, so a
    // successful UPDATE left the table editor displaying pre-write rows and
    // looked to the user like it had silently failed.
    if (outcomeResult.success && decision.kind !== 'read' && refreshTables) {
      await Promise.resolve(refreshTables());
    }

    void recordDecision({
      statements: auditableStatements(
        decision.statements,
        origin.provenance,
        decision.appliedPolicy,
      ),
      decision: auditDecision,
      outcome,
      provenance: origin.provenance,
      policy: decision.appliedPolicy,
      error: outcomeResult.errors.join('; ') || null,
      estimatedRows: impact.reduce<number | null>(
        (total, preview) =>
          preview.exactRows === null ? total : (total ?? 0) + preview.exactRows,
        null,
      ),
      actualRows: outcomeResult.success && changesRows ? outcomeResult.rowsAffected : null,
      durationMs: Math.round(performance.now() - started),
      prompt: origin.prompt,
      model: origin.provenance === 'ai' ? aiService.activeModelName() : null,
    });
  };

  /**
   * The one entry point to execution.
   *
   * Every path that runs SQL from this editor goes through here, so the policy
   * cannot be bypassed by a code path added later that forgets to ask.
   */
  const runScript = async (script: string, origin: ScriptOrigin) => {
    // Drop any previous preview so a later allow-path audit entry cannot
    // inherit a row count from an unrelated statement. Passing impact
    // explicitly into `runApproved` is the real fix; this keeps the dialog
    // from flashing stale numbers if React hasn't flushed yet. The generation
    // token discards an in-flight preview that belongs to a cancelled or
    // superseded script — otherwise its `finally` would re-enable Run with
    // the wrong counts.
    const gen = ++previewGen.current;
    setPreviews([]);

    if (!script.trim()) {
      toast({
        title: "Empty Script",
        description: "Please enter SQL statements to execute",
        variant: "destructive"
      });
      return;
    }

    const policy = activePolicy();
    const decision = evaluateScript(script, policy, origin.provenance);

    if (decision.statements.length === 0) {
      toast({
        title: "Invalid Script",
        description: "No valid SQL statements found",
        variant: "destructive"
      });
      return;
    }

    if (decision.action === 'block') {
      setResults({ success: false, affectedTables: [], errors: [decision.reason] });
      toast({
        title: "Blocked by connection policy",
        description: decision.reason,
        variant: "destructive"
      });
      void recordDecision({
        statements: auditableStatements(
          decision.statements,
          origin.provenance,
          decision.appliedPolicy,
        ),
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
      await runApproved(decision, 'allowed', origin, []);
      return;
    }

    // Open the dialog first and fill the numbers in as they arrive: the impact
    // preview issues real queries, and a dialog that appears only once they
    // return reads as a frozen app.
    setPendingDecision(decision);
    setPendingOrigin(origin);
    setPreviews([]);
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

  /**
   * The one entry point to execution.
   *
   * Every path that runs SQL from this editor goes through here, so the policy
   * cannot be bypassed by a code path added later that forgets to ask. The
   * script and its origin are passed explicitly rather than read from state,
   * because YOLO mode executes a generated script in the same tick it arrives
   * — before React has flushed it into `sqlScript`.
   */
  const handleRun = () => runScript(sqlScript, { provenance, prompt: aiPrompt });

  const handleApprove = async () => {
    const decision = pendingDecision;
    const origin = pendingOrigin;
    const impact = previews;
    if (!decision || !origin) return;
    previewGen.current += 1;
    setPendingDecision(null);
    setPendingOrigin(null);
    setPreviews([]);
    setIsPreviewing(false);
    await runApproved(decision, 'approved', origin, impact);
  };

  const handleDecline = () => {
    const decision = pendingDecision;
    const origin = pendingOrigin;
    previewGen.current += 1;
    setPendingDecision(null);
    setPendingOrigin(null);
    setPreviews([]);
    setIsPreviewing(false);
    if (!decision || !origin) return;
    void recordDecision({
      statements: auditableStatements(
        decision.statements,
        origin.provenance,
        decision.appliedPolicy,
      ),
      decision: 'declined',
      outcome: 'not-run',
      provenance: origin.provenance,
      policy: decision.appliedPolicy,
      prompt: origin.prompt,
      model: origin.provenance === 'ai' ? aiService.activeModelName() : null,
    });
  };

  const saveScript = () => {
    if (!sqlScript.trim()) {
      toast({
        title: "Empty Script",
        description: "Cannot save an empty script",
        variant: "destructive"
      });
      return;
    }

    if (!scriptName.trim()) {
      toast({
        title: "Missing Name",
        description: "Please provide a name for your script",
        variant: "destructive"
      });
      return;
    }

    // Check for duplicates
    if (savedScripts.some(script => script.name === scriptName)) {
      toast({
        title: "Duplicate Name",
        description: "A script with this name already exists",
        variant: "destructive"
      });
      return;
    }

    const newScript = { name: scriptName, sql: sqlScript };
    setSavedScripts([...savedScripts, newScript]);

    // Save to localStorage for persistence
    const existingScripts = JSON.parse(localStorage.getItem('savedScripts') || '[]');
    localStorage.setItem('savedScripts', JSON.stringify([...existingScripts, newScript]));

    setScriptName('');
    toast({
      title: "Script Saved",
      description: `"${scriptName}" has been saved to your collection`
    });
  };

  const loadScript = (script: { name: string; sql: string }) => {
    setSqlScript(script.sql);
    // Replacing the buffer with a script the user saved themselves also
    // replaces its provenance. Editing generated SQL does not — see the
    // Textarea handler.
    setProvenance('user');
    setAiPrompt(null);
    toast({
      title: "Script Loaded",
      description: `"${script.name}" is ready to edit or execute`
    });
  };

  const deleteScript = (scriptToDelete: { name: string; sql: string }) => {
    const updatedScripts = savedScripts.filter(script => script.name !== scriptToDelete.name);
    setSavedScripts(updatedScripts);

    // Update localStorage
    localStorage.setItem('savedScripts', JSON.stringify(updatedScripts));

    toast({
      title: "Script Deleted",
      description: `"${scriptToDelete.name}" has been removed from your collection`
    });
  };

  const handleExportResults = async (format: 'csv' | 'json' | 'xlsx') => {
    if (!results?.queryResults || !results.queryResults.columns.length) {
      toast({
        title: "No Data",
        description: "There are no results to export",
        variant: "destructive"
      });
      return;
    }

    try {
      let exportData = '';
      const { columns, rows } = results.queryResults;

      if (format === 'json') {
        // Convert to JSON
        const jsonData = rows.map(row => {
          const obj: Record<string, unknown> = {};
          columns.forEach((col, idx) => {
            obj[col] = row[idx];
          });
          return obj;
        });
        exportData = JSON.stringify(jsonData, null, 2);
      } else if (format === 'csv') {
        // Convert to CSV
        exportData = columns.join(',') + '\n';
        rows.forEach(row => {
          const csvRow = row.map(value => {
            if (value === null) return '';
            if (typeof value === 'string') {
              // Escape quotes and wrap in quotes if contains comma
              if (value.includes(',') || value.includes('"') || value.includes('\n')) {
                return `"${value.replace(/"/g, '""')}"`;
              }
              return value;
            }
            return String(value);
          });
          exportData += csvRow.join(',') + '\n';
        });
      } else if (format === 'xlsx') {
        // For Excel, create a structure that can be converted by the backend
        const data = {
          "Query Results": {
            columns,
            rows
          }
        };
        exportData = JSON.stringify(data);
      }

      // Export using Tauri service
      const result = await tauriService.exportDatabase(exportData, format);
      if (result.success) {
        toast({
          title: "Success",
          description: `Results exported to ${result.filePath}`
        });
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to export results",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to export results",
        variant: "destructive"
      });
    }
  };

  // Load saved scripts from localStorage when component mounts
  useEffect(() => {
    try {
      const storedScripts = localStorage.getItem('savedScripts');
      if (storedScripts) {
        setSavedScripts(JSON.parse(storedScripts));
      }
    } catch (error) {
      console.error("Error loading saved scripts:", error);
    }
  }, []);

  return (
    <div className="h-full flex flex-col overflow-auto px-2 animate-fade-in">
      <AiQueryDialog
        open={isAiDialogOpen}
        onOpenChange={setIsAiDialogOpen}
        validate={validateGeneratedSql}
        onQueryGenerated={(query, prompt) => {
          setSqlScript(query);
          setProvenance('ai');
          setAiPrompt(prompt);
          // YOLO runs it here rather than waiting for Execute. The script is
          // passed explicitly because `sqlScript` still holds the previous
          // value at this point.
          if (isYolo()) void runScript(query, { provenance: 'ai', prompt });
        }}
      />
      <ApprovalDialog
        open={pendingDecision !== null}
        decision={pendingDecision}
        previews={previews}
        isPreviewing={isPreviewing}
        isRunning={isRunning}
        onApprove={handleApprove}
        onCancel={handleDecline}
      />
      <Tabs defaultValue="editor" className="flex-1 flex flex-col">
        <div className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex items-center justify-end px-4 h-[52px]">
            <TabsList className="ml-4 h-8">
              <TabsTrigger value="editor" className="text-xs h-7">Editor</TabsTrigger>
              <TabsTrigger value="savedScripts" className="text-xs h-7">Saved Scripts</TabsTrigger>
              <TabsTrigger value="audit" className="text-xs h-7">Audit</TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="editor" className="flex-1 overflow-auto p-4 pt-0">
          <div className="flex-1 flex flex-col gap-4">
            <div className="flex items-center justify-between py-2">
              <div className="flex items-center space-x-4">
                {!isPostgres && (
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="transaction-mode"
                      checked={useTransaction}
                      onCheckedChange={setUseTransaction}
                    />
                    <Label htmlFor="transaction-mode" className="text-xs">
                      Use Transaction
                    </Label>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setIsAiDialogOpen(true)} className="h-8 text-xs">
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  Text to SQL
                </Button>
                <div className="flex items-center space-x-2">
                  <Input
                    type="text"
                    placeholder="Script name"
                    className="w-[200px] h-8 text-xs"
                    value={scriptName}
                    onChange={(e) => setScriptName(e.target.value)}
                  />
                  <Button variant="outline" size="sm" onClick={saveScript} className="h-8 text-xs">
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    Save Script
                  </Button>
                </div>
                <Button
                  onClick={handleRun}
                  disabled={isRunning || isPreviewing || pendingDecision !== null}
                  size="sm"
                  className="h-8 text-xs"
                >
                  <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
                  {isRunning ? 'Running...' : 'Execute Script'}
                </Button>
              </div>
            </div>

            <div className="flex-1 flex flex-col min-h-0">
              <Textarea
                ref={textareaRef}
                placeholder={isPostgres ?
                  "Enter PostgreSQL statements (each statement must end with a semicolon)..." :
                  "Enter SQL statements separated by semicolons (;)..."
                }
                className="flex-1 font-mono text-sm min-h-[300px] resize-none rounded-md border bg-background shadow-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                value={sqlScript}
                onChange={(e) => {
                  setSqlScript(e.target.value);
                  // Provenance is sticky: editing generated SQL does not make
                  // the user its author. Someone who tweaks one clause has not
                  // reviewed the rest, and 'ai' only ever tightens the gate,
                  // so staying on it is the safe direction to be wrong in.
                  // Emptying the box is the one edit that clears it.
                  if (!e.target.value.trim()) {
                    setProvenance('user');
                    setAiPrompt(null);
                  }
                }}
              />

              {results && (
                <div className="mt-4 space-y-2">
                  <Alert variant={results.success ? "default" : "destructive"}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {results.success ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : (
                          <AlertCircle className="h-4 w-4" />
                        )}
                        <AlertTitle>
                          {results.success ? 'Script executed successfully' : 'Script execution failed'}
                        </AlertTitle>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="sm">
                            <Download className="mr-2 h-4 w-4" />
                            Export Results
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onClick={() => handleExportResults('csv')}>
                            Export as CSV
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleExportResults('json')}>
                            Export as JSON
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleExportResults('xlsx')}>
                            Export as Excel
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <AlertDescription>
                      <div className="mt-2 space-y-2">
                        <p className="text-sm">Execution time: {results.executionTime}ms</p>

                        {results.queryResults && results.queryResults.columns.length > 0 && (
                          <div className="mt-4 space-y-2">
                            <p className="text-sm font-medium">Query results:</p>
                            <div className="overflow-auto max-h-[300px] rounded-md border">
                              <table className="min-w-full divide-y divide-border">
                                <thead className="bg-muted/50">
                                  <tr>
                                    {results.queryResults.columns.map((column, idx) => (
                                      <th
                                        key={idx}
                                        scope="col"
                                        className="px-3 py-2 text-left text-xs font-medium text-muted-foreground tracking-wider"
                                      >
                                        {column}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody className="bg-card divide-y divide-border">
                                  {results.queryResults.rows.length > 0 && results.queryResults.rows.map((row, rowIdx) => {
                                    // Check if row is an array (multi-column) or a single value
                                    const isArray = Array.isArray(row);

                                    return (
                                      <tr key={rowIdx} className={rowIdx % 2 === 0 ? "bg-muted/20" : "bg-card"}>
                                        {isArray ? (
                                          // If row is an array, render each cell
                                          row.map((cell, cellIdx) => (
                                            <td key={cellIdx} className="px-3 py-2 whitespace-nowrap text-xs">
                                              {cell === null ?
                                                <span className="text-muted-foreground italic">NULL</span> :
                                                String(cell)}
                                            </td>
                                          ))
                                        ) : (
                                          // If row is a single value (like in enum queries), render as single cell
                                          <td className="px-3 py-2 whitespace-nowrap text-xs">
                                            {row === null ? (
                                              <span className="text-muted-foreground italic">NULL</span>
                                            ) : typeof row === 'object' ? (
                                              // Extract value from object - typically PostgreSQL enum values have an 'unnest' property
                                              Object.values(row)[0] === null ? (
                                                <span className="text-muted-foreground italic">NULL</span>
                                              ) : (
                                                String(Object.values(row)[0])
                                              )
                                            ) : (
                                              String(row)
                                            )}
                                          </td>
                                        )}
                                      </tr>
                                    );
                                  })}
                                  {results.queryResults.rows.length === 0 && (
                                    <tr>
                                      <td
                                        colSpan={results.queryResults.columns.length}
                                        className="px-3 py-4 text-center text-sm text-muted-foreground"
                                      >
                                        No results found
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {results.affectedTables.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-sm font-medium">Affected tables:</p>
                            <div className="flex flex-wrap gap-1">
                              {results.affectedTables.map(table => (
                                <Badge key={table} variant="outline">
                                  {table}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {results.errors.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-sm font-medium">Errors:</p>
                            <div className="space-y-1">
                              {results.errors.map((error, idx) => (
                                <div key={idx} className="text-sm p-2 bg-destructive/10 rounded-md">
                                  {error}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="savedScripts" className="flex-1 overflow-auto">
          <div className="p-4 pt-2">
            {savedScripts.length === 0 ? (
              <div className="flex flex-col items-center justify-center min-h-[200px]">
                <div className="p-6 rounded-lg border-2 border-dashed text-center">
                  <Info className="mx-auto h-10 w-10 text-muted-foreground/50" />
                  <h3 className="mt-3 text-lg font-medium">No saved scripts</h3>
                  <p className="text-muted-foreground mt-1 max-w-sm text-center text-sm">
                    Save your frequently used SQL scripts here for quick access
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {savedScripts.map((script) => (
                  <Card key={script.name} className="flex flex-col">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 p-3">
                      <div>
                        <CardTitle className="text-sm font-medium">{script.name}</CardTitle>
                        <CardDescription className="text-xs mt-0.5">
                          {script.sql.split('\n').length} line{script.sql.split('\n').length !== 1 ? 's' : ''}
                        </CardDescription>
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => deleteScript(script)} className="h-8 w-8 -mr-2">
                        <Trash className="h-4 w-4" />
                        <span className="sr-only">Delete script</span>
                      </Button>
                    </CardHeader>
                    <CardContent className="p-3 pt-0">
                      <ScrollArea className="h-[100px] w-full rounded-md border bg-muted/40 p-2">
                        <pre className="text-xs font-mono text-muted-foreground">{script.sql}</pre>
                      </ScrollArea>
                    </CardContent>
                    <div className="p-3 pt-0">
                      <Button size="sm" onClick={() => loadScript(script)} className="w-full">
                        Load Script
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="audit" className="flex-1 overflow-hidden p-4 pt-2">
          <AuditLogView />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default SqlEditor;
