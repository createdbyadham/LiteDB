import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { aiService } from '@/lib/aiService';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

interface AiQueryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Receives the generated SQL and the request it came from. The prompt is
   * passed through so the audit log can record what was asked for, not just
   * what was produced — an entry saying the model removed rows from `orders`
   * is far less useful than one that also says the user asked to "clear out
   * the old orders".
   */
  onQueryGenerated: (query: string, prompt: string) => void;
  /**
   * Compiles a generated statement and returns the engine's error, or null if
   * it is valid. Supplying this enables self-correction: SQL that does not
   * compile is sent back to the model once with the real error, before it
   * reaches the editor.
   *
   * It compiles rather than executes, so it checks writes as well as reads —
   * catching an unknown column in an UPDATE is the whole point, and that is
   * exactly what a read-only dry run could never do.
   */
  validate?: (sql: string) => Promise<string | null>;
}

export function AiQueryDialog({
  open,
  onOpenChange,
  onQueryGenerated,
  validate,
}: AiQueryDialogProps) {
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    
    setIsLoading(true);
    try {
      const query = await aiService.generateSqlQuery(prompt, validate);
      onQueryGenerated(query, prompt);
      onOpenChange(false);
      setPrompt('');
    } catch (error) {
      console.error('Failed to generate query:', error);
      toast({
        variant: "destructive",
        title: "Failed to generate SQL query",
        description: error instanceof Error 
          ? error.message 
          : "Please check your AI provider settings and try again.",
      });
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
            className="min-h-[100px] text-sm resize-none"
          />
          <Button onClick={handleGenerate} disabled={isLoading || !prompt.trim()} size="sm" className="w-full">
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Generate SQL
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
