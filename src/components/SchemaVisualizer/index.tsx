import { useState, useCallback, useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
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
  ReactFlowInstance,
  getNodesBounds,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { toPng, toSvg } from 'html-to-image';

import TableNode, { TableNodeData } from './TableNode';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Database,
  LayoutGrid,
  Link2,
  Key,
  Table2,
  TableOfContents,
  ArrowDownUp,
  CircleDot,
  ChevronDown,
  Workflow
} from 'lucide-react';
import { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '@/lib/sqliteService';
import { Sidebar, SidebarItem } from '@/components/Sidebar';
import { useSidebar } from '@/contexts/SidebarContext';

// Custom node types
const nodeTypes = {
  tableNode: TableNode,
};

// Edge style for relationships
const edgeStyle = {
  stroke: '#ffffff',
  strokeWidth: 2,
};

interface SchemaVisualizerProps {
  tables: TableInfo[];
  getTableColumns: (tableName: string) => ColumnInfo[] | Promise<ColumnInfo[]>;
  getForeignKeys: (tableName: string) => ForeignKeyInfo[] | Promise<ForeignKeyInfo[]>;
  getIndexes: (tableName: string) => IndexInfo[] | Promise<IndexInfo[]>;
  isPostgres?: boolean;
  onEditTable?: (tableName: string) => void;
}

export interface SchemaVisualizerRef {
  exportSchema: (format: 'png' | 'svg') => Promise<string | null>;
}

interface SchemaTable {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
}

type LayoutMode = 'Default' | 'Grid' | 'TB';

// Auto-layout algorithm
const calculateLayout = (
  tables: SchemaTable[],
  mode: LayoutMode = 'Default',
  onEditTable?: (name: string) => void
): { nodes: Node<TableNodeData>[]; edges: Edge[] } => {
  const nodes: Node<TableNodeData>[] = [];
  const edges: Edge[] = [];

  // Common edge creation logic
  tables.forEach(table => {
    table.foreignKeys.forEach((fk) => {
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
        labelStyle: { fill: '#ffffff', fontSize: 10 },
        labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.8 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 20,
          height: 20,
          color: '#ffffff',
        },
      });
    });
  });

  if (mode === 'Default') {
    // Default Layout - relationship-based topological sort
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

    // Calculate levels (topological sort)
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
            calculateLevel(ref, currentLevel + 1);
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

    // Handle remaining tables
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
    const nodeWidth = 300;
    const nodeHeight = 200;
    const horizontalGap = 80;
    const verticalGap = 60;

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
            onEdit: onEditTable,
          },
        });
      });
    });
  } else if (mode === 'Grid') {
    // Grid Layout - tables arranged in columns left to right
    const nodeWidth = 300;
    const gapX = 80;
    const gapY = 25;
    const cols = Math.ceil(Math.sqrt(tables.length));
    const rows = Math.ceil(tables.length / cols);

    // Calculate heights for all tables
    const tableHeights = tables.map(table => 
      40 + (table.columns.length * 32) + (table.columns.length > 10 ? 30 : 0)
    );

    // Arrange in columns (left to right flow)
    const colHeights: number[][] = [];
    for (let c = 0; c < cols; c++) {
      const colItems: number[] = [];
      for (let r = 0; r < rows; r++) {
        const idx = c * rows + r;
        if (idx < tables.length) {
          colItems.push(tableHeights[idx]);
        }
      }
      colHeights.push(colItems);
    }

    tables.forEach((table, index) => {
      const col = Math.floor(index / rows);
      const row = index % rows;

      // Calculate Y position based on previous items in this column
      let yPos = 0;
      for (let r = 0; r < row; r++) {
        const prevIdx = col * rows + r;
        if (prevIdx < tableHeights.length) {
          yPos += tableHeights[prevIdx] + gapY;
        }
      }

      nodes.push({
        id: table.name,
        type: 'tableNode',
        position: {
          x: col * (nodeWidth + gapX),
          y: yPos,
        },
        data: {
          name: table.name,
          columns: table.columns,
          foreignKeys: table.foreignKeys,
          indexes: table.indexes,
          onEdit: onEditTable,
        },
      });
    });
  } else {
    // TB - Pyramid Layout (visual pyramid shape: 1, 2, 3, 4... tables per row)
    const nodeWidth = 300;
    const gapX = 50;
    const gapY = 40;

    // Sort tables by importance: tables with most incoming refs (referenced by others) first
    const tableNames = new Set(tables.map(t => t.name));
    const incomingCount = new Map<string, number>();
    
    tables.forEach(t => incomingCount.set(t.name, 0));
    tables.forEach(table => {
      table.foreignKeys.forEach(fk => {
        if (tableNames.has(fk.table)) {
          incomingCount.set(fk.table, (incomingCount.get(fk.table) || 0) + 1);
        }
      });
    });

    const sortedTables = [...tables].sort((a, b) => 
      (incomingCount.get(b.name) || 0) - (incomingCount.get(a.name) || 0)
    );

    // Build pyramid tiers: row 0 has 1 table, row 1 has 2, row 2 has 3, etc.
    const tiers: SchemaTable[][] = [];
    let tableIndex = 0;
    let tierSize = 1;
    
    while (tableIndex < sortedTables.length) {
      const tier: SchemaTable[] = [];
      for (let i = 0; i < tierSize && tableIndex < sortedTables.length; i++) {
        tier.push(sortedTables[tableIndex]);
        tableIndex++;
      }
      tiers.push(tier);
      tierSize++;
    }

    // Calculate the width of the bottom (widest) tier for centering
    const bottomTier = tiers[tiers.length - 1];
    const maxTierWidth = bottomTier.length * nodeWidth + (bottomTier.length - 1) * gapX;

    let currentY = 0;
    tiers.forEach((tierTables) => {
      const tierWidth = tierTables.length * nodeWidth + (tierTables.length - 1) * gapX;
      const startX = (maxTierWidth - tierWidth) / 2;

      // Calculate max height in this tier
      const tierHeights = tierTables.map(t => 
        40 + (t.columns.length * 32) + (t.columns.length > 10 ? 30 : 0)
      );
      const maxHeight = Math.max(...tierHeights);

      tierTables.forEach((table, idx) => {
        nodes.push({
          id: table.name,
          type: 'tableNode',
          position: {
            x: startX + idx * (nodeWidth + gapX),
            y: currentY,
          },
          data: {
            name: table.name,
            columns: table.columns,
            foreignKeys: table.foreignKeys,
            indexes: table.indexes,
            onEdit: onEditTable,
          },
        });
      });

      currentY += maxHeight + gapY;
    });
  }

  return { nodes, edges };
};

