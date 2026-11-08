import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Search, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pressTable } from '@/lib/tableDrag';
import { useState, useMemo } from 'react';

export interface SidebarItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  extra?: React.ReactNode; // Extra info on the right (e.g. column count)
  onClick: () => void;
  tooltip?: string;
  /** A table name: the item can be dragged onto Star to ask about that table. */
  dragTable?: string;
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
  searchPlaceholder = "Search",
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
        "h-full bg-background border-r flex flex-col shrink-0",
        collapsed ? "w-12" : "w-60",
        className
      )}
    >
      {/* Sidebar Header */}
      <div className="flex items-center justify-between p-3 border-b">
        {!collapsed && (
          <span className="text-xs font-medium text-muted-foreground">
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
              <Search strokeWidth={1.5} className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-9"
              />
            </div>
          </div>

          {/* Items List */}
          <ScrollArea className="flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
            <div className="p-2">
              {filteredItems.length > 0 ? (
                filteredItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={item.onClick}
                    onPointerDown={item.dragTable ? (e) => pressTable(e, item.dragTable!) : undefined}
                    title={item.dragTable ? 'Drag onto Star to ask about this table' : undefined}
                    className={cn(
                      "w-full text-left h-9 px-3 rounded-md text-sm transition-colors",
                      "hover:bg-muted/50 flex items-center justify-between gap-3 group",
                      selectedId === item.id && "bg-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
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
                      selectedId === item.id ? "text-foreground" : "text-muted-foreground"
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
