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
        "h-full bg-background border-r transition-all duration-300 ease-in-out flex flex-col",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div className="flex items-center justify-between p-3">
        {!collapsed && (
          <div className="flex items-center space-x-2 ml-2">
            <Database className="w-5 h-5 text-primary" />
            <h2 className="text-foreground font-medium">Tables</h2>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "text-sidebar-foreground",
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
              className="pl-8"
            />
          </div>
        </div>
      )}
      
      <Separator className={cn("bg-border", !collapsed && "mt-[1px]")} />
      
      <ScrollArea className="flex-1 h-full">
        <div className="py-2">
          {filteredTables.length > 0 ? (
            filteredTables.map((table) => (
              <div className="px-2">
                <Button
                  key={table.name}
                  variant="ghost" 
                  className={cn(
                    "w-full justify-start mb-1 transition-colors rounded-md",
                    collapsed ? "mx-auto" : "px-3",
                    !collapsed && activeTable === table.name 
                      ? "bg-accent text-accent-foreground font-medium" 
                      : "text-muted-foreground hover:bg-accent/50"
                  )}
                  onClick={collapsed ? undefined : () => onSelectTable(table.name)}
                  disabled={collapsed}
                >
                  {!collapsed && (
                    <span className="truncate">{table.name}</span>
                  )}
                </Button>
              </div>
            ))
          ) : (
            <div className={cn(
              "flex flex-col items-center justify-center text-center p-4 text-muted-foreground",
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
