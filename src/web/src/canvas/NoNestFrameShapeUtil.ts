import { FrameShapeUtil, type TLShape } from "tldraw";

// Extended FrameShapeUtil that prevents frame nesting.
// A frame cannot be dropped into another frame.
export class NoNestFrameShapeUtil extends FrameShapeUtil {
  override canReceiveNewChildrenOfType(shape: TLShape) {
    if (shape.type === "frame") return false;
    return !shape.isLocked;
  }
}