const SchemaVisualizer = forwardRef<SchemaVisualizerRef, SchemaVisualizerProps>(({
  tables,
  getTableColumns,
  getForeignKeys,
  getIndexes,
  onEditTable
}, ref) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [schemaData, setSchemaData] = useState<SchemaTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const { contentSidebarCollapsed: sidebarCollapsed, toggleContentSidebar } = useSidebar();
  const [hasLoaded, setHasLoaded] = useState(false);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);

  const [layoutMode, setLayoutMode] = useState<LayoutMode>('Default');

  useImperativeHandle(ref, () => ({
    exportSchema: async (format: 'png' | 'svg') => {
      if (!reactFlowInstance) {
        return null;
      }

      // We need to grab the .react-flow__viewport element
      const viewportEl = document.querySelector('.react-flow__viewport') as HTMLElement;
      if (!viewportEl) {
        return null;
      }

      const nodes = reactFlowInstance.getNodes();
      if (nodes.length === 0) {
        return null;
      }

      const nodesBounds = getNodesBounds(nodes);

      const padding = 50;
      const width = nodesBounds.width + padding * 2;
      const height = nodesBounds.height + padding * 2;

      const transform = `translate(${-nodesBounds.x + padding}px, ${-nodesBounds.y + padding}px) scale(1)`;

      const options = {
        backgroundColor: '#ffffff',
        width: width,
        height: height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: transform,
        },
      };

      try {
        if (format === 'png') {
          return await toPng(viewportEl, options);
        } else {
          return await toSvg(viewportEl, options);
        }
      } catch (error) {
        console.error('Error exporting schema image:', error);
        return null;
      }
    }
  }));

  // Store functions in refs to avoid dependency issues
  const getTableColumnsRef = useRef(getTableColumns);
  const getForeignKeysRef = useRef(getForeignKeys);
  const getIndexesRef = useRef(getIndexes);
  const onEditTableRef = useRef(onEditTable);

  getTableColumnsRef.current = getTableColumns;
  getForeignKeysRef.current = getForeignKeys;
  getIndexesRef.current = getIndexes;
  onEditTableRef.current = onEditTable;

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

  // Handle layout changes
  const handleLayoutSelect = useCallback((mode: LayoutMode) => {
    setLayoutMode(mode);
    const { nodes: newNodes, edges: newEdges } = calculateLayout(schemaData, mode, (name) => onEditTableRef.current?.(name));
    setNodes(newNodes);
    setEdges(newEdges);
    
    // Fit view after layout
    setTimeout(() => {
      if (reactFlowInstance) {
        reactFlowInstance.fitView({ padding: 0.2, duration: 800 });
      }
    }, 10);
  }, [schemaData, reactFlowInstance, setNodes, setEdges]);

  // Handle schema data changes
  useEffect(() => {
    if (schemaData.length > 0) {
      const { nodes: newNodes, edges: newEdges } = calculateLayout(schemaData, layoutMode, (name) => onEditTableRef.current?.(name));
      setNodes(newNodes);
      setEdges(newEdges);
      
      // Fit view after layout
      setTimeout(() => {
        if (reactFlowInstance) {
          reactFlowInstance.fitView({ padding: 0.2, duration: 800 });
        }
      }, 10);
    }
  }, [schemaData, reactFlowInstance]);

  // Handle node selection
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedTable(node.id);
  }, []);


  // Focus on a specific table
  const focusTable = useCallback((tableName: string) => {
    setSelectedTable(tableName);
    // Center on the node
    const node = nodes.find(n => n.id === tableName);
    if (node && reactFlowInstance) {
      reactFlowInstance.fitView({
        nodes: [{ id: tableName }],
        duration: 800,
        padding: 0.5,
      });
    }
  }, [nodes, reactFlowInstance]);

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

  // Prepare items for sidebar
  const sidebarItems: SidebarItem[] = useMemo(() => {
    return schemaData.map(table => ({
      id: table.name,
      label: table.name,
      icon: <TableOfContents />,
      tooltip: `${table.name} (${table.columns.length} columns)`,
      extra: (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{table.columns.length}</span>
          {table.foreignKeys.length > 0 && (
            <Link2 className="w-3 h-3 text-amber-400" />
          )}
        </div>
      ),
      onClick: () => focusTable(table.name)
    }));
  }, [schemaData, focusTable]);

  const statsContent = (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Table2 className="w-3.5 h-3.5" />
        <span>{stats.tables} tables</span>
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Link2 className="w-3.5 h-3.5" />
        <span>{stats.relationships} relations</span>
      </div>
    </div>
  );

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
    <div className="h-full flex animate-fade-in">
      <Sidebar
        title="Schema"
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleContentSidebar}
        items={sidebarItems}
        selectedId={selectedTable}
        stats={statsContent}
        searchPlaceholder="Search tables..."
      />

      {/* Main Canvas */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onInit={setReactFlowInstance}
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
            pannable
            zoomable
            nodeColor={(node) => {
              if (node.id === selectedTable) return 'hsl(var(--primary))';
              return 'hsl(var(--muted))';
            }}
            maskColor="hsl(var(--background) / 0.8)"
          />

          {/* Top Panel */}
          <Panel position="top-right" className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-card"
                >
                  <LayoutGrid className="w-4 h-4 mr-2" />
                  Layout
                  <ChevronDown className="w-3 h-3 ml-2 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Layout Strategy</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleLayoutSelect('Default')}>
                  <Workflow className="w-4 h-4 mr-2 text-muted-foreground" />
                  Default
                  {layoutMode === 'Default' && <CircleDot className="w-3 h-3 ml-auto text-primary" />}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleLayoutSelect('Grid')}>
                  <LayoutGrid className="w-4 h-4 mr-2 text-muted-foreground" />
                  Grid
                  {layoutMode === 'Grid' && <CircleDot className="w-3 h-3 ml-auto text-primary" />}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleLayoutSelect('TB')}>
                  <ArrowDownUp className="w-4 h-4 mr-2 text-muted-foreground" />
                  Pyramid
                  {layoutMode === 'TB' && <CircleDot className="w-3 h-3 ml-auto text-primary" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
                <Link2 className="w-3 h-3 text-amber-400" />
                <span>Foreign Key</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <div className="w-3 h-0.5 bg-white" />
                <span>Relationship</span>
              </div>
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
});

export default SchemaVisualizer;
