import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Search, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useMemo } from 'react';

export interface SidebarItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  extra?: React.ReactNode; // Extra info on the right (e.g. column count)
  onClick: () => void;
  tooltip?: string;
}

interface SidebarProps {
  title: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  items: SidebarItem[];
  selectedId: string | null;
  stats?: React.ReactNode;
  searchPlaceholder?: string;
  className?: string;
}

export function Sidebar({
  title,
  collapsed,
  onToggleCollapse,
  items,
  selectedId,
  stats,
  searchPlaceholder = "Search...",
  className
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredItems = useMemo(() => {
    return items.filter(item =>
      item.label.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [items, searchQuery]);

  return (
    <aside
      className={cn(
        "h-full bg-background border-r transition-all duration-200 ease-out flex flex-col shrink-0",
        collapsed ? "w-12" : "w-64",
        className
      )}
    >
      {/* Sidebar Header */}
      <div className="flex items-center justify-between p-3 border-b">
        {!collapsed && (
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {title}
          </span>
        )}
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-7 w-7 text-muted-foreground", collapsed && "mx-auto")}
              onClick={onToggleCollapse}
            >
              <ChevronRight className={cn(
                "h-4 w-4 transition-transform duration-200",
                !collapsed && "rotate-180"
              )} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          </TooltipContent>
        </Tooltip>
      </div>

      {!collapsed && (
        <>
          {/* Stats */}
          {stats && (
            <div className="p-3 border-b">
               {stats}
            </div>
          )}

          {/* Search */}
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-9"
              />
            </div>
          </div>

          {/* Items List */}
          <ScrollArea className="flex-1">
            <div className="p-2">
              {filteredItems.length > 0 ? (
                filteredItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={item.onClick}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                      "hover:bg-muted/50 flex items-center justify-between group",
                      selectedId === item.id && "bg-muted"
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {item.icon && <span className="text-muted-foreground shrink-0 [&>svg]:w-4 [&>svg]:h-4">{item.icon}</span>}
                      <span className="truncate">{item.label}</span>
                    </div>
                    {item.extra ? (
                       item.extra
                    ) : (
                      <ChevronRight className={cn(
                        "w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0",
                        selectedId === item.id && "opacity-100"
                      )} />
                    )}
                  </button>
                ))
              ) : (
                <div className="text-center text-muted-foreground text-sm py-8">
                  {searchQuery ? 'No items found' : 'No items'}
                </div>
              )}
            </div>
          </ScrollArea>
        </>
      )}

      {/* Collapsed state - show icons */}
      {collapsed && (
        <ScrollArea className="flex-1">
          <div className="p-1.5 space-y-1">
            {filteredItems.map((item) => (
              <Tooltip key={item.id} delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    onClick={item.onClick}
                    className={cn(
                      "w-full flex items-center justify-center p-2 rounded-md transition-colors",
                      "hover:bg-muted/50",
                      selectedId === item.id && "bg-muted"
                    )}
                  >
                    <span className={cn(
                      "flex items-center justify-center [&>svg]:w-4 [&>svg]:h-4",
                      selectedId === item.id ? "text-primary" : "text-muted-foreground"
                    )}>
                      {item.icon}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {item.tooltip || item.label}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </ScrollArea>
      )}
    </aside>
  );
}
