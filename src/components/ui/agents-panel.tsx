import { useEffect, useState } from 'react';
import { Check, Copy, Plug, Unplug } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Button } from './button';
import { Input } from './input';
import { Switch } from './switch';
import { useDirectWrites } from '@/hooks/useDirectWrites';
import { clampDirectLimit, DEFAULT_DIRECT_LIMIT, MAX_DIRECT_LIMIT } from '@/lib/agentDirectWrites';
import type { ActiveConnection } from '@/lib/queryGate';
import { useToast } from '@/hooks/use-toast';
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import { approveInAppEnabled, setApproveInApp } from '@/lib/agentApprovals';
import { installClaudeDesktopMcp } from '@/lib/claudeDesktopMcp';
import { mcpPolicyFromApp } from '@/lib/mcpHandoff';
import {
    appServerEntry,
    claudeCodeCommand,
    claudeDesktopSnippet,
    cursorSnippet,
    npxServerEntry,
    openCodeSnippet,
    vsCodeSnippet,
    type ServerEntry,
} from '@/lib/mcpAgentConfig';

function CopyRow({
    label,
    file,
    text,
}: {
    label: string;
    file: string;
    text: string;
}) {
    const { toast } = useToast();
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await writeText(text);
            setCopied(true);
        } catch {
            toast({
                title: 'Copy failed',
                description: 'Select the snippet and copy it yourself.',
                variant: 'destructive',
            });
        }
    };

    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1500);
        return () => window.clearTimeout(timer);
    }, [copied]);

    return (
        <div className="rounded-md border border-border/80 p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-[11px] text-muted-foreground font-mono truncate">{file}</p>
                </div>
                <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" onClick={() => void copy()}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    <span className="ml-1 text-xs">{copied ? 'Copied' : 'Copy'}</span>
                </Button>
            </div>
            <pre className="max-h-36 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-snug font-mono whitespace-pre-wrap">
                {text.trim()}
            </pre>
        </div>
    );
}

/** "Let agents make small changes without asking", for the connection on screen. */
function DirectWritesSetting({ connection }: { connection: ActiveConnection | null }) {
    const { directWrites, setDirectWrites } = useDirectWrites(connection);
    const [draft, setDraft] = useState(String(directWrites?.maxRows ?? DEFAULT_DIRECT_LIMIT));
    useEffect(() => {
        if (directWrites) setDraft(String(directWrites.maxRows));
    }, [directWrites]);

    const unavailable = !connection
        ? 'Connect to a database first.'
        : connection.production
          ? 'Not available on a connection tagged production.'
          : null;

    const commit = () => {
        const next = clampDirectLimit(Number(draft));
        setDraft(String(next));
        if (directWrites && next !== directWrites.maxRows) setDirectWrites({ maxRows: next });
    };

    return (
        <div className="rounded-md border border-border/80 px-3 py-2.5 space-y-2">
            <label className="flex items-start gap-3 cursor-pointer">
                <Switch
                    checked={directWrites !== null}
                    disabled={unavailable !== null}
                    onCheckedChange={(on) =>
                        setDirectWrites(on ? { maxRows: clampDirectLimit(Number(draft)) } : null)
                    }
                    className="mt-0.5"
                    aria-label="Let agents make small changes without asking"
                />
                <span className="min-w-0 space-y-1">
                    <span className="block text-sm font-medium">Let agents make small changes without asking</span>
                    <span className="block text-xs text-muted-foreground leading-relaxed">
                        On this connection, an agent&apos;s <code className="font-mono">write</code> call
                        runs at once when it adds listed rows, or updates or deletes rows with a WHERE
                        clause, and changes no more rows than the limit below. It is still logged, and
                        Undo still works. Schema changes, writes with no WHERE, DROP, TRUNCATE, upserts
                        and anything bigger still wait for approval.
                    </span>
                    {unavailable && <span className="block text-xs text-muted-foreground">{unavailable}</span>}
                </span>
            </label>
            {directWrites && (
                <div className="flex items-center gap-2 pl-12 text-xs text-muted-foreground">
                    <span>Up to</span>
                    <Input
                        type="number"
                        min={1}
                        max={MAX_DIRECT_LIMIT}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commit();
                        }}
                        className="h-7 w-24 font-mono text-xs"
                        aria-label="Rows an agent may change in one call"
                    />
                    <span>rows per call</span>
                </div>
            )}
        </div>
    );
}

