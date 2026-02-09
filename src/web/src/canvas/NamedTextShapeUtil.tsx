import { useCallback, useEffect, useRef } from "react";
import {
  createComputedCache,
  type Editor,
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  type TLShape,
  type TLShapeId,
  toDomPrecision,
  useEditor,
  useValue,
} from "tldraw";

// Props validation
const namedTextShapeProps = {
  name: T.string,
  text: T.string,
  w: T.number,
};

// Register custom shape type in tldraw's type system
declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    named_text: { name: string; text: string; w: number };
  }
}

// Shape type alias
export type NamedTextShape = TLShape<"named_text">;

// Constants
const PADDING = 12;
const NAME_HEIGHT = 24;
const MIN_WIDTH = 120;
const MAX_WIDTH = 2000;
const MIN_HEIGHT = 40;
const FONT_SIZE = 14;
const LINE_HEIGHT = 1.5;
const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif";

const TEXT_OPTS_BASE = {
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  lineHeight: LINE_HEIGHT,
  fontWeight: "normal" as const,
  fontStyle: "normal" as const,
  padding: "0px",
};

function measureNamedText(editor: Editor, shape: NamedTextShape) {
  const { text } = shape.props;

  if (!text) {
    return { width: MIN_WIDTH, height: MIN_HEIGHT };
  }

  // Measure single-line width (no wrapping)
  const singleLine = editor.textMeasure.measureText(text, {
    ...TEXT_OPTS_BASE,
    maxWidth: MAX_WIDTH,
  });

  const width = Math.max(MIN_WIDTH, Math.min(singleLine.w + PADDING * 2, MAX_WIDTH));

  // Measure with computed width for wrapped height
  const wrapped = editor.textMeasure.measureText(text, {
    ...TEXT_OPTS_BASE,
    maxWidth: width - PADDING * 2,
  });

  const height = Math.max(MIN_HEIGHT, wrapped.h + PADDING * 2);
  return { width, height };
}

const textSizeCache = createComputedCache("named_text size", (ctx, record) => {
  if (record.typeName !== "shape" || (record as TLShape).type !== "named_text") return undefined;
  return measureNamedText(ctx as Editor, record as NamedTextShape);
});

export class NamedTextShapeUtil extends ShapeUtil<NamedTextShape> {
  static override type = "named_text" as const;
  static override props = namedTextShapeProps;

  getDefaultProps(): NamedTextShape["props"] {
    return {
      name: "untitled",
      text: "",
      w: 480,
    };
  }

  getTextSize(shape: NamedTextShape) {
    return (
      textSizeCache.get(this.editor, shape.id) ?? {
        width: shape.props.w,
        height: MIN_HEIGHT,
      }
    );
  }

  getGeometry(shape: NamedTextShape) {
    const { width, height } = this.getTextSize(shape);
    return new Rectangle2d({
      width,
      height,
      isFilled: true,
    });
  }

  override canEdit() {
    return true;
  }

  override canResize() {
    return false;
  }

  component(shape: NamedTextShape) {
    const editor = useEditor();
    const { id, props } = shape;
    const { name, text } = props;
    const { width, height } = this.getTextSize(shape);

    const isEditing = useValue("isEditing", () => editor.getEditingShapeId() === id, [editor, id]);

    const isSelected = useValue("isSelected", () => editor.getSelectedShapeIds().includes(id), [
      editor,
      id,
    ]);

    return (
      <HTMLContainer
        style={{
          width,
          height,
          pointerEvents: "all",
        }}
      >
        {/* Name label - positioned above the shape */}
        <NameLabel shapeId={id} name={name} isSelected={isSelected} />
        {/* Content area */}
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "var(--color-background, #fff)",
            border: "1px solid",
            borderColor: isSelected
              ? "var(--color-selected, #3b82f6)"
              : "var(--color-text-3, #ccc)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {isEditing ? (
            <TextEditor shapeId={id} text={text} w={width} />
          ) : (
            <div
              style={{
                padding: PADDING,
                fontSize: FONT_SIZE,
                fontFamily: FONT_FAMILY,
                lineHeight: LINE_HEIGHT,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--color-text-1, #1a1a1a)",
                minHeight: MIN_HEIGHT - 2,
                cursor: "default",
              }}
            >
              {text || <span style={{ color: "var(--color-text-3, #aaa)" }}>Empty</span>}
            </div>
          )}
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: NamedTextShape) {
    const { width, height } = this.getTextSize(shape);
    return (
      <rect width={toDomPrecision(width)} height={toDomPrecision(height)} rx={6} ry={6} />
    );
  }

  override onEditEnd(shape: NamedTextShape) {
    const trimmed = shape.props.text.trim();
    if (trimmed.length === 0 && shape.props.name === "untitled") {
      this.editor.deleteShapes([shape.id]);
    }
  }
}

