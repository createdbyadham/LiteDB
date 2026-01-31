import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Key, Hash, Link2, Circle, Diamond } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ColumnInfo, ForeignKeyInfo, IndexInfo } from '@/lib/dbService';

export interface TableNodeData {
  name: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
}

const getColumnIcon = (
  column: ColumnInfo, 
  foreignKeys: ForeignKeyInfo[], 
  indexes: IndexInfo[]
) => {
  const isPrimaryKey = column.pk === 1;
  const isForeignKey = foreignKeys.some(fk => fk.from === column.name);
  const isUnique = indexes.some(idx => idx.unique && idx.columns.includes(column.name) && idx.columns.length === 1);
  const isNullable = column.notnull === 0;

  if (isPrimaryKey) {
    return (
      <div className="flex items-center gap-1">
        <Key className="w-3 h-3 text-amber-400" />
        {isForeignKey && <Link2 className="w-3 h-3 text-amber-400" />}
      </div>
    );
  }
  
  if (isForeignKey) {
    return <Link2 className="w-3 h-3 text-amber-400" />;
  }
  
  if (isUnique) {
    return <Hash className="w-3 h-3 text-blue-400" />;
  }
  
  if (isNullable) {
    return <Diamond className="w-3 h-3 text-muted-foreground/50" />;
  }
  
  return <Circle className="w-3 h-3 text-muted-foreground/50 fill-current" />;
};

const formatType = (type: string) => {
  // Normalize and shorten common types
  const normalized = type.toLowerCase();
  
  const typeMap: Record<string, string> = {
    'integer': 'int4',
    'bigint': 'int8',
    'smallint': 'int2',
    'character varying': 'varchar',
    'character': 'char',
    'double precision': 'float8',
    'real': 'float4',
    'boolean': 'bool',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    'time without time zone': 'time',
    'time with time zone': 'timetz',
  };

  for (const [full, short] of Object.entries(typeMap)) {
    if (normalized.includes(full)) {
      return short;
    }
  }
  
  // Handle varchar(n), etc
  const match = normalized.match(/^(\w+)\((\d+)\)$/);
  if (match) {
    return match[1];
  }
  
  return type.length > 12 ? type.substring(0, 10) + '..' : type;
};

const TableNode = ({ data, selected }: NodeProps<TableNodeData>) => {
  const { name, columns, foreignKeys, indexes } = data;
  
  // Find columns that are foreign keys (these will have source handles)
  const fkColumnNames = new Set(foreignKeys.map(fk => fk.from));

  return (
    <div 
      className={cn(
        "bg-card border rounded-lg shadow-lg min-w-[220px] max-w-[280px] overflow-hidden",
        "transition-all duration-200",
        selected ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-muted-foreground/50"
      )}
    >
      {/* Table Header */}
      <div className="bg-muted/50 px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <span className="font-medium text-sm text-foreground truncate">{name}</span>
        </div>
        <button className="text-muted-foreground hover:text-foreground transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" x2="21" y1="14" y2="3" />
          </svg>
        </button>
      </div>
      
      {/* Columns List */}
      <div className="divide-y divide-border/50">
        {columns.map((column) => {
          const isPk = column.pk === 1;
          const isFk = fkColumnNames.has(column.name);
          
          return (
            <div
              key={column.name}
              className={cn(
                "px-3 py-1.5 flex items-center justify-between text-xs relative group",
                "hover:bg-muted/30 transition-colors"
              )}
            >
              {/* Target handle for primary keys */}
              {isPk && (
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`${name}-${column.name}-target`}
                  className="!w-2 !h-2 !bg-amber-400 !border-amber-500"
                  style={{ left: -4 }}
                />
              )}
              
              {/* Source handle for foreign keys */}
              {isFk && (
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`${name}-${column.name}-source`}
                  className="!w-2 !h-2 !bg-amber-400 !border-amber-500"
                  style={{ right: -4 }}
                />
              )}
              
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {getColumnIcon(column, foreignKeys, indexes)}
                <span className={cn(
                  "truncate",
                  isPk ? "text-foreground font-medium" : "text-muted-foreground"
                )}>
                  {column.name}
                </span>
              </div>
              
              <span className="text-muted-foreground/70 ml-2 shrink-0 font-mono text-[10px]">
                {formatType(column.type)}
              </span>
            </div>
          );
        })}
      </div>
      
      {/* Footer showing count */}
      {columns.length > 10 && (
        <div className="px-3 py-1 bg-muted/30 text-[10px] text-muted-foreground text-center border-t border-border/50">
          {columns.length} columns
        </div>
      )}
    </div>
  );
};

export default memo(TableNode);
