import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { HashRouter, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import DatabaseView from "./components/DatabaseView";
import NotFound from "./pages/NotFound";
import UploadView from '@/components/UploadView';
import TitleBar from '@/components/TitleBar';

const App = () => (
    <TooltipProvider>
      <div className="flex flex-col h-screen">
        <TitleBar />
        <main className="flex-1 relative">
          <HashRouter>
            <Routes>
              <Route path="/" element={<UploadView />} />
              <Route path="/database" element={<DatabaseView />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </HashRouter>
        </main>
      </div>
      <Toaster />
      <Sonner />
    </TooltipProvider>
);

export default App;
