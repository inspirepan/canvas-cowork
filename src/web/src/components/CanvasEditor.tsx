import {
  type Editor,
  type TLAssetStore,
  type TLComponents,
  type TLUiOverrides,
  Tldraw,
} from "tldraw";
import "tldraw/tldraw.css";
import { CanvasToolbar } from "../canvas/CustomToolbar.js";
import { NamedImageShapeUtil } from "../canvas/NamedImageShapeUtil.js";
import { NamedTextShapeUtil } from "../canvas/NamedTextShapeUtil.js";
import { NamedTextTool } from "../canvas/NamedTextTool.js";
import { NoNestFrameShapeUtil } from "../canvas/NoNestFrameShapeUtil.js";

const customShapeUtils = [NamedTextShapeUtil, NoNestFrameShapeUtil, NamedImageShapeUtil];
const customTools = [NamedTextTool];

const customComponents: TLComponents = {
  Toolbar: CanvasToolbar,
};

const customOverrides: TLUiOverrides = {
  tools(editor, tools) {
    tools.named_text = {
      id: "named_text",
      // biome-ignore lint/suspicious/noExplicitAny: tldraw translation key
      label: "tool.named-text" as any,
      icon: "tool-text",
      kbd: "t",
      onSelect(_source) {
        editor.setCurrentTool("named_text");
      },
    };
    return tools;
  },
};

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

function generateImageFileName(file: File): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ext = MIME_TO_EXT[file.type] || file.name.split(".").pop() || "png";
  return `image-${mm}${dd}-${hh}${mi}${ss}.${ext}`;
}

// Module-level editor ref so the upload handler can update asset names
let editorRef: Editor | null = null;

// Upload images to canvas/ directory on the server
const canvasAssetStore: TLAssetStore = {
  async upload(asset, file) {
    const fileName = generateImageFileName(file);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("fileName", fileName);
    const res = await fetch("/canvas/upload", { method: "POST", body: formData });
    if (!res.ok) throw new Error("Upload failed");
    const { src } = (await res.json()) as { src: string };
    // Extract final filename from server response (includes dedup suffix)
    const finalName = src.split("/").pop() ?? fileName;
    // Update asset name to match the actual filename on disk
    if (editorRef) {
      queueMicrotask(() => {
        editorRef?.updateAssets([{ id: asset.id, type: "image", props: { name: finalName } }]);
      });
    }
    return { src };
  },
  resolve(asset) {
    return asset.props.src;
  },
};

interface CanvasEditorProps {
  onMount?: (editor: Editor) => void;
}

export function CanvasEditor({ onMount }: CanvasEditorProps) {
  return (
    <div className="tldraw-container" style={{ width: "100%", height: "100%" }}>
      <Tldraw
        onMount={(editor) => {
          editorRef = editor;
          onMount?.(editor);
        }}
        shapeUtils={customShapeUtils}
        tools={customTools}
        components={customComponents}
        overrides={customOverrides}
        assets={canvasAssetStore}
      />
    </div>
  );
}
