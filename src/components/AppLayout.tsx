import { useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidebar } from '@/contexts/SidebarContext';
import { cn } from '@/lib/utils';
import {
  Table2,
  GitBranch,
  Terminal,
  ChevronLeft,
  ChevronRight,
  ArrowLeft
} from 'lucide-react';
import icon from '/titlebaricon2.png';

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path?: string;
  onClick?: () => void;
}

interface AppLayoutProps {
  children: React.ReactNode;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  isConnected?: boolean;
  connectionType?: 'sqlite' | 'postgres' | null;
  databaseName?: string;
}

const AppLayout = ({ 
  children, 
  activeTab = 'browse',
  onTabChange,
  isConnected = false,
  connectionType = null,
  databaseName = ''
}: AppLayoutProps) => {
  const { navSidebarCollapsed: sidebarCollapsed, toggleNavSidebar } = useSidebar();
  const navigate = useNavigate();
  const location = useLocation();

  const isInDatabase = location.pathname === '/database';

  const mainNavItems: NavItem[] = [
    {
      id: 'back',
      label: 'Back',
      icon: <ArrowLeft className="w-5 h-5" />,
      onClick: () => navigate('/'),
    },
  ];

  const databaseNavItems: NavItem[] = isInDatabase ? [
    {
      id: 'browse',
      label: 'Table Editor',
      icon: <Table2 className="w-5 h-5" />,
      onClick: () => onTabChange?.('browse'),
    },
    {
      id: 'schema',
      label: 'Schema Visualizer',
      icon: <GitBranch className="w-5 h-5" />,
      onClick: () => onTabChange?.('schema'),
    },
    {
      id: 'query',
      label: 'SQL Editor',
      icon: <Terminal className="w-5 h-5" />,
      onClick: () => onTabChange?.('query'),
    },
  ] : [];

  const renderNavItem = (item: NavItem, isActive: boolean) => {
    const content = (
      <Button
        variant="ghost"
        className={cn(
          "w-full justify-start gap-3 h-10 px-3 transition-all",
          sidebarCollapsed && "justify-center px-0",
          isActive 
            ? "bg-accent text-accent-foreground font-medium" 
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        )}
        onClick={item.onClick}
      >
        {item.icon}
        {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
      </Button>
    );

    if (sidebarCollapsed) {
      return (
        <Tooltip key={item.id} delayDuration={0}>
          <TooltipTrigger asChild>
            {content}
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            {item.label}
          </TooltipContent>
        </Tooltip>
      );
    }

    return <div key={item.id}>{content}</div>;
  };

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Sidebar */}
      <aside 
        className={cn(
          "flex flex-col h-full bg-sidebar border-r border-sidebar-border transition-all duration-200 ease-out shrink-0",
          sidebarCollapsed ? "w-14" : "w-56"
        )}
      >
        {/* Sidebar Header */}
        <div className={cn(
          "flex items-center h-12 px-4 border-b border-sidebar-border",
          sidebarCollapsed ? "justify-center" : "justify-between"
        )}>
          {!sidebarCollapsed && (
            <div className="flex items-center gap-2">
              <img src={icon} alt="App Icon" className="w-6 h-6" />
              <span className="font-semibold text-sm">LiteDB</span>
            </div>
          )}
          {sidebarCollapsed && (
            <img src={icon} alt="App Icon" className="w-6 h-6" />
          )}
        </div>

        {/* Navigation */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {/* Main Nav */}
            {mainNavItems.map((item) => renderNavItem(item, location.pathname === '/'))}
            
            {/* Database Nav */}
            {databaseNavItems.length > 0 && (
              <>
                <Separator className="my-2" />
                {databaseNavItems.map((item) => renderNavItem(item, activeTab === item.id))}
              </>
            )}
          </div>
        </ScrollArea>

        {/* Sidebar Footer */}
        <div className="border-t border-sidebar-border p-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "w-full justify-center text-muted-foreground hover:text-foreground",
              !sidebarCollapsed && "justify-between"
            )}
            onClick={toggleNavSidebar}
          >
            {!sidebarCollapsed && <span className="text-xs">Collapse</span>}
            {sidebarCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
};

export default AppLayout;
