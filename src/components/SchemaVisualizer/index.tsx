import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  Panel,
  MiniMap,
  ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';

import TableNode, { TableNodeData } from './TableNode';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidebar } from '@/contexts/SidebarContext';
import { 
  Database, 
  Search, 
  LayoutGrid,
  Table2,
  Link2,
  Key,
  ChevronRight
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '@/lib/dbService';

// Custom node types
const nodeTypes = {
  tableNode: TableNode,
};

// Edge style for relationships
const edgeStyle = {
  stroke: '#a855f7',
  strokeWidth: 2,
};


interface SchemaVisualizerProps {
  tables: TableInfo[];
  getTableColumns: (tableName: string) => ColumnInfo[] | Promise<ColumnInfo[]>;
  getForeignKeys: (tableName: string) => ForeignKeyInfo[] | Promise<ForeignKeyInfo[]>;
  getIndexes: (tableName: string) => IndexInfo[] | Promise<IndexInfo[]>;
  isPostgres?: boolean;
}

interface SchemaTable {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
}

// Auto-layout algorithm
const calculateLayout = (tables: SchemaTable[]): { nodes: Node<TableNodeData>[]; edges: Edge[] } => {
  const nodes: Node<TableNodeData>[] = [];
  const edges: Edge[] = [];
  
  // Build a graph of relationships
  const relationships = new Map<string, Set<string>>();
  const incomingRelationships = new Map<string, Set<string>>();
  
  tables.forEach(table => {
    relationships.set(table.name, new Set());
    incomingRelationships.set(table.name, new Set());
  });
  
  tables.forEach(table => {
    table.foreignKeys.forEach(fk => {
      relationships.get(table.name)?.add(fk.table);
      incomingRelationships.get(fk.table)?.add(table.name);
    });
  });
  
  // Calculate levels (topological sort-ish)
  const levels = new Map<string, number>();
  const visited = new Set<string>();
  
  const calculateLevel = (tableName: string, currentLevel: number = 0): number => {
    if (visited.has(tableName)) return levels.get(tableName) || 0;
    visited.add(tableName);
    
    let maxLevel = currentLevel;
    const refs = relationships.get(tableName);
    if (refs) {
      refs.forEach(ref => {
        if (!visited.has(ref)) {
          const refLevel = calculateLevel(ref, currentLevel + 1);
          maxLevel = Math.max(maxLevel, currentLevel);
        }
      });
    }
    
    levels.set(tableName, maxLevel);
    return maxLevel;
  };
  
  // Start with tables that have no outgoing relationships
  tables.forEach(table => {
    if (relationships.get(table.name)?.size === 0) {
      calculateLevel(table.name, 0);
    }
  });
  
  // Handle any remaining tables
  tables.forEach(table => {
    if (!levels.has(table.name)) {
      calculateLevel(table.name, 0);
    }
  });
  
  // Group tables by level
  const levelGroups = new Map<number, SchemaTable[]>();
  tables.forEach(table => {
    const level = levels.get(table.name) || 0;
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)?.push(table);
  });
  
  // Position nodes
  const nodeWidth = 250;
  const nodeHeight = 200;
  const horizontalGap = 100;
  const verticalGap = 80;
  
  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => b - a);
  
  sortedLevels.forEach((level, levelIndex) => {
    const tablesInLevel = levelGroups.get(level) || [];
    const levelWidth = tablesInLevel.length * (nodeWidth + horizontalGap);
    const startX = -(levelWidth / 2) + (nodeWidth / 2);
    
    tablesInLevel.forEach((table, tableIndex) => {
      const x = startX + tableIndex * (nodeWidth + horizontalGap);
      const y = levelIndex * (nodeHeight + verticalGap);
      
      nodes.push({
        id: table.name,
        type: 'tableNode',
        position: { x, y },
        data: {
          name: table.name,
          columns: table.columns,
          foreignKeys: table.foreignKeys,
          indexes: table.indexes,
        },
      });
    });
  });
  
  // Create edges for relationships
  tables.forEach(table => {
    table.foreignKeys.forEach((fk, index) => {
      edges.push({
        id: `${table.name}-${fk.from}-${fk.table}-${fk.to}`,
        source: table.name,
        sourceHandle: `${table.name}-${fk.from}-source`,
        target: fk.table,
        targetHandle: `${fk.table}-${fk.to}-target`,
        type: 'smoothstep',
        animated: true,
        style: edgeStyle,
        label: fk.from,
        labelStyle: { fill: '#a855f7', fontSize: 10 },
        labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.8 },
      });
    });
  });
  
  return { nodes, edges };
};

