import { Minus, Square, X } from 'lucide-react';
import { Button } from './ui/button';
import icon from '/titlebaricon2.png';

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
    <div className="h-9 flex items-center justify-between bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b select-none">
      {/* Draggable area */}
      <div className="flex-1 app-drag-handle h-full flex items-center px-4">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3">
            <img src={icon} alt="App Icon" className="w-auto h-auto" />
          </div>
          <span className="text-xs font-medium">LightDB</span>
        </div>
      </div>

      {/* Window controls */}
      <div className="flex items-center h-full">
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-12 rounded-none hover:bg-muted/50"
          onClick={handleMinimize}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-12 rounded-none hover:bg-muted/50"
          onClick={handleMaximize}
        >
          <Square className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-12 rounded-none hover:bg-destructive/90 hover:text-destructive-foreground"
          onClick={handleClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export default TitleBar; 