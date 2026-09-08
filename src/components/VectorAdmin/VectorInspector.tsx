import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/hooks/use-toast';
import { X, Copy, AlertTriangle, CheckCircle2, Box, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface VectorInspectorProps {
  isOpen: boolean;
  onClose: () => void;
  vectorValue: unknown;
  columnName: string;
  rowId?: string | number;
  tableName?: string;
}

// Parse vector string to array of numbers
function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'number');
  if (typeof value !== 'string') return [];
  
  const cleaned = String(value).replace(/[[\]]/g, '');
  return cleaned.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
}

// Compute statistics for a vector
function computeStats(vector: number[]) {
  if (vector.length === 0) return null;
  
  const sorted = [...vector].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = vector.reduce((a, b) => a + b, 0);
  const mean = sum / vector.length;
  const variance = vector.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / vector.length;
  const stdDev = Math.sqrt(variance);
  
  // Compute histogram (10 buckets)
  const bucketCount = 10;
  const bucketSize = (max - min) / bucketCount || 1;
  const histogram: number[] = new Array(bucketCount).fill(0);
  
  for (const value of vector) {
    const bucketIndex = Math.min(Math.floor((value - min) / bucketSize), bucketCount - 1);
    histogram[bucketIndex]++;
  }
  
  // Check for collapsed embeddings (most values near 0)
  const nearZeroCount = vector.filter(v => Math.abs(v) < 0.01).length;
  const isCollapsed = nearZeroCount / vector.length > 0.9;
  
  // Check for NaN or Inf
  const hasInvalid = vector.some(v => !isFinite(v));
  
  return {
    dimensions: vector.length,
    min,
    max,
    mean,
    stdDev,
    histogram,
    bucketSize,
    isCollapsed,
    hasInvalid,
    nearZeroCount,
    nearZeroPercent: (nearZeroCount / vector.length * 100).toFixed(1)
  };
}

// Simple histogram bar component
const HistogramBar = ({ 
  height, 
  label, 
  maxHeight = 80 
}: { 
  height: number; 
  label: string; 
  maxHeight?: number;
}) => {
  const barHeight = Math.max(2, (height / 100) * maxHeight);
  
  return (
    <div className="flex flex-col items-center gap-1">
      <div 
        className="w-6 bg-primary/80 rounded-t transition-all hover:bg-primary"
        style={{ height: `${barHeight}px` }}
        title={`${height.toFixed(1)}%`}
      />
      <span className="text-[9px] text-muted-foreground">{label}</span>
    </div>
  );
};

export const VectorInspector = ({
  isOpen,
  onClose,
  vectorValue,
  columnName,
  rowId,
  tableName
}: VectorInspectorProps) => {
  const vector = useMemo(() => parseVector(vectorValue), [vectorValue]);
  const stats = useMemo(() => computeStats(vector), [vector]);
  
  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(vector));
    toast({
      title: "Copied",
      description: "Vector copied as JSON array",
    });
  };
  
  const handleCopyPgVector = () => {
    navigator.clipboard.writeText(`[${vector.join(',')}]`);
    toast({
      title: "Copied",
      description: "Vector copied in pgvector format",
    });
  };
  
  if (!isOpen) return null;
  
  // Get dimension label
  const getDimensionLabel = (dims: number) => {
    if (dims === 1536) return 'OpenAI ada-002';
    if (dims === 3072) return 'OpenAI text-embedding-3-large';
    if (dims === 768) return 'BERT / MPNet';
    if (dims === 384) return 'MiniLM / Small Models';
    if (dims === 1024) return 'Cohere / Medium Models';
    if (dims === 256) return 'Small / Custom';
    return 'Custom';
  };
  
  return (
    <div className={cn(
      "fixed right-0 top-0 h-full w-96 bg-background border-l shadow-xl z-50",
      "animate-in slide-in-from-right duration-200"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <Box className="w-5 h-5 text-primary" />
          <h2 className="font-semibold">Vector Inspector</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>
      
      <ScrollArea className="h-[calc(100%-65px)]">
        <div className="p-4 space-y-6">
          {/* Metadata */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">Metadata</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-muted-foreground">Column:</div>
              <div className="font-mono">{columnName}</div>
              {tableName && (
                <>
                  <div className="text-muted-foreground">Table:</div>
                  <div className="font-mono">{tableName}</div>
                </>
              )}
              {rowId !== undefined && (
                <>
                  <div className="text-muted-foreground">Row ID:</div>
                  <div className="font-mono">{String(rowId)}</div>
                </>
              )}
            </div>
          </div>
          
          <Separator />
          
          {/* Dimensions */}
          {stats && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">Dimensions</h3>
              <div className="flex items-center gap-3">
                <span className="text-3xl font-bold">{stats.dimensions}</span>
                <Badge variant="secondary" className="text-xs">
                  {getDimensionLabel(stats.dimensions)}
                </Badge>
              </div>
            </div>
          )}
          
          <Separator />
          
          {/* Health Indicators */}
          {stats && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">Health Check</h3>
              <div className="space-y-2">
                {stats.isCollapsed ? (
                  <div className="flex items-center gap-2 text-amber-500">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="text-sm">
                      Collapsed Embeddings ({stats.nearZeroPercent}% near zero)
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-green-500">
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="text-sm">Embeddings look healthy</span>
                  </div>
                )}
                {stats.hasInvalid && (
                  <div className="flex items-center gap-2 text-red-500">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="text-sm">Contains NaN or Infinity values</span>
                  </div>
                )}
              </div>
            </div>
          )}
          
          <Separator />
          
          {/* Statistics */}
          {stats && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">Statistics</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">Min</div>
                  <div className="font-mono text-sm">{stats.min.toFixed(6)}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">Max</div>
                  <div className="font-mono text-sm">{stats.max.toFixed(6)}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">Mean</div>
                  <div className="font-mono text-sm">{stats.mean.toFixed(6)}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="text-xs text-muted-foreground">Std Dev</div>
                  <div className="font-mono text-sm">{stats.stdDev.toFixed(6)}</div>
                </div>
              </div>
            </div>
          )}
          
          <Separator />
          
          {/* Histogram */}
          {stats && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-muted-foreground">
                  Value Distribution
                </h3>
              </div>
              <div className="bg-muted/30 rounded-lg p-4">
                <div className="flex items-end justify-between gap-1 h-24">
                  {stats.histogram.map((count, i) => {
                    const percent = (count / vector.length) * 100;
                    const rangeStart = stats.min + i * stats.bucketSize;
                    return (
                      <HistogramBar
                        key={i}
                        height={percent}
                        label={rangeStart.toFixed(2)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          
          <Separator />
          
          {/* Actions */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">Export</h3>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleCopyJson}
                className="flex-1"
              >
                <Copy className="w-3.5 h-3.5 mr-1.5" />
                Copy as JSON
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleCopyPgVector}
                className="flex-1"
              >
                <Copy className="w-3.5 h-3.5 mr-1.5" />
                pgvector format
              </Button>
            </div>
          </div>
          
          {/* Raw Preview */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              Raw Values (first 20)
            </h3>
            <div className="bg-muted/30 rounded-lg p-3 max-h-40 overflow-auto">
              <code className="text-xs font-mono break-all">
                [{vector.slice(0, 20).map(v => v.toFixed(6)).join(', ')}
                {vector.length > 20 ? ', ...' : ''}]
              </code>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
};

export default VectorInspector;
