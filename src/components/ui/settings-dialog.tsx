import { Button } from "./button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog"
import { Input } from "./input"
import { Label } from "./label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select"
import { Settings2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useToast } from "./use-toast"
import { AIProvider, AISettings, defaultSettings } from "@/lib/aiService"

export function SettingsDialog() {
  const [settings, setSettings] = useState<AISettings>(defaultSettings);
  const { toast } = useToast();

  useEffect(() => {
    // Load saved settings on component mount
    const savedSettings = localStorage.getItem('aiSettings');
    if (savedSettings) {
      const parsed = JSON.parse(savedSettings);
      
      // Migration for old settings format
      if (!parsed.configs) {
        const oldSettings = parsed as any;
        const newSettings = { ...defaultSettings };
        
        if (oldSettings.provider) {
          newSettings.activeProvider = oldSettings.provider;
          // Only migrate if we have a valid provider
          if (newSettings.configs[oldSettings.provider as AIProvider]) {
            newSettings.configs[oldSettings.provider as AIProvider] = {
              apiKey: oldSettings.apiKey || '',
              endpoint: oldSettings.endpoint,
              modelName: oldSettings.modelName
            };
          }
        }
        setSettings(newSettings);
      } else {
        setSettings(parsed);
      }
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem('aiSettings', JSON.stringify(settings));
    window.dispatchEvent(new Event('aiSettingsChanged'));
    toast({
      title: "Settings saved",
      description: "Your AI provider settings have been saved successfully.",
    });
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

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-12 rounded-none hover:bg-muted/50">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>AI Provider Settings</DialogTitle>
          <DialogDescription>
            Configure your AI provider settings. These will be saved for future use.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
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
        </div>
        <DialogFooter>
          <Button onClick={handleSave}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
} 