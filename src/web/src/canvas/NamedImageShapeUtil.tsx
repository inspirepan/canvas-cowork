import { ImageShapeUtil, type TLAssetId, type TLImageShape, useEditor, useValue } from "tldraw";

const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif";
const NAME_HEIGHT = 24;

export class NamedImageShapeUtil extends ImageShapeUtil {
  override component(shape: TLImageShape) {
    const original = super.component(shape);
    return (
      <>
        <ImageNameLabel shape={shape} />
        {original}
      </>
    );
  }
}

function ImageNameLabel({ shape }: { shape: TLImageShape }) {
  const editor = useEditor();

  const isSelected = useValue("isSelected", () => editor.getSelectedShapeIds().includes(shape.id), [
    editor,
    shape.id,
  ]);

  // Get filename from asset
  const name = useValue("assetName", () => {
    if (!shape.props.assetId) return null;
    const asset = editor.getAsset(shape.props.assetId as TLAssetId);
    if (!asset || asset.type !== "image") return null;
    return (asset.props as { name?: string }).name ?? null;
  }, [editor, shape.props.assetId]);

  if (!name) return null;

  return (
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
    >
      <span
        style={{
          fontSize: 11,
          fontFamily: FONT_FAMILY,
          fontWeight: 500,
          color: "var(--color-text-3, #999)",
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
    </div>
  );
}
