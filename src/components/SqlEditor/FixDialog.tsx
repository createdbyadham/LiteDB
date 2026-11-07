import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface FixState {
  original: string;
  error: string;
  fixed: string | null;
  loading: boolean;
  failure: string | null;
}

/** Shows what "Fix with AI" would change before anything in the editor does. */
export function FixDialog({
  state,
  onApply,
  onClose,
}: {
  state: FixState | null;
  onApply: (sql: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-key" /> Fix with AI
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-destructive whitespace-pre-wrap">{state?.error}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">Yours</span>
            <pre className="max-h-72 min-h-[120px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs">{state?.original}</pre>
          </div>
          <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">Suggested</span>
            <div className="max-h-72 min-h-[120px] overflow-auto rounded-md border border-key/40 bg-key/5 p-3">
              {state?.loading ? (
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking the model, then checking that its answer compiles…
                </span>
              ) : state?.failure ? (
                <span className="text-xs text-destructive">{state.failure}</span>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs">{state?.fixed}</pre>
              )}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Applying puts the suggestion in the editor. Nothing runs until you run it, and it is treated as AI-written by the safety
          layer.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Discard
          </Button>
          <Button onClick={() => state?.fixed && onApply(state.fixed)} disabled={!state?.fixed || state.loading}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
