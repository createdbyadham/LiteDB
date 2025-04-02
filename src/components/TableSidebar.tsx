import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Database, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { TableInfo } from '@/lib/dbService';
import { cn } from '@/lib/utils';

interface TableSidebarProps {
  tables: TableInfo[];
  activeTable: string | null;
  onSelectTable: (tableName: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const TableSidebar = ({ 
  tables, 
  activeTable, 
  onSelectTable, 
  collapsed, 
  onToggleCollapse 
}: TableSidebarProps) => {
  const [searchQuery, setSearchQuery] = useState('');
  
  const filteredTables = tables.filter(
    table => table.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div 
      className={cn(
        "h-full bg-sidebar border-r border-sidebar-border transition-all duration-300 ease-in-out flex flex-col",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div className="flex items-center justify-between p-3">
        {!collapsed && (
          <div className="flex items-center space-x-2">
            <Database className="w-5 h-5 text-sidebar-primary" />
            <h2 className="text-sidebar-foreground font-medium">Tables</h2>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "text-sidebar-foreground hover:text-sidebar-primary hover:bg-sidebar-accent",
            collapsed ? "mx-auto" : "ml-auto"
          )}
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>
      
      {!collapsed && (
        <div className="px-3 mb-2">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tables..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-sidebar-accent text-black"
            />
          </div>
        </div>
      )}
      
      <Separator className="bg-sidebar-border" />
      
      <ScrollArea className="flex-1 h-full">
        <div className="py-2">
          {filteredTables.length > 0 ? (
            filteredTables.map((table) => (
              <Button
                key={table.name}
                variant="ghost"
                className={cn(
                  "w-full justify-start mb-1 transition-colors",
                  collapsed ? "mx-auto" : "px-3",
                  activeTable === table.name 
                    ? "bg-sidebar-accent text-sidebar-primary font-medium" 
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-primary"
                )}
                onClick={collapsed ? undefined : () => onSelectTable(table.name)}
                disabled={collapsed}
              >
                {!collapsed && (
                  <span className="truncate">{table.name}</span>
                )}
              </Button>
            ))
          ) : (
            <div className={cn(
              "flex flex-col items-center justify-center text-center p-4 text-sidebar-foreground/50",
              collapsed && "mx-auto"
            )}>
              {!collapsed && <span>No tables found</span>}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export default TableSidebar;
