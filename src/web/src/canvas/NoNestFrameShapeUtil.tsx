import { useCallback, useEffect, useRef } from "react";
import {
  FrameShapeUtil,
  HTMLContainer,
  SVGContainer,
  type TLDragShapesInInfo,
  type TLFrameShape,
  type TLShape,
  type TLShapePartial,
  toDomPrecision,
  useEditor,
  useValue,
} from "tldraw";

const MIN_FRAME_W = 240;
const MIN_FRAME_H = 120;
const AUTO_RESIZE_PADDING = 24;
const HEADER_H = 32;

const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif";

// Debounce timer for auto-resize (shared across all frames)
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const pendingResizeFrames = new Set<string>();

// Extended FrameShapeUtil that prevents frame nesting,
// auto-resizes to fit children, and renders a modern file-group style.
export class NoNestFrameShapeUtil extends FrameShapeUtil {
  override canReceiveNewChildrenOfType(shape: TLShape) {
    if (shape.type === "frame") return false;
    return !shape.isLocked;
  }

  // Block frame-into-frame during drag: the parent class's onDragShapesIn
  // doesn't call canReceiveNewChildrenOfType, so we filter here.
  override onDragShapesIn(
    shape: TLFrameShape,
    draggingShapes: TLShape[],
    info: TLDragShapesInInfo,
  ): void {
    const allowed = draggingShapes.filter((s) => s.type !== "frame");
    if (allowed.length === 0) return;
    super.onDragShapesIn(shape, allowed, info);
  }

  // biome-ignore lint/suspicious/noConfusingVoidType: tldraw override signature
  override onChildrenChange(shape: TLFrameShape): TLShapePartial[] | void {
    pendingResizeFrames.add(shape.id);
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      for (const frameId of pendingResizeFrames) {
        const frame = this.editor.getShape(frameId as TLFrameShape["id"]);
        if (!frame || frame.type !== "frame") continue;
        this.autoResizeFrame(frame as TLFrameShape);
      }
      pendingResizeFrames.clear();
    }, 100);
  }

  override component(shape: TLFrameShape) {
    return <FrameComponent shape={shape} />;
  }

  override indicator(shape: TLFrameShape) {
    return (
      <rect
        width={toDomPrecision(shape.props.w)}
        height={toDomPrecision(shape.props.h)}
        rx={8}
        ry={8}
      />
    );
  }

  private autoResizeFrame(frame: TLFrameShape): void {
    const childIds = this.editor.getSortedChildIdsForParent(frame.id);
    if (childIds.length === 0) {
      if (frame.props.w !== MIN_FRAME_W || frame.props.h !== MIN_FRAME_H) {
        this.editor.updateShape({
          id: frame.id,
          type: "frame",
          props: { w: MIN_FRAME_W, h: MIN_FRAME_H },
        });
      }
      return;
    }

    let maxRight = 0;
    let maxBottom = 0;

    for (const childId of childIds) {
      const child = this.editor.getShape(childId);
      if (!child) continue;
      const geom = this.editor.getShapeGeometry(childId);
      if (!geom) continue;
      maxRight = Math.max(maxRight, child.x + geom.bounds.w);
      maxBottom = Math.max(maxBottom, child.y + geom.bounds.h);
    }

    const neededW = Math.max(MIN_FRAME_W, maxRight + AUTO_RESIZE_PADDING);
    const neededH = Math.max(MIN_FRAME_H, maxBottom + AUTO_RESIZE_PADDING);

    if (neededW !== frame.props.w || neededH !== frame.props.h) {
      this.editor.updateShape({
        id: frame.id,
        type: "frame",
        props: { w: neededW, h: neededH },
      });
    }
  }
}

// -- Rendering --

function FolderIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="folder"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function FrameComponent({ shape }: { shape: TLFrameShape }) {
  const editor = useEditor();
  const { id, props } = shape;
  const { w, h, name } = props;

  const isSelected = useValue("isSelected", () => editor.getSelectedShapeIds().includes(id), [
    editor,
    id,
  ]);

  const isEditing = useValue("isEditing", () => editor.getEditingShapeId() === id, [editor, id]);

  const childCount = useValue("childCount", () => editor.getSortedChildIdsForParent(id).length, [
    editor,
    id,
  ]);

  const displayName = name || "Folder";

  return (
    <>
      {/* SVG background (needed for tldraw's clipping / background layer) */}
      <SVGContainer>
        <rect
          width={toDomPrecision(w)}
          height={toDomPrecision(h)}
          rx={8}
          ry={8}
          fill="var(--color-background, #fff)"
          stroke={isSelected ? "var(--color-selected, #3b82f6)" : "rgba(0,0,0,.10)"}
          strokeWidth={isSelected ? 1.5 : 1}
        />
        {/* Header divider line */}
        <line
          x1={0}
          y1={HEADER_H}
          x2={toDomPrecision(w)}
          y2={HEADER_H}
          stroke="rgba(0,0,0,.08)"
          strokeWidth={1}
        />
      </SVGContainer>

      {/* HTML header overlay -- pointerEvents only when editing (for input) */}
      <HTMLContainer
        style={{
          width: w,
          height: HEADER_H,
          pointerEvents: isEditing ? "all" : "none",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: "100%",
            height: HEADER_H,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 12px",
            background: "rgba(0,0,0,.025)",
            borderTopLeftRadius: 8,
            borderTopRightRadius: 8,
            userSelect: "none",
          }}
        >
          <span style={{ color: "rgba(0,0,0,.35)", display: "flex", flexShrink: 0 }}>
            <FolderIcon size={14} />
          </span>

          {isEditing ? (
            <FrameNameEditor shapeId={id} name={name} />
          ) : (
            <span
              style={{
                fontSize: 12,
                fontFamily: FONT_FAMILY,
                fontWeight: 500,
                color: "rgba(0,0,0,.55)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                lineHeight: 1,
                letterSpacing: "-0.01em",
              }}
            >
              {displayName}
              {childCount > 0 && (
                <span style={{ fontWeight: 400, color: "rgba(0,0,0,.30)", marginLeft: 4 }}>
                  {childCount}
                </span>
              )}
            </span>
          )}
        </div>
      </HTMLContainer>
    </>
  );
}

function FrameNameEditor({ shapeId, name }: { shapeId: TLFrameShape["id"]; name: string }) {
  const editor = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      editor.updateShape({
        id: shapeId,
        type: "frame",
        props: { name: trimmed },
      });
      editor.setEditingShape(null);
    },
    [editor, shapeId],
  );

  return (
    <input
      ref={inputRef}
      defaultValue={name}
      style={{
        fontSize: 12,
        fontFamily: FONT_FAMILY,
        fontWeight: 500,
        color: "rgba(0,0,0,.7)",
        background: "transparent",
        border: "none",
        outline: "none",
        padding: 0,
        margin: 0,
        width: "100%",
        lineHeight: 1,
        letterSpacing: "-0.01em",
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        if (e.key === "Escape") editor.setEditingShape(null);
        e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