const SchemaVisualizer = ({ 
  tables, 
  getTableColumns, 
  getForeignKeys, 
  getIndexes,
}: SchemaVisualizerProps) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [schemaData, setSchemaData] = useState<SchemaTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const { contentSidebarCollapsed: sidebarCollapsed, toggleContentSidebar } = useSidebar();

  // Store functions in refs to avoid dependency issues
  const getTableColumnsRef = useRef(getTableColumns);
  const getForeignKeysRef = useRef(getForeignKeys);
  const getIndexesRef = useRef(getIndexes);
  
  getTableColumnsRef.current = getTableColumns;
  getForeignKeysRef.current = getForeignKeys;
  getIndexesRef.current = getIndexes;

  // Create a stable table key to detect actual table changes
  const tableKey = useMemo(() => 
    tables.map(t => t.name).sort().join(','), 
    [tables]
  );

  // Load schema data
  useEffect(() => {
    // Skip if already loaded with the same tables
    if (hasLoaded && schemaData.length === tables.length) {
      return;
    }

    let mounted = true;

    const loadSchema = async () => {
      if (!mounted) return;
      setLoading(true);
      
      try {
        const schemaPromises = tables.map(async (table) => {
          const [columns, foreignKeys, indexes] = await Promise.all([
            Promise.resolve(getTableColumnsRef.current(table.name)),
            Promise.resolve(getForeignKeysRef.current(table.name)),
            Promise.resolve(getIndexesRef.current(table.name)),
          ]);
          
          return {
            name: table.name,
            columns: columns || [],
            foreignKeys: foreignKeys || [],
            indexes: indexes || [],
          };
        });
        
        const data = await Promise.all(schemaPromises);
        
        if (!mounted) return;
        
        setSchemaData(data);
        setHasLoaded(true);
        
        // Calculate layout
        const { nodes: newNodes, edges: newEdges } = calculateLayout(data);
        setNodes(newNodes);
        setEdges(newEdges);
      } catch (error) {
        console.error('Error loading schema:', error);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    
    if (tables.length > 0) {
      loadSchema();
    } else {
      setLoading(false);
    }
    
    return () => {
      mounted = false;
    };
  }, [tableKey]); // Only depend on tableKey

  // Handle node selection
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedTable(node.id);
  }, []);

  // Handle auto-layout
  const handleAutoLayout = useCallback(() => {
    const { nodes: newNodes, edges: newEdges } = calculateLayout(schemaData);
    setNodes(newNodes);
    setEdges(newEdges);
  }, [schemaData, setNodes, setEdges]);

  // Focus on a specific table
  const focusTable = useCallback((tableName: string) => {
    setSelectedTable(tableName);
    // Center on the node
    const node = nodes.find(n => n.id === tableName);
    if (node) {
      // Nodes will be highlighted by selection
    }
  }, [nodes]);

  // Filter tables for sidebar
  const filteredTables = useMemo(() => {
    return schemaData.filter(table => 
      table.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [schemaData, searchQuery]);

  // Count statistics
  const stats = useMemo(() => {
    const totalColumns = schemaData.reduce((acc, t) => acc + t.columns.length, 0);
    const totalRelationships = schemaData.reduce((acc, t) => acc + t.foreignKeys.length, 0);
    const totalIndexes = schemaData.reduce((acc, t) => acc + t.indexes.length, 0);
    
    return {
      tables: schemaData.length,
      columns: totalColumns,
      relationships: totalRelationships,
      indexes: totalIndexes,
    };
  }, [schemaData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-4">
          <Database className="w-16 h-16 text-muted-foreground/50 mx-auto animate-pulse" />
          <h2 className="text-xl font-medium">Loading schema...</h2>
        </div>
      </div>
    );
  }

  if (tables.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-4">
          <Database className="w-16 h-16 text-muted-foreground/50 mx-auto" />
          <h2 className="text-xl font-medium">No tables found</h2>
          <p className="text-muted-foreground">
            The database doesn't contain any tables to visualize
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* Sidebar */}
      <div 
        className={cn(
          "h-full bg-background border-r transition-all duration-200 ease-out flex flex-col shrink-0",
          sidebarCollapsed ? "w-12" : "w-64"
        )}
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between p-3 border-b">
          {!sidebarCollapsed && (
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Schema
            </span>
          )}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-7 w-7 text-muted-foreground", sidebarCollapsed && "mx-auto")}
                onClick={toggleContentSidebar}
              >
                <ChevronRight className={cn(
                  "h-4 w-4 transition-transform duration-200",
                  !sidebarCollapsed && "rotate-180"
                )} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            </TooltipContent>
          </Tooltip>
        </div>

        {!sidebarCollapsed && (
          <>
            {/* Stats */}
            <div className="p-3 border-b grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Table2 className="w-3.5 h-3.5" />
                <span>{stats.tables} tables</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Link2 className="w-3.5 h-3.5" />
                <span>{stats.relationships} relations</span>
              </div>
            </div>

            {/* Search */}
            <div className="p-3 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search tables..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-9"
                />
              </div>
            </div>

            {/* Tables List */}
            <ScrollArea className="flex-1">
              <div className="p-2">
                {filteredTables.map((table) => (
                  <button
                    key={table.name}
                    onClick={() => focusTable(table.name)}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                      "hover:bg-muted/50 flex items-center justify-between group",
                      selectedTable === table.name && "bg-muted"
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Table2 className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="truncate">{table.name}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>{table.columns.length}</span>
                      {table.foreignKeys.length > 0 && (
                        <Link2 className="w-3 h-3 text-purple-400" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </>
        )}

        {/* Collapsed state - show table icons */}
        {sidebarCollapsed && (
          <ScrollArea className="flex-1">
            <div className="p-1.5 space-y-1">
              {filteredTables.map((table) => (
                <Tooltip key={table.name} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => focusTable(table.name)}
                      className={cn(
                        "w-full flex items-center justify-center p-2 rounded-md transition-colors",
                        "hover:bg-muted/50",
                        selectedTable === table.name && "bg-muted"
                      )}
                    >
                      <Table2 className={cn(
                        "w-4 h-4",
                        selectedTable === table.name ? "text-primary" : "text-muted-foreground"
                      )} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {table.name} ({table.columns.length} cols)
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Main Canvas */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          connectionMode={ConnectionMode.Loose}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          defaultEdgeOptions={{
            type: 'smoothstep',
            animated: true,
            style: edgeStyle,
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background 
            variant={BackgroundVariant.Dots} 
            gap={20} 
            size={1}
            color="hsl(var(--muted-foreground) / 0.2)"
          />
          
          <Controls 
            className="!bg-card !border-border !shadow-lg"
            showZoom={true}
            showFitView={true}
            showInteractive={false}
          />
          
          <MiniMap 
            className="!bg-card !border-border"
            nodeColor={(node) => {
              if (node.id === selectedTable) return 'hsl(var(--primary))';
              return 'hsl(var(--muted))';
            }}
            maskColor="hsl(var(--background) / 0.8)"
          />

          {/* Top Panel */}
          <Panel position="top-right" className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleAutoLayout}
              className="bg-card"
            >
              <LayoutGrid className="w-4 h-4 mr-2" />
              Auto Layout
            </Button>
          </Panel>

          {/* Legend Panel */}
          <Panel position="bottom-left" className="bg-card border rounded-lg p-3 shadow-lg">
            <div className="text-xs space-y-2">
              <div className="font-medium text-foreground mb-2">Legend</div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Key className="w-3 h-3 text-amber-400" />
                <span>Primary Key</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Link2 className="w-3 h-3 text-purple-400" />
                <span>Foreign Key</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <div className="w-3 h-0.5 bg-purple-400" />
                <span>Relationship</span>
              </div>
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
};

export default SchemaVisualizer;
