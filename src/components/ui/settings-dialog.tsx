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
import { Settings2, Copy, Download } from "lucide-react"
import { useEffect, useState } from "react"
import { useToast } from "./use-toast"
import { AIProvider, AISettings, defaultSettings, loadAISettingsAsync, saveNonSecretSettings } from "@/lib/aiService"
import { storeAllApiKeys } from "@/lib/secretStorage"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"
import { appLogDir } from '@tauri-apps/api/path'
import { readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { save } from '@tauri-apps/plugin-dialog'

export function SettingsDialog() {
  const [settings, setSettings] = useState<AISettings>(defaultSettings);
  const { toast } = useToast();

  useEffect(() => {
    void loadAISettingsAsync().then(setSettings);
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
        description: "Your AI provider settings have been saved successfully.",
      });
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast({
        title: "Error",
        description: "Failed to save settings. Please try again.",
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
  };

  const getLogsContent = async () => {
    try {
      const logDir = await appLogDir();
      const entries = await readDir(logDir);
      const logFiles = entries.filter(e => e.name.endsWith('.log'));
      
      if (logFiles.length === 0) return null;

      let allLogs = '';
      for (const file of logFiles) {
        const content = await readTextFile(`${logDir}/${file.name}`);
        allLogs += `\n--- ${file.name} ---\n${content}`;
      }
      return allLogs;
    } catch (e) {
      console.error("Failed to read logs:", e);
      return null;
    }
  };

  const handleCopyLogs = async () => {
    const logs = await getLogsContent();
    if (!logs) {
      toast({ title: "Error", description: "No logs found or failed to read", variant: "destructive" });
      return;
    }
    try {
      await writeText(logs);
      toast({ title: "Copied", description: "Logs copied to clipboard" });
    } catch (e) {
      console.error(e);
      toast({ title: "Error", description: "Failed to copy logs", variant: "destructive" });
    }
  };

  const handleExportLogs = async () => {
    const logs = await getLogsContent();
    if (!logs) {
      toast({ title: "Error", description: "No logs found or failed to read", variant: "destructive" });
      return;
    }

    try {
      const path = await save({
        filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }],
        defaultPath: 'LiteDB_Logs.log'
      });
      
      if (path) {
        await writeTextFile(path, logs);
        toast({ title: "Success", description: "Logs exported successfully" });
      }
    } catch (e) {
      console.error(e);
      toast({ title: "Error", description: "Failed to save logs", variant: "destructive" });
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-12 rounded-none hover:bg-muted/50">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Manage application settings and configurations.
          </DialogDescription>
        </DialogHeader>
        
        <Tabs defaultValue="ai" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="ai">AI Provider</TabsTrigger>
            <TabsTrigger value="logs">Logs & Debug</TabsTrigger>
          </TabsList>

          <TabsContent value="ai" className="space-y-4 py-4">
            <div className="grid gap-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="provider" className="text-right">
                  Provider
                </Label>
                <Select 
                  value={settings.activeProvider}
                  onValueChange={(value: AIProvider) => {
                    setSettings(prev => ({ 
                      ...prev, 
                      activeProvider: value
                    }));
                  }}
                >
                  <SelectTrigger className="col-span-3">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="azure">Azure OpenAI</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="ollama">Ollama (Local)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="apiKey" className="text-right">
                  API Key
                </Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={currentConfig.apiKey}
                  onChange={(e) => updateCurrentConfig({ apiKey: e.target.value })}
                  className="col-span-3"
                />
              </div>
              {settings.activeProvider !== 'openai' && (
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="endpoint" className="text-right">
                    Endpoint
                  </Label>
                  <Input
                    id="endpoint"
                    type="text"
                    value={currentConfig.endpoint || ''}
                    onChange={(e) => updateCurrentConfig({ endpoint: e.target.value })}
                    className="col-span-3"
                    placeholder={settings.activeProvider === 'ollama' ? 'http://localhost:11434/v1' : ''}
                  />
                </div>
              )}
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="modelName" className="text-right">
                  Model Name
                </Label>
                <Input
                  id="modelName"
                  type="text"
                  value={currentConfig.modelName || ''}
                  onChange={(e) => updateCurrentConfig({ modelName: e.target.value })}
                  className="col-span-3"
                  placeholder={settings.activeProvider === 'ollama' ? 'llama3' : 'gpt-4'}
                />
              </div>
              <div className="grid grid-cols-4 items-start gap-4">
                <Label htmlFor="sampleValues" className="text-right pt-1">
                  Sample Values
                </Label>
                <div className="col-span-3 flex items-start gap-3">
                  <Switch
                    id="sampleValues"
                    checked={settings.includeSampleValues}
                    onCheckedChange={(checked) =>
                      setSettings((prev) => ({ ...prev, includeSampleValues: checked }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Send a few example values from short, low-cardinality text columns
                    (e.g. status, country) so the AI can match &quot;Germany&quot; to a
                    stored &quot;DE&quot;. Columns that look like emails, keys or personal
                    data are never sampled. Turn this off to send column names and types
                    only. Reconnect for the change to take effect.
                  </p>
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <Button onClick={handleSave}>Save changes</Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="logs" className="space-y-4 py-4">
            <div className="space-y-4">
              <div className="rounded-md bg-muted p-4">
                <h4 className="mb-2 text-sm font-medium">Export Error Logs</h4>
                <p className="text-xs text-muted-foreground mb-4">
                  If you're experiencing issues, you can export the application logs to attach to a bug report.
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleCopyLogs} className="flex-1">
                    <Copy className="mr-2 h-4 w-4" />
                    Copy to Clipboard
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExportLogs} className="flex-1">
                    <Download className="mr-2 h-4 w-4" />
                    Export to File
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}