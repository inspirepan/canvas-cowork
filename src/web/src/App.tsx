import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { CanvasSync } from "./canvas/canvas-sync.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { CanvasEditor } from "./components/CanvasEditor.js";
import { useAgent } from "./hooks/use-agent.js";
import { useCanvasSelection } from "./hooks/useCanvasSelection.js";

const PANEL_WIDTH = 380;

export function App() {
  const [panelOpen, setPanelOpen] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null);
  const syncRef = useRef<CanvasSync | null>(null);
  const [sync, setSync] = useState<CanvasSync | null>(null);
  const agent = useAgent();

  const handleMount = useCallback((ed: Editor) => {
    setEditor(ed);
  }, []);

  // Initialize canvas sync when editor is ready and canvas state arrives
  useEffect(() => {
    if (!(editor && agent.canvasState)) return;
    // Only init once
    if (syncRef.current) return;

    const s = new CanvasSync(editor, agent.sendMsg);
    s.init(agent.canvasState.snapshot, agent.canvasState.shapeToFile, agent.canvasState.files);
    syncRef.current = s;
    setSync(s);

    // Wire up FS change handler
    agent.onCanvasFSChange.current = (changes) => {
      s.handleFSChanges(changes);
    };

    return () => {
      s.dispose();
      syncRef.current = null;
      setSync(null);
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

  // Track canvas selection for agent context
  const selectionAttachments = useCanvasSelection(editor, sync);

  // Provide getAllCanvasItems for @ mention autocomplete
  const getCanvasItems = useCallback(() => {
    return syncRef.current?.getAllCanvasItems() ?? [];
  }, []);

  // Resolve a canvas item to a full CanvasAttachment (for @ mention)
  const resolveCanvasItem = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: branching per shape type
    (shapeId: string, path: string) => {
      if (!(editor && syncRef.current)) return null;
      const shape = editor.getShape(shapeId as import("tldraw").TLShapeId);
      if (!shape) return null;

      if (shape.type === "named_text") {
        const props = shape.props as { name: string; text: string };
        return {
          shapeId,
          path,
          type: "text" as const,
          name: `${props.name}.txt`,
          content: props.text,
        };
      }
      if (shape.type === "image") {
        const name = path.split("/").pop() ?? path;
        return { shapeId, path, type: "image" as const, name };
      }
      if (shape.type === "frame") {
        const props = shape.props as { name: string };
        const sync = syncRef.current;
        const children: import("./canvas/canvas-attachments.js").CanvasAttachment[] = [];
        const childIds = editor.getSortedChildIdsForParent(shapeId as import("tldraw").TLShapeId);
        const shapeToFile = sync.getShapeToFile();
        for (const childId of childIds) {
          const childPath = shapeToFile.get(childId);
          if (!childPath) continue;
          const child = resolveCanvasItem(childId, childPath);
          if (child) children.push(child);
        }
        return {
          shapeId,
          path: props.name,
          type: "frame" as const,
          name: `${props.name}/`,
          children,
        };
      }
      return null;
    },
    [editor],
  );

  const addImageToCanvas = useCallback(
    async (base64: string, mimeType: string) => {
      const s = syncRef.current;
      if (!s) return null;
      const { shapeId, path } = await s.addImageFromBase64(base64, mimeType);
      const name = path.split("/").pop() ?? path;
      return {
        shapeId,
        path,
        type: "image" as const,
        name,
        imageData: base64,
        imageMimeType: mimeType,
      };
    },
    [],
  );

  const canvasContext = useMemo(
    () => ({ selectionAttachments, getCanvasItems, resolveCanvasItem, addImageToCanvas }),
    [selectionAttachments, getCanvasItems, resolveCanvasItem, addImageToCanvas],
  );

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

      {/* AgentPanel sidebar - stop keyboard/clipboard events from reaching tldraw */}
      <div
        className="h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out"
        style={{ width: panelOpen ? PANEL_WIDTH : 0 }}
        onKeyDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
        onCopy={(e) => e.stopPropagation()}
        onCut={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
      >
        <div className="h-full bg-background border-l border-border" style={{ width: PANEL_WIDTH }}>
          <AgentPanel agent={agent} canvasContext={canvasContext} />
        </div>
      </div>
    </div>
  );
}
