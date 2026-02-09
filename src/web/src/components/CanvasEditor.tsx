import { type Editor, Tldraw } from "tldraw";
import "tldraw/tldraw.css";

interface CanvasEditorProps {
  onMount?: (editor: Editor) => void;
}

export function CanvasEditor({ onMount }: CanvasEditorProps) {
  return (
    <div className="tldraw-container" style={{ width: "100%", height: "100%" }}>
      <Tldraw onMount={onMount} />
    </div>
  );
}
