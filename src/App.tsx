import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { HashRouter, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/contexts/SidebarContext";
import DatabaseView from "./components/DatabaseView";
import UploadView from '@/components/UploadView';
import TitleBar from '@/components/TitleBar';
import { useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

const App = () => {
  useEffect(() => {
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
  }, []);

  return (
  <SidebarProvider>
    <TooltipProvider>
      <div className="flex flex-col h-screen overflow-hidden">
        <TitleBar />
        <div className="flex-1 overflow-hidden">
          <HashRouter>
            <Routes>
              <Route path="/" element={<UploadView />} />
              <Route path="/database" element={<DatabaseView />} />
            </Routes>
          </HashRouter>
        </div>
      </div>
      <Toaster />
      <Sonner />
    </TooltipProvider>
  </SidebarProvider>
  );
};

export default App;
