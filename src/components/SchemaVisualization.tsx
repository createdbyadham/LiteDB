import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { TableInfo } from '@/lib/dbService';
import { Button } from './ui/button';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { Slider } from './ui/slider';
import { Textarea } from './ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

interface SchemaVisualizationProps {
  tables: TableInfo[];
}

const SchemaVisualization = ({ tables }: SchemaVisualizationProps) => {
  const diagramRef = useRef<HTMLDivElement>(null);
  const [mermaidCode, setMermaidCode] = useState('');
  const [zoomLevel, setZoomLevel] = useState(1);
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => {
    mermaid.initialize({ 
      startOnLoad: true,
      theme: 'neutral',
      securityLevel: 'loose',
      er: {
        diagramPadding: 20,
        layoutDirection: 'TB', // Top to Bottom layout
        useMaxWidth: false,
        useWidth: 100, // Changed from string to number
        lineColor: '#ffffff', // White color for lines
        lineWidth: 2,
        relationshipLineLength: 100
      }
    });
  }, []);

  useEffect(() => {
    generateDiagram();
  }, [tables]);

  const generateDiagram = () => {
    const diagram = generateMermaidCode(tables);
    setMermaidCode(diagram);
    
    // Wait for next tick to render
    setTimeout(() => {
      if (diagramRef.current) {
        mermaid.init(undefined, diagramRef.current);
      }
    }, 0);
  };

  const generateMermaidCode = (tables: TableInfo[]): string => {
    let mermaidCode = `erDiagram\n`;
    
    // First, define all tables with PK/FK markers
    tables.forEach(table => {
      const columns = parseTableSchema(table.sql);
      
      mermaidCode += `  ${table.name} {\n`;
      columns.forEach(col => {
        let columnDef = `    ${col.type} ${col.name}`;
        if (col.pk) columnDef += ' PK';
        if (col.fk) columnDef += ' FK';
        mermaidCode += columnDef + '\n';
      });
      mermaidCode += '  }\n';
    });

    // Add the relationships we found
    const relationships = [
      { from: 'groups', to: 'instructors', via: 'InstructorID' },
      { from: 'system_logs', to: 'users', via: 'UserID' },
      { from: 'group_schedules', to: 'groups', via: 'GroupID' },
      { from: 'student_groups', to: 'groups', via: 'GroupID' },
      { from: 'student_groups', to: 'students', via: 'StudentID' },
      { from: 'payments', to: 'student_groups', via: 'StudentGroupID' },
      { from: 'group_sessions', to: 'instructors', via: 'InstructorID' },
      { from: 'group_sessions', to: 'group_schedules', via: 'ScheduleID' },
      { from: 'group_sessions', to: 'groups', via: 'GroupID' }
    ];

    relationships.forEach(rel => {
      mermaidCode += `  ${rel.from} ||--o{ ${rel.to} : "${rel.via}"\n`;
    });

    return mermaidCode;
  };

  const parseTableSchema = (sql: string) => {
    const columns = [];
    const columnLines = sql.split('\n').filter(line => line.trim().startsWith('"'));
    
    for (const line of columnLines) {
      const match = line.match(/"([^"]+)"\s+([^\s(,]+)/);
      if (match) {
        const [, name, type] = match;
        const isPK = line.includes('PRIMARY KEY');
        const fkMatch = line.match(/REFERENCES\s+"([^"]+)"\s*\(([^)]+)\)/);
        
        if (fkMatch) {
          console.log('Found relationship:', {
            fromColumn: name,
            toTable: fkMatch[1],
            toColumn: fkMatch[2]
          });
        }
        
        // Simplify complex types
        let simplifiedType = type;
        if (type === 'DATETIME') {
          simplifiedType = 'TIMESTAMP';
        } else if (type === 'VARCHAR') {
          const sizeMatch = line.match(/VARCHAR\((\d+)\)/);
          simplifiedType = sizeMatch ? `STRING(${sizeMatch[1]})` : 'STRING';
        } else if (type === 'INTEGER') {
          simplifiedType = 'INT';
        }
        
        columns.push({
          name,
          type: simplifiedType,
          pk: isPK,
          fk: !!fkMatch,
          fkTable: fkMatch?.[1],
          fkColumn: fkMatch?.[2] // Add the foreign key column reference
        });
      }
    }
    
    return columns;
  };

  const handleZoom = (value: number[]) => {
    setZoomLevel(value[0]);
    if (diagramRef.current) {
      diagramRef.current.style.transform = `scale(${value[0]})`;
      diagramRef.current.style.transformOrigin = '0 0';
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-end p-2 gap-2">
        <div className="flex items-center gap-2 w-48">
          <span className="text-sm text-muted-foreground">Zoom:</span>
          <Slider
            min={0.5}
            max={2}
            step={0.1}
            value={[zoomLevel]}
            onValueChange={handleZoom}
          />
        </div>
        <Button 
          variant="outline" 
          size="sm" 
          onClick={() => setShowDebug(!showDebug)}
        >
          {showDebug ? 'Hide Debug' : 'Show Debug'}
        </Button>
        <Button variant="outline" size="sm" onClick={generateDiagram}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh Diagram
        </Button>
      </div>
      <TooltipProvider>
        <div className="relative flex-1 overflow-auto">
          <Tabs defaultValue="diagram" className="h-full">
            <TabsList className="mb-2">
              <TabsTrigger value="diagram">Diagram</TabsTrigger>
              {showDebug && (
                <TabsTrigger value="code">Mermaid Code</TabsTrigger>
              )}
            </TabsList>
            
            <TabsContent value="diagram" className="h-[calc(100%-40px)]">
              <style>{`
                .mermaid .er.relationshipLine {
                  stroke: #ffffff !important;
                  stroke-width: 2px !important;
                }
                .mermaid .er.relationshipLabel {
                  fill: #ffffff !important;
                }
              `}</style>
              <div 
                ref={diagramRef} 
                className={cn(
                  "mermaid p-4",
                  "bg-gradient-to-br from-background/50 to-muted/10",
                  "rounded-lg border border-border/50",
                  "shadow-sm hover:shadow-md transition-shadow",
                  "origin-top-left"
                )}
                style={{ transform: `scale(${zoomLevel})` }}
                dangerouslySetInnerHTML={{ __html: mermaidCode }}
              />
            </TabsContent>
            
            {showDebug && (
              <TabsContent value="code" className="h-[calc(100%-40px)]">
                <Textarea
                  value={mermaidCode}
                  readOnly
                  className="h-full font-mono text-sm"
                />
              </TabsContent>
            )}
          </Tabs>
        </div>
      </TooltipProvider>
    </div>
  );
};

export default SchemaVisualization; 