// Name label component (renders above the shape)
function NameLabel({
  shapeId,
  name,
  isSelected,
}: {
  shapeId: TLShapeId;
  name: string;
  isSelected: boolean;
}) {
  const editor = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const isEditingName = useValue("isEditingName", () => {
    // We use shape meta to track name editing state
    const shape = editor.getShape(shapeId);
    return (shape?.meta as Record<string, unknown>)?.editingName === true;
  }, [editor, shapeId]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      editor.updateShape({
        id: shapeId,
        type: "named_text",
        meta: { editingName: true },
      });
    },
    [editor, shapeId],
  );

  const commitName = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      editor.updateShape({
        id: shapeId,
        type: "named_text",
        props: { name: trimmed || "untitled" },
        meta: { editingName: false },
      });
    },
    [editor, shapeId],
  );

  useEffect(() => {
    if (isEditingName && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingName]);

  const displayName = `${name}.txt`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: tldraw shape internal
    <div
      style={{
        position: "absolute",
        top: -NAME_HEIGHT,
        left: 0,
        height: NAME_HEIGHT,
        display: "flex",
        alignItems: "flex-end",
        paddingBottom: 2,
        pointerEvents: isSelected ? "all" : "none",
      }}
      onDoubleClick={handleDoubleClick}
    >
      {isEditingName ? (
        <input
          ref={inputRef}
          defaultValue={name}
          style={{
            fontSize: 11,
            fontFamily: FONT_FAMILY,
            fontWeight: 500,
            color: "var(--color-text-2, #666)",
            background: "var(--color-background, #fff)",
            border: "1px solid var(--color-selected, #3b82f6)",
            borderRadius: 3,
            padding: "1px 4px",
            outline: "none",
            minWidth: 40,
          }}
          onBlur={(e) => commitName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName(e.currentTarget.value);
            if (e.key === "Escape") {
              editor.updateShape({
                id: shapeId,
                type: "named_text",
                meta: { editingName: false },
              });
            }
            e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          style={{
            fontSize: 11,
            fontFamily: FONT_FAMILY,
            fontWeight: 500,
            color: "var(--color-text-3, #999)",
            userSelect: "none",
            cursor: isSelected ? "text" : "default",
            whiteSpace: "nowrap",
          }}
        >
          {displayName}
        </span>
      )}
    </div>
  );
}

// Text editor component (shown when shape is in editing mode)
function TextEditor({ shapeId, text }: { shapeId: TLShapeId; text: string; w: number }) {
  const editor = useEditor();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      editor.updateShape({
        id: shapeId,
        type: "named_text",
        props: { text: e.currentTarget.value },
      });
    },
    [editor, shapeId],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        editor.complete();
      }
      // Prevent tldraw from handling these keys
      e.stopPropagation();
    },
    [editor],
  );

  return (
    <textarea
      ref={textareaRef}
      value={text}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: "100%",
        height: "100%",
        padding: PADDING,
        fontSize: FONT_SIZE,
        fontFamily: FONT_FAMILY,
        lineHeight: LINE_HEIGHT,
        border: "none",
        outline: "none",
        resize: "none",
        background: "transparent",
        color: "var(--color-text-1, #1a1a1a)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    />
  );
}
