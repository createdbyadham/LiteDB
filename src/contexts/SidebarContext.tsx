import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface SidebarContextValue {
  // Main app navigation sidebar
  navSidebarCollapsed: boolean;
  setNavSidebarCollapsed: (collapsed: boolean) => void;
  toggleNavSidebar: () => void;
  
  // Content sidebar (table list in browse mode, schema list in schema mode)
  contentSidebarCollapsed: boolean;
  setContentSidebarCollapsed: (collapsed: boolean) => void;
  toggleContentSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextValue | undefined>(undefined);

interface SidebarProviderProps {
  children: ReactNode;
}

export const SidebarProvider = ({ children }: SidebarProviderProps) => {
  const [navSidebarCollapsed, setNavSidebarCollapsed] = useState(false);
  const [contentSidebarCollapsed, setContentSidebarCollapsed] = useState(false);

  const toggleNavSidebar = useCallback(() => {
    setNavSidebarCollapsed(prev => !prev);
  }, []);

  const toggleContentSidebar = useCallback(() => {
    setContentSidebarCollapsed(prev => !prev);
  }, []);

  return (
    <SidebarContext.Provider
      value={{
        navSidebarCollapsed,
        setNavSidebarCollapsed,
        toggleNavSidebar,
        contentSidebarCollapsed,
        setContentSidebarCollapsed,
        toggleContentSidebar,
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
};

export const useSidebar = (): SidebarContextValue => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};
