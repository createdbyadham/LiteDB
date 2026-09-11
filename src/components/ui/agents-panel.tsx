import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plug, Unplug } from 'lucide-react';
import { BaseDirectory, exists } from '@tauri-apps/plugin-fs';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Button } from './button';
import { useToast } from './use-toast';
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import { installClaudeDesktopMcp } from '@/lib/claudeDesktopMcp';
import { HANDOFF_FILENAME, mcpPolicyFromApp } from '@/lib/mcpHandoff';
import {
    claudeCodeCommand,
    claudeDesktopSnippet,
    cursorSnippet,
    openCodeSnippet,
    vsCodeSnippet,
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

export function AgentsPanel() {
    const { connection, policy } = useSafetyPolicy();
    const { toast } = useToast();
    const [handoffOnDisk, setHandoffOnDisk] = useState(false);
    const [installing, setInstalling] = useState(false);
    const agentPolicy = mcpPolicyFromApp(policy);

    const refreshHandoff = useCallback(async () => {
        try {
            setHandoffOnDisk(await exists(HANDOFF_FILENAME, { baseDir: BaseDirectory.AppLocalData }));
        } catch {
            setHandoffOnDisk(false);
        }
    }, []);

    useEffect(() => {
        void refreshHandoff();
        const sync = () => void refreshHandoff();
        window.addEventListener('sqlPolicyChanged', sync);
        window.addEventListener('mcpHandoffChanged', sync);
        return () => {
            window.removeEventListener('sqlPolicyChanged', sync);
            window.removeEventListener('mcpHandoffChanged', sync);
        };
    }, [refreshHandoff]);

    const live = Boolean(connection) && handoffOnDisk;

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
                    <Plug className="h-4 w-4 mt-0.5 text-emerald-500 shrink-0" />
                ) : (
                    <Unplug className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                )}
                <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">
                        {live ? 'Agents can see this connection' : 'No handoff yet'}
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        {connection
                            ? `${connection.label} · app ${policy}` +
                              (policy === 'yolo' ? ` → agent ${agentPolicy}` : ` · agent ${agentPolicy}`)
                            : 'Connect to a database first. The agent follows whatever is open.'}
                        {connection && !handoffOnDisk
                            ? ' Reconnect so the handoff file is written.'
                            : null}
                    </p>
                </div>
            </div>

            <div className="rounded-md border border-border/80 p-3 space-y-2">
                <p className="text-sm font-medium">Claude Desktop</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                    Merges <code className="font-mono">mcpServers.litedb</code> into{' '}
                    <code className="font-mono">claude_desktop_config.json</code>, including the
                    Windows Store copy if it exists. Does not touch the rest of the file.
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

            <CopyRow label="Claude Code" file="terminal" text={claudeCodeCommand()} />
            <CopyRow label="Cursor" file=".cursor/mcp.json" text={cursorSnippet()} />
            <CopyRow label="OpenCode" file="opencode.json" text={openCodeSnippet()} />
            <CopyRow label="VS Code / Copilot" file=".vscode/mcp.json" text={vsCodeSnippet()} />
            <CopyRow
                label="Anyone else"
                file="claude_desktop_config.json"
                text={claudeDesktopSnippet()}
            />

            <p className="text-[11px] text-muted-foreground leading-relaxed">
                After adding a server, restart the host. Then: “what&apos;s in this database?”, then
                “delete the shipped orders.” A write should preview and wait — that is the whole
                claim.
            </p>
        </div>
    );
}
