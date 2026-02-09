import { useEffect, useRef, useState } from "react";
import type { Editor, TLAssetId, TLShapeId } from "tldraw";
import type { CanvasAttachment } from "../canvas/canvas-attachments.js";
import type { CanvasSync } from "../canvas/canvas-sync.js";

const DEBOUNCE_MS = 150;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: branching per shape type
function resolveAttachment(
  editor: Editor,
  shapeId: string,
  path: string,
  sync: CanvasSync,
): CanvasAttachment | null {
  const shape = editor.getShape(shapeId as TLShapeId);
  if (!shape) return null;

  if (shape.type === "named_text") {
    const props = shape.props as { name: string; text: string };
    return {
      shapeId,
      path,
      type: "text",
      name: `${props.name}.txt`,
      content: props.text,
    };
  }

  if (shape.type === "image") {
    const props = shape.props as { assetId?: string };
    const name = path.split("/").pop() ?? path;
    const attachment: CanvasAttachment = {
      shapeId,
      path,
      type: "image",
      name,
    };
    if (props.assetId) {
      const asset = editor.getAsset(props.assetId as TLAssetId);
      if (asset?.type === "image" && asset.props.src) {
        const src = asset.props.src as string;
        attachment.imageSrc = src;
        if (src.startsWith("data:")) {
          const [header, data] = src.split(",");
          attachment.imageData = data;
          attachment.imageMimeType = header.split(":")[1]?.split(";")[0];
        }
      }
    }
    return attachment;
  }

  if (shape.type === "frame") {
    const props = shape.props as { name: string };
    const children: CanvasAttachment[] = [];
    const childIds = editor.getSortedChildIdsForParent(shapeId as TLShapeId);
    const shapeToFile = sync.getShapeToFile();
    for (const childId of childIds) {
      const childPath = shapeToFile.get(childId);
      if (!childPath) continue;
      const child = resolveAttachment(editor, childId, childPath, sync);
      if (child) children.push(child);
    }
    return {
      shapeId,
      path: props.name,
      type: "frame",
      name: `${props.name}/`,
      children,
    };
  }

  return null;
}

export function useCanvasSelection(
  editor: Editor | null,
  sync: CanvasSync | null,
): CanvasAttachment[] {
  const [attachments, setAttachments] = useState<CanvasAttachment[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!(editor && sync)) {
      setAttachments([]);
      return;
    }

    const resolve = () => {
      const selectedIds = editor.getSelectedShapeIds();
      const shapeToFile = sync.getShapeToFile();
      const resolved: CanvasAttachment[] = [];

      for (const id of selectedIds) {
        const path = shapeToFile.get(id);
        if (!path) continue;
        const att = resolveAttachment(editor, id, path, sync);
        if (att) resolved.push(att);
      }

      setAttachments(resolved);
    };

    const cleanup = editor.store.listen(
      () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(resolve, DEBOUNCE_MS);
      },
      { scope: "session" },
    );

    // Initial resolve
    resolve();

    return () => {
      cleanup();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, sync]);

  return attachments;
}
