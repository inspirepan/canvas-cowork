import {
  ArrowToolbarItem,
  AssetToolbarItem,
  DefaultToolbar,
  DrawToolbarItem,
  EraserToolbarItem,
  FrameToolbarItem,
  HandToolbarItem,
  SelectToolbarItem,
  TldrawUiMenuToolItem,
  useIsToolSelected,
  useTools,
} from "tldraw";

// NamedText toolbar item - maps to our custom tool
function NamedTextToolbarItem() {
  const tools = useTools();
  const isSelected = useIsToolSelected(tools.named_text);
  return <TldrawUiMenuToolItem toolId="named_text" isSelected={isSelected} />;
}

// Custom toolbar with only the 8 allowed tools:
// Select, Hand, Frame, NamedText, Image(Asset), Draw, Arrow, Eraser
export function CanvasToolbar() {
  return (
    <DefaultToolbar>
      <SelectToolbarItem />
      <HandToolbarItem />
      <FrameToolbarItem />
      <NamedTextToolbarItem />
      <AssetToolbarItem />
      <DrawToolbarItem />
      <ArrowToolbarItem />
      <EraserToolbarItem />
    </DefaultToolbar>
  );
}
