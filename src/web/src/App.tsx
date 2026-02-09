import { useState, useCallback, useRef } from "react";
import { Editor } from "tldraw";
import { AgentPanel } from "./components/AgentPanel.js";
import { CanvasEditor } from "./components/CanvasEditor.js";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

const PANEL_WIDTH = 380;

export function App() {
  const [panelOpen, setPanelOpen] = useState(true);
  const editorRef = useRef<Editor | null>(null);

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden flex relative">
      {/* Canvas - takes remaining space */}
      <div className="h-full flex-1">
        <CanvasEditor onMount={handleMount} />
      </div>

      {/* Panel toggle button - outside tldraw to avoid z-index conflicts */}
      <button
        onClick={() => setPanelOpen((v) => !v)}
        className="fixed top-3 z-50 p-2 rounded-lg bg-background/80 backdrop-blur border border-border shadow-sm hover:bg-accent transition-all duration-300 ease-in-out"
        style={{ right: panelOpen ? PANEL_WIDTH + 12 : 12 }}
      >
        {panelOpen ? (
          <PanelRightClose className="h-4 w-4" />
        ) : (
          <PanelRightOpen className="h-4 w-4" />
        )}
      </button>

      {/* AgentPanel sidebar */}
      <div
        className="h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out"
        style={{ width: panelOpen ? PANEL_WIDTH : 0 }}
      >
        <div
          className="h-full bg-background border-l border-border"
          style={{ width: PANEL_WIDTH }}
        >
          <AgentPanel />
        </div>
      </div>
    </div>
  );
}
