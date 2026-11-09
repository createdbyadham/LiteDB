import { Button } from "./button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog"
import { Input } from "./input"
import { Label } from "./label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select"
import { Switch } from "./switch"
import { Settings2, Copy, Download, ChevronDown, RefreshCw, Check, X, Loader2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useToast } from "@/hooks/use-toast"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu"
import { aiService, AIProvider, AISettings, defaultSettings, loadAISettingsAsync, needsEndpoint, saveNonSecretSettings } from "@/lib/aiService"
import { storeAllApiKeys } from "@/lib/secretStorage"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"
import { AgentsPanel } from "./agents-panel"
import { StarSettings } from "@/components/Mascot/StarSettings"
import { appLogDir } from '@tauri-apps/api/path'
import { readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { save } from '@tauri-apps/plugin-dialog'

/** Outcome of the last connection test, for the button beside the model field. */
type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; model: string }
  | { status: 'failed'; error: string };

export function SettingsDialog() {
  const [settings, setSettings] = useState<AISettings>(defaultSettings);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('ai');
  const { toast } = useToast();

  const [models, setModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const modelsRequest = useRef(0);
  const testRequest = useRef(0);

  useEffect(() => {
    void loadAISettingsAsync().then(setSettings);
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const next = (event as CustomEvent<{ tab?: string }>).detail?.tab ?? 'ai';
      setTab(next);
      setOpen(true);
    };
    window.addEventListener('openSettings', onOpen);
    return () => window.removeEventListener('openSettings', onOpen);
  }, []);

  const handleSave = async () => {
    try {
      await storeAllApiKeys(
        Object.fromEntries(
          (Object.keys(settings.configs) as AIProvider[]).map((provider) => [
            provider,
            settings.configs[provider].apiKey,
          ]),
        ) as Record<AIProvider, string>,
      );
      saveNonSecretSettings(settings);
      window.dispatchEvent(new Event('aiSettingsChanged'));
      toast({
        title: "Settings saved",
      });
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast({
        title: "Error",
        description: "Settings were not saved. Try again",
        variant: "destructive",
      });
    }
  };

  const currentConfig = settings.configs[settings.activeProvider];

  const updateCurrentConfig = (updates: Partial<typeof currentConfig>) => {
    setSettings(prev => ({
      ...prev,
      configs: {
        ...prev.configs,
        [prev.activeProvider]: {
          ...prev.configs[prev.activeProvider],
          ...updates
        }
      }
    }));
    // Any edit invalidates the last result. Leaving a green tick next to a key
    // that has since been retyped is worse than showing nothing.
    setTest({ status: 'idle' });
  };

  /**
   * Ask the provider what models it has.
   *
   * Uses the config currently on screen, not the saved one, so a key typed a
   * moment ago works without saving first. Never throws, a provider that
   * cannot list its models is a normal outcome, and the field stays typeable.
   */
  const loadModels = useCallback(async () => {
    const provider = settings.activeProvider;
    const config = settings.configs[provider];
    const request = ++modelsRequest.current;
    setIsLoadingModels(true);
    setModelsError(null);
    try {
      const found = await aiService.listModels(provider, config);
      if (request !== modelsRequest.current) return;
      setModels(found);
      if (found.length === 0) {
        setModelsError('This provider returned no models. Type the name instead.');
      }
    } catch (error) {
      if (request !== modelsRequest.current) return;
      setModels([]);
      setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === modelsRequest.current) setIsLoadingModels(false);
    }
  }, [settings]);

  // Switching provider invalidates both the model list and the test result:
  // they belong to the provider that was selected when they were produced.
  useEffect(() => {
    modelsRequest.current += 1;
    testRequest.current += 1;
    setModels([]);
    setModelsError(null);
    setIsLoadingModels(false);
    setTest({ status: 'idle' });
  }, [settings.activeProvider]);

  const runTest = async () => {
    const provider = settings.activeProvider;
    const request = ++testRequest.current;
    setTest({ status: 'testing' });
    const result = await aiService.testConnection(
      provider,
      settings.configs[provider],
    );
    if (request !== testRequest.current) return;
    setTest(
      result.ok
        ? { status: 'ok', model: result.model ?? '' }
        : { status: 'failed', error: result.error ?? 'Unknown error' },
    );
  };

  const getLogsContent = async (): Promise<
    { ok: true; content: string } | { ok: false; error: string; empty?: boolean }
  > => {
    try {
      const logDir = await appLogDir();
      const entries = await readDir(logDir);
      const logFiles = entries.filter((e) => e.name.endsWith('.log'));

      if (logFiles.length === 0) {
        return { ok: false, error: 'No log files exist yet.', empty: true };
      }

      let allLogs = '';
      for (const file of logFiles) {
        const content = await readTextFile(`${logDir}/${file.name}`);
        allLogs += `\n--- ${file.name} ---\n${content}`;
      }

      if (!allLogs.trim()) {
        return { ok: false, error: 'Log files are currently empty.', empty: true };
      }

      return { ok: true, content: allLogs.trimStart() };
    } catch (e) {
      console.error('Failed to read logs:', e);
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Could not read logs: ${message}` };
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await writeText(text);
      return;
    } catch (primaryErr) {
      console.warn('Plugin clipboard write failed, trying navigator.clipboard:', primaryErr);
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      throw primaryErr;
    }
  };

  const handleCopyLogs = async () => {
    const result = await getLogsContent();
    if (!result.ok) {
      toast({
        title: result.empty ? 'No logs' : 'Error',
        description: result.error,
        variant: result.empty ? 'default' : 'destructive',
      });
      return;
    }
    try {
      await copyToClipboard(result.content);
      toast({ title: 'Copied', description: 'Logs copied to clipboard' });
    } catch (e) {
      console.error(e);
      const detail = e instanceof Error ? e.message : String(e);
      toast({
        title: 'Error',
        description: `Failed to copy logs to clipboard: ${detail}`,
        variant: 'destructive',
      });
    }
  };

  const handleExportLogs = async () => {
    const result = await getLogsContent();
    if (!result.ok) {
      toast({
        title: result.empty ? 'No logs' : 'Error',
        description: result.error,
        variant: result.empty ? 'default' : 'destructive',
      });
      return;
    }

    try {
      const path = await save({
        filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }],
        defaultPath: 'LiteDB_Logs.log',
      });

      if (path) {
        await writeTextFile(path, result.content);
        toast({ title: 'Logs exported', description: path });
      }
    } catch (e) {
      console.error(e);
      const detail = e instanceof Error ? e.message : String(e);
      toast({
        title: 'Error',
        description: `Failed to save logs: ${detail}`,
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-11 rounded-none text-current opacity-70 hover:opacity-100 hover:bg-foreground/10" aria-label="Settings" title="Settings">
          <Settings2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="space-y-1 px-6 pb-4 pt-6">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            AI provider, connected agents, Star and logs
          </DialogDescription>
        </DialogHeader>
        
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 w-full flex-1 flex-col">
          <div className="px-6">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="ai">AI provider</TabsTrigger>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="star">Star</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="ai" className="mt-0 min-h-0 space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={settings.activeProvider}
                onValueChange={(value: AIProvider) => {
                  setSettings(prev => ({
                    ...prev,
                    activeProvider: value
                  }));
                }}
              >
                <SelectTrigger id="provider">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="gemini">Google Gemini</SelectItem>
                  <SelectItem value="openai-compatible">OpenAI compatible</SelectItem>
                  <SelectItem value="ollama">Ollama (local)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {settings.activeProvider !== 'ollama' && (
              <div className="space-y-1.5">
                <Label htmlFor="apiKey">
                  {settings.activeProvider === 'openai-compatible' ? 'API key (optional)' : 'API key'}
                </Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={currentConfig.apiKey}
                  onChange={(e) => updateCurrentConfig({ apiKey: e.target.value })}
                  placeholder={settings.activeProvider === 'openai-compatible' ? 'if the server requires one' : ''}
                />
              </div>
            )}

            {needsEndpoint(settings.activeProvider) && (
              <div className="space-y-1.5">
                <Label htmlFor="endpoint">Endpoint</Label>
                <Input
                  id="endpoint"
                  type="text"
                  value={currentConfig.endpoint || ''}
                  onChange={(e) => updateCurrentConfig({ endpoint: e.target.value })}
                  placeholder={
                    settings.activeProvider === 'ollama'
                      ? 'http://localhost:11434/v1'
                      : 'https://api.groq.com/openai/v1'
                  }
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="modelName">Model</Label>
              <div className="flex gap-2">
                {/* Still an input, not a dropdown. The list is discovery,
                    not a constraint, a model released this morning must
                    remain typeable even if the provider has not listed it. */}
                <Input
                  id="modelName"
                  type="text"
                  value={currentConfig.modelName || ''}
                  onChange={(e) => updateCurrentConfig({ modelName: e.target.value })}
                  className="min-w-0 flex-1"
                  placeholder={
                    settings.activeProvider === 'ollama'
                      ? 'llama3'
                      : settings.activeProvider === 'openai'
                        ? 'gpt-4o-mini'
                        : settings.activeProvider === 'anthropic'
                          ? 'claude-sonnet-5-5'
                          : settings.activeProvider === 'gemini'
                            ? 'gemini-2.5-flash'
                            : 'model id'
                  }
                />
                {/* modal={false}: a modal dropdown + body { overflow: hidden }
                    eats wheel events, so the model list cannot scroll. */}
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-10 shrink-0"
                      onClick={() => {
                        if (models.length === 0 && !isLoadingModels) void loadModels();
                      }}
                    >
                      {isLoadingModels ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                      <span className="ml-1.5 text-xs">Browse</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={6}
                    collisionPadding={12}
                    className="w-80 p-0"
                  >
                    <div className="flex items-center justify-between px-2.5 py-2 border-b">
                      <span className="text-[11px] text-muted-foreground">
                        {isLoadingModels
                          ? 'Loading…'
                          : models.length > 0
                            ? `${models.length} available`
                            : 'No models listed'}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void loadModels();
                        }}
                        className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                      >
                        <RefreshCw
                          className={`h-3 w-3 ${isLoadingModels ? 'animate-spin' : ''}`}
                        />
                        Refresh
                      </button>
                    </div>
                    {modelsError && (
                      <p className="px-2.5 py-2 text-[11px] text-muted-foreground leading-snug">
                        {modelsError}
                      </p>
                    )}
                    {models.length > 0 && (
                      <div
                        className="max-h-60 overflow-y-auto overscroll-contain py-1"
                        onWheel={(event) => event.stopPropagation()}
                      >
                        {models.map((model) => (
                          <DropdownMenuItem
                            key={model}
                            title={model}
                            onSelect={() => updateCurrentConfig({ modelName: model })}
                            className="font-mono text-xs"
                          >
                            <span className="truncate">{model}</span>
                          </DropdownMenuItem>
                        ))}
                      </div>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="flex items-start gap-2 pt-0.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => void runTest()}
                  disabled={test.status === 'testing'}
                >
                  {test.status === 'testing' && (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  )}
                  Test connection
                </Button>
                {test.status === 'testing' && settings.activeProvider === 'ollama' && (
                  // Measured at 19s for a cold 7B on this machine: Ollama
                  // loads the model into VRAM on the first request. Without
                  // this line the button just sits there and looks broken.
                  <span className="text-[11px] text-muted-foreground leading-snug">
                    A local model may take a while to load the first time.
                  </span>
                )}
                {test.status === 'ok' && (
                  <span className="text-[11px] text-positive flex items-center gap-1 leading-snug">
                    <Check className="h-3.5 w-3.5 shrink-0" />
                    {test.model} responded
                  </span>
                )}
                {test.status === 'failed' && (
                  <span className="min-w-0 text-[11px] text-destructive flex items-start gap-1 leading-snug">
                    <X className="h-3.5 w-3.5 shrink-0 mt-px" />
                    {test.error}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
              <Switch
                id="sampleValues"
                className="mt-0.5"
                checked={settings.includeSampleValues}
                onCheckedChange={(checked) =>
                  setSettings((prev) => ({ ...prev, includeSampleValues: checked }))
                }
              />
              <div className="min-w-0 space-y-1">
                <Label htmlFor="sampleValues">Sample values</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Sends a few values from short columns (status, country) so
                  &quot;Germany&quot; can match stored &quot;DE&quot;. Emails, keys,
                  and PII-looking columns are skipped. Reconnect to apply.
                </p>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border px-4 py-3">
              <div className="flex items-start gap-3">
                <Switch
                  id="inlineSuggestions"
                  className="mt-0.5"
                  checked={settings.inlineSuggestions}
                  onCheckedChange={(checked) =>
                    setSettings((prev) => ({ ...prev, inlineSuggestions: checked }))
                  }
                />
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="inlineSuggestions">Inline suggestions</Label>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Grey text after the cursor in the SQL editor: Tab accepts
                    it, Esc dismisses it. Each pause in typing sends the
                    statement you are writing and your table names, with the
                    columns of the tables it uses, to this provider. Always off
                    on connections tagged production.
                  </p>
                </div>
              </div>
              {settings.inlineSuggestions && (
                <div className="space-y-1.5 pl-14">
                  <Label htmlFor="inlineModelName" className="text-xs">
                    Model for suggestions (optional)
                  </Label>
                  <Input
                    id="inlineModelName"
                    type="text"
                    value={currentConfig.inlineModelName || ''}
                    onChange={(e) => updateCurrentConfig({ inlineModelName: e.target.value })}
                    placeholder={currentConfig.modelName ? `Same as Model (${currentConfig.modelName})` : 'Same as Model'}
                  />
                  {settings.activeProvider === 'ollama' && (
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      A fill-in-the-middle model such as qwen2.5-coder:1.5b
                      completes best and fastest. Other models are asked
                      through chat.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <Button onClick={handleSave}>Save changes</Button>
            </div>
          </TabsContent>

          <TabsContent value="agents" className="mt-0 min-h-0 overflow-y-auto px-6 py-5">
            <AgentsPanel />
          </TabsContent>

          <TabsContent value="star" className="mt-0 min-h-0 overflow-y-auto px-6 py-5">
            <StarSettings />
          </TabsContent>

          <TabsContent value="logs" className="mt-0 min-h-0 overflow-y-auto px-6 py-5">
            <div className="rounded-lg border p-4">
              <h4 className="mb-1.5 text-sm font-medium">Export error logs</h4>
              <p className="mb-4 text-xs text-muted-foreground leading-relaxed">
                Attach these to a bug report if something is going wrong.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleCopyLogs} className="flex-1">
                  <Copy className="h-4 w-4" strokeWidth={1.5} />
                  Copy
                </Button>
                <Button variant="outline" size="sm" onClick={handleExportLogs} className="flex-1">
                  <Download className="h-4 w-4" strokeWidth={1.5} />
                  Export
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}