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

type AIProvider = 'github' | 'azure' | 'openai';
type AISettings = {
  provider: AIProvider;
  apiKey: string;
  endpoint?: string;
};

const defaultSettings: AISettings = {
  provider: 'github',
  apiKey: '',
  endpoint: 'https://models.github.ai/inference'
};

export function SettingsDialog() {
  const [settings, setSettings] = useState<AISettings>(defaultSettings);
  const { toast } = useToast();

  useEffect(() => {
    // Load saved settings on component mount
    const savedSettings = localStorage.getItem('aiSettings');
    if (savedSettings) {
      setSettings(JSON.parse(savedSettings));
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
              value={settings.provider}
              onValueChange={(value: AIProvider) => setSettings(prev => ({ 
                ...prev, 
                provider: value,
                endpoint: value === 'github' ? 'https://models.github.ai/inference' : ''
              }))}
            >
              <SelectTrigger className="col-span-3">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="github">GitHub</SelectItem>
                <SelectItem value="azure">Azure OpenAI</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
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
              value={settings.apiKey}
              onChange={(e) => setSettings(prev => ({ ...prev, apiKey: e.target.value }))}
              className="col-span-3"
            />
          </div>
          {settings.provider !== 'openai' && (
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="endpoint" className="text-right">
                Endpoint
              </Label>
              <Input
                id="endpoint"
                type="text"
                value={settings.endpoint}
                onChange={(e) => setSettings(prev => ({ ...prev, endpoint: e.target.value }))}
                className="col-span-3"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={handleSave}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
} 