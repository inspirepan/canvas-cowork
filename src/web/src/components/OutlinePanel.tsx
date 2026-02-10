import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Image,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Editor, TLAssetId, TLShapeId } from "tldraw";
import type { CanvasSync } from "../canvas/canvas-sync.js";
import { ScrollArea } from "./ui/scroll-area.js";

interface TreeNode {
  shapeId: string;
  name: string;
  type: "frame" | "text" | "image";
  imageSrc?: string;
  children: TreeNode[];
}

function buildTree(editor: Editor, sync: CanvasSync): TreeNode[] {
  const shapeToFile = sync.getShapeToFile();
  const pageId = editor.getCurrentPageId();
  const nodes: TreeNode[] = [];

  function buildNode(shapeId: TLShapeId): TreeNode | null {
    const shape = editor.getShape(shapeId);
    if (!shape) return null;
    if (!shapeToFile.has(shapeId)) return null;

    let type: "frame" | "text" | "image";
    let name: string;
    if (shape.type === "frame") {
      type = "frame";
      name = (shape.props as { name: string }).name || "untitled";
    } else if (shape.type === "named_text") {
      type = "text";
      name = (shape.props as { name: string }).name || "untitled";
    } else if (shape.type === "image") {
      type = "image";
      const path = shapeToFile.get(shapeId) ?? "";
      name = path.split("/").pop() ?? path;
    } else {
      return null;
    }

    const children: TreeNode[] = [];
    if (shape.type === "frame") {
      const childIds = editor.getSortedChildIdsForParent(shapeId);
      for (const childId of childIds) {
        const child = buildNode(childId as TLShapeId);
        if (child) children.push(child);
      }
    }

    let imageSrc: string | undefined;
    if (type === "image") {
      const assetId = (shape.props as { assetId?: string }).assetId;
      if (assetId) {
        const asset = editor.getAsset(assetId as TLAssetId);
        if (asset?.props && "src" in asset.props) {
          imageSrc = asset.props.src as string;
        }
      }
    }

    return { shapeId, name, type, imageSrc, children };
  }

  // Get root-level shapes (direct children of the page)
  const rootIds = editor.getSortedChildIdsForParent(pageId);
  for (const id of rootIds) {
    const node = buildNode(id as TLShapeId);
    if (node) nodes.push(node);
  }

  return nodes;
}

function NodeIcon({ type }: { type: TreeNode["type"] }) {
  switch (type) {
    case "frame":
      return <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    case "text":
      return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    case "image":
      return <Image className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
}

function TreeItem({
  node,
  depth,
  editor,
  selectedId,
}: {
  node: TreeNode;
  depth: number;
  editor: Editor;
  selectedId: string | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const isFrame = node.type === "frame";
  const isSelected = selectedId === node.shapeId;

  const handleClick = useCallback(() => {
    const id = node.shapeId as TLShapeId;
    editor.select(id);
    editor.zoomToSelection({ animation: { duration: 200 } });
  }, [editor, node.shapeId]);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setExpanded((v) => !v);
    },
    [],
  );

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={`w-full flex flex-col gap-1 py-1 pr-2 text-left text-xs hover:bg-accent/60 rounded transition-colors ${isSelected ? "bg-accent" : ""}`}
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        <div className="flex items-center gap-1.5 w-full">
          {isFrame ? (
            <span onClick={handleToggle} className="shrink-0 cursor-pointer p-0.5 -m-0.5">
              {expanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
            </span>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <NodeIcon type={node.type} />
          <span className="whitespace-nowrap">{node.name}</span>
        </div>
        {node.type === "image" && node.imageSrc && (
          <img
            src={node.imageSrc}
            alt={node.name}
            className="rounded border border-border object-cover"
            style={{ marginLeft: 28, width: "calc(100% - 28px)", height: 64 }}
          />
        )}
      </button>
      {isFrame && expanded && node.children.length > 0 && (
        <div
          className="border-l border-border"
          style={{ marginLeft: depth * 16 + 16 }}
        >
          {node.children.map((child) => (
            <TreeItem
              key={child.shapeId}
              node={child}
              depth={0}
              editor={editor}
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function OutlinePanel({
  editor,
  sync,
}: {
  editor: Editor | null;
  sync: CanvasSync | null;
}) {
  const [open, setOpen] = useState(true);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Rebuild tree on store changes
  useEffect(() => {
    if (!(editor && sync)) return;
    const rebuild = () => setTree(buildTree(editor, sync));
    rebuild();
    const unsub = editor.store.listen(rebuild, { scope: "document", source: "all" });
    return unsub;
  }, [editor, sync]);

  // Track tldraw selection
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const selected = editor.getSelectedShapeIds();
      setSelectedId(selected.length === 1 ? selected[0] : null);
    };
    update();
    const unsub = editor.store.listen(update, { scope: "session", source: "all" });
    return unsub;
  }, [editor]);

  if (!editor || !sync) return null;

  return (
    <div className="fixed top-3 left-3 z-50 flex items-start gap-2">
      {open && (
        <div className="min-w-48 max-w-80 max-h-[calc(100vh-340px)] bg-background/80 backdrop-blur border border-border rounded-lg shadow-sm flex flex-col overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border">
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Outline</span>
          </div>
          <ScrollArea className="flex-1 overflow-auto">
            <div className="py-1">
              {tree.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                  No items
                </div>
              ) : (
                tree.map((node) => (
                  <TreeItem
                    key={node.shapeId}
                    node={node}
                    depth={0}
                    editor={editor}
                    selectedId={selectedId}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-2 rounded-lg bg-background/80 backdrop-blur border border-border shadow-sm hover:bg-accent transition-colors"
      >
        {open ? (
          <PanelLeftClose className="h-4 w-4" />
        ) : (
          <PanelLeftOpen className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
