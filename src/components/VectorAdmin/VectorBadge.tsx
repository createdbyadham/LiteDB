import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Portal } from '@radix-ui/react-portal';
import { Box } from 'lucide-react';
import { cn } from '@/lib/utils';

interface VectorBadgeProps {
  value: string | number[] | unknown;
  dimensions: number;
  onClick?: () => void;
  className?: string;
}

// Parse vector string to array of numbers
function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'number');
  if (typeof value !== 'string') return [];
  
  // Vector format is like "[0.1,0.2,0.3]" or just "0.1,0.2,0.3"
  const cleaned = String(value).replace(/[\[\]]/g, '');
  return cleaned.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
}

// Format a number for display (max 4 decimal places)
function formatNum(n: number): string {
  return n.toFixed(4).replace(/\.?0+$/, '');
}

export const VectorBadge = ({ value, dimensions, onClick, className }: VectorBadgeProps) => {
  const [isHovered, setIsHovered] = useState(false);
  
  const vector = parseVector(value);
  const previewValues = vector.slice(0, 3);
  const displayDims = dimensions || vector.length;
  
  // Determine badge color based on dimensions (common embedding sizes)
  const getBadgeVariant = () => {
    if (displayDims === 1536) return 'default'; // OpenAI ada-002
    if (displayDims === 3072) return 'default'; // OpenAI text-embedding-3-large
    if (displayDims === 768) return 'secondary'; // BERT, many local models
    if (displayDims === 384) return 'secondary'; // MiniLM, small models
    if (displayDims === 1024) return 'secondary'; // Cohere, some models
    return 'outline';
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={getBadgeVariant()}
            className={cn(
              "cursor-pointer transition-all font-mono text-xs gap-1",
              isHovered && "ring-2 ring-primary/50",
              className
            )}
            onClick={onClick}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <Box className="w-3 h-3" />
            <span>VECTOR: {displayDims} dims</span>
          </Badge>
        </TooltipTrigger>
        <Portal>
          <TooltipContent 
            side="top" 
            className="max-w-xs z-[9999] font-mono text-xs"
            sideOffset={5}
          >
            <div className="space-y-1">
              <div className="text-muted-foreground">First 3 values:</div>
              <div className="font-semibold">
                [{previewValues.map(formatNum).join(', ')}
                {vector.length > 3 ? ', ...' : ''}]
              </div>
              <div className="text-muted-foreground text-[10px] mt-1">
                Click to inspect
              </div>
            </div>
          </TooltipContent>
        </Portal>
      </Tooltip>
    </TooltipProvider>
  );
};

export default VectorBadge;
