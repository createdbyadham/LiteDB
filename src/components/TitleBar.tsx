import { Minus, Square, X, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { SettingsDialog } from "./ui/settings-dialog";

const TitleBar = () => {
  const handleMinimize = () => {
    window.electron?.minimizeWindow();
  };

  const handleMaximize = () => {
    window.electron?.maximizeWindow();
  };

  const handleClose = () => {
    window.electron?.closeWindow();
  };

  return (
    <div className="h-8 flex items-center justify-between bg-sidebar border-b border-sidebar-border select-none shrink-0">
      {/* Draggable area */}
      <div className="flex-1 app-drag-handle h-full flex items-center">
        {/* Empty draggable area */}
      </div>

      {/* Window controls */}
      <div className="flex items-center h-full">
        <SettingsDialog />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-11 rounded-none hover:bg-muted/50 text-muted-foreground hover:text-foreground"
          onClick={handleMinimize}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-11 rounded-none hover:bg-muted/50 text-muted-foreground hover:text-foreground"
          onClick={handleMaximize}
        >
          <Copy className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-11 rounded-none hover:bg-destructive hover:text-destructive-foreground text-muted-foreground"
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
};

export default TitleBar; 