export function AgentsPanel() {
    const { connection, policy } = useSafetyPolicy();
    const { toast } = useToast();
    const [installing, setInstalling] = useState(false);
    const [approveInApp, setApproveInAppState] = useState(approveInAppEnabled);
    // The npm package until the app says where it is installed.
    const [entry, setEntry] = useState<ServerEntry>(npxServerEntry);
    const agentPolicy = mcpPolicyFromApp(policy);

    useEffect(() => {
        let cancelled = false;
        void appServerEntry()
            .then((next) => {
                if (!cancelled) setEntry(next);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    const live = Boolean(connection);

    const addToClaude = async () => {
        setInstalling(true);
        try {
            const result = await installClaudeDesktopMcp();
            toast({
                title: result.alreadyPresent ? 'Already in Claude Desktop' : 'Added to Claude Desktop',
                description:
                    'Fully quit Claude (tray too) and open a new chat. MCP servers only load at startup.',
            });
        } catch (error) {
            toast({
                title: 'Could not write Claude config',
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            });
        } finally {
            setInstalling(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="rounded-md border border-border/80 px-3 py-2.5 flex items-start gap-2.5">
                {live ? (
                    <Plug className="h-4 w-4 mt-0.5 text-positive shrink-0" />
                ) : (
                    <Unplug className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                )}
                <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">
                        {live ? 'Agents can see this connection' : 'Nothing open for agents'}
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        {connection
                            ? `${connection.label} · app ${policy}` +
                              (policy === 'yolo' ? ` → agent ${agentPolicy}` : ` · agent ${agentPolicy}`)
                            : 'Connect to a database first. The agent follows whatever is open here.'}
                    </p>
                </div>
            </div>

            <label className="rounded-md border border-border/80 px-3 py-2.5 flex items-start gap-3 cursor-pointer">
                <Switch
                    checked={approveInApp}
                    onCheckedChange={(on) => {
                        setApproveInApp(on);
                        setApproveInAppState(on);
                    }}
                    className="mt-0.5"
                    aria-label="Ask in LiteDB before an agent changes anything"
                />
                <span className="min-w-0 space-y-1">
                    <span className="block text-sm font-medium">Ask in LiteDB before an agent changes anything</span>
                    <span className="block text-xs text-muted-foreground leading-relaxed">
                        A write an agent sends shows up here with its row count and the rows it
                        changes, and runs only when you approve it, even if the agent's app runs
                        tools without asking. Off, the agent's app is the only thing that asks.
                    </span>
                </span>
            </label>

            <DirectWritesSetting connection={connection} />

            <div className="rounded-md border border-border/80 p-3 space-y-2">
                <p className="text-sm font-medium">Claude Desktop</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                    Merges <code className="font-mono">mcpServers.litedb</code> into{' '}
                    <code className="font-mono">claude_desktop_config.json</code>, including the
                    Windows Store copy when the Store version is installed. Does not touch the rest of the file.
                </p>
                <Button
                    type="button"
                    size="sm"
                    className="h-8"
                    onClick={() => void addToClaude()}
                    disabled={installing}
                >
                    {installing ? 'Writing…' : 'Add to Claude Desktop'}
                </Button>
            </div>

            <CopyRow label="Claude Code" file="terminal" text={claudeCodeCommand(entry)} />
            <CopyRow label="Cursor" file=".cursor/mcp.json" text={cursorSnippet(entry)} />
            <CopyRow label="OpenCode" file="opencode.json" text={openCodeSnippet(entry)} />
            <CopyRow label="VS Code / Copilot" file=".vscode/mcp.json" text={vsCodeSnippet(entry)} />
            <CopyRow
                label="Anyone else"
                file="claude_desktop_config.json"
                text={claudeDesktopSnippet(entry)}
            />

            <p className="text-[11px] text-muted-foreground leading-relaxed">
                The agent&apos;s app starts LiteDB itself with <code className="font-mono">--mcp</code>,
                so there is nothing else to install. Keep LiteDB open: the agent works on what is
                connected here, and while LiteDB is closed every call says to open it. After adding
                a server, restart the host. Then: “what&apos;s in this database?”, then “delete the
                shipped orders.” A write should preview and wait, that is the whole claim.
            </p>
        </div>
    );
}
