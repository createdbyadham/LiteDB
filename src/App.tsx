import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { HashRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/contexts/SidebarContext";
import DatabaseView from "./components/DatabaseView";
import ConnectionsView from '@/components/Connections/ConnectionsView';
import TitleBar from '@/components/TitleBar';
import { CommandPalette } from '@/components/CommandPalette';
import { useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { sealHandoff } from '@/lib/mcpHandoff';
import { inTauri } from '@/lib/db/native';
import { THEME_STORAGE_KEY } from '@/lib/theme';

const App = () => {
  useEffect(() => {
    if (!inTauri()) return;
    const checkForAppUpdates = async () => {
      try {
        const update = await check();
        if (update) {
          const wantsToUpdate = await ask(
            `LiteDB ${update.version} is available!\n\nRelease notes: ${update.body}\n\nDo you want to install it now?`,
            {
              title: 'Update Available',
              kind: 'info',
              okLabel: 'Install and Relaunch',
              cancelLabel: 'Later'
            }
          );

          if (wantsToUpdate) {
            await update.downloadAndInstall();
            await relaunch();
          }
        }
      } catch (error) {
        console.error("Failed to check for updates:", error);
      }
    };
    checkForAppUpdates();

    let cancelled = false;
    let unlistenClose: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async () => {
        await sealHandoff();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenClose = fn;
      });

    return () => {
      cancelled = true;
      unlistenClose?.();
    };
  }, []);

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem storageKey={THEME_STORAGE_KEY} disableTransitionOnChange>
      <SidebarProvider>
        <TooltipProvider>
          <HashRouter>
            <div className="flex flex-col h-screen overflow-hidden">
              <TitleBar />
              <div className="flex-1 overflow-hidden relative">
                <Routes>
                  <Route path="/" element={<ConnectionsView />} />
                  <Route path="/database" element={<DatabaseView />} />
                </Routes>
              </div>
            </div>
            <CommandPalette />
          </HashRouter>
          <Toaster />
          <Sonner />
        </TooltipProvider>
      </SidebarProvider>
    </ThemeProvider>
  );
};

export default App;
