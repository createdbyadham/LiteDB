import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { aiService } from '@/lib/aiService';
import { Loader2 } from 'lucide-react';

interface AiQueryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onQueryGenerated: (query: string) => void;
}

export function AiQueryDialog({ open, onOpenChange, onQueryGenerated }: AiQueryDialogProps) {
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    
    setIsLoading(true);
    try {
      const query = await aiService.generateSqlQuery(prompt);
      onQueryGenerated(query);
      onOpenChange(false);
      setPrompt('');
    } catch (error) {
      console.error('Failed to generate query:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>AI SQL Assistant</DialogTitle>
          <DialogDescription>
            Describe what you want to do in natural language, and I'll convert it to SQL.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <Textarea
            placeholder="e.g., Show me all users who signed up in the last month"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="min-h-[100px]"
          />
          <Button onClick={handleGenerate} disabled={isLoading || !prompt.trim()}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Generate SQL
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
} 