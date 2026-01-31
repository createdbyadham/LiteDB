import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { HashRouter, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/contexts/SidebarContext";
import DatabaseView from "./components/DatabaseView";
import UploadView from '@/components/UploadView';
import TitleBar from '@/components/TitleBar';

const App = () => (
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

export default App;
