import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { CanvasSync } from "./canvas/canvas-sync.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { CanvasEditor } from "./components/CanvasEditor.js";
import { useAgent } from "./hooks/use-agent.js";

const PANEL_WIDTH = 380;

export function App() {
  const [panelOpen, setPanelOpen] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null);
  const syncRef = useRef<CanvasSync | null>(null);
  const agent = useAgent();

  const handleMount = useCallback((ed: Editor) => {
    setEditor(ed);
  }, []);

  // Initialize canvas sync when editor is ready and canvas state arrives
  useEffect(() => {
    if (!(editor && agent.canvasState)) return;
    // Only init once
    if (syncRef.current) return;

    const sync = new CanvasSync(editor, agent.sendMsg);
    sync.init(agent.canvasState.snapshot, agent.canvasState.shapeToFile, agent.canvasState.files);
    syncRef.current = sync;

    // Wire up FS change handler
    agent.onCanvasFSChange.current = (changes) => {
      sync.handleFSChanges(changes);
    };

    return () => {
      sync.dispose();
      syncRef.current = null;
      agent.onCanvasFSChange.current = null;
    };
  }, [editor, agent.canvasState, agent.sendMsg, agent.onCanvasFSChange]);

  // Wire up screenshot request handler
  useEffect(() => {
    if (!editor) return;

    agent.onScreenshotRequest.current = async (requestId: string) => {
      try {
        const shapeIds = [...editor.getCurrentPageShapeIds()];
        if (shapeIds.length === 0) {
          agent.sendMsg({
            type: "screenshot_error",
            requestId,
            message: "No shapes on canvas",
          });
          return;
        }
        const result = await editor.toImage(shapeIds, { format: "png", background: true });
        if (!result?.blob) throw new Error("Export returned null");
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          // Strip data:image/png;base64, prefix
          const base64 = dataUrl.split(",")[1];
          agent.sendMsg({
            type: "screenshot_response",
            requestId,
            data: base64,
            mimeType: "image/png",
          });
        };
        reader.onerror = () => {
          agent.sendMsg({
            type: "screenshot_error",
            requestId,
            message: "Failed to read screenshot blob",
          });
        };
        reader.readAsDataURL(result.blob);
      } catch (err) {
        agent.sendMsg({
          type: "screenshot_error",
          requestId,
          message: err instanceof Error ? err.message : "Screenshot failed",
        });
      }
    };

    return () => {
      agent.onScreenshotRequest.current = null;
    };
  }, [editor, agent.sendMsg, agent.onScreenshotRequest, agent]);

  return (
    <div className="h-dvh w-full overflow-hidden flex relative">
      {/* Canvas - takes remaining space */}
      <div className="h-full flex-1 min-w-0">
        <CanvasEditor onMount={handleMount} />
      </div>

      {/* Panel toggle button - outside tldraw to avoid z-index conflicts */}
      <button
        type="button"
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
        <div className="h-full bg-background border-l border-border" style={{ width: PANEL_WIDTH }}>
          <AgentPanel agent={agent} />
        </div>
      </div>
    </div>
  );
}
