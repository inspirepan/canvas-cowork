import {
  createShapeId,
  StateNode,
  type TLKeyboardEventInfo,
  type TLPointerEventInfo,
  type TLStateNodeConstructor,
} from "tldraw";

class Idle extends StateNode {
  static override id = "idle";

  override onPointerDown(info: TLPointerEventInfo) {
    this.parent.transition("pointing", info);
  }

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }

  override onKeyDown(info: TLKeyboardEventInfo) {
    if (info.key === "Enter") {
      const shape = this.editor.getOnlySelectedShape();
      if (shape && this.editor.canEditShape(shape)) {
        this.editor.setCurrentTool("select");
        this.editor.setEditingShape(shape.id);
      }
    }
  }

  override onCancel() {
    this.editor.setCurrentTool("select");
  }
}

class Pointing extends StateNode {
  static override id = "pointing";

  override onPointerUp() {
    this.complete();
  }

  override onCancel() {
    this.cancel();
  }

  override onInterrupt() {
    this.cancel();
  }

  private complete() {
    const { editor } = this;
    editor.markHistoryStoppingPoint("creating named_text");

    const id = createShapeId();
    const point = editor.inputs.getOriginPagePoint();

    editor.createShape({
      id,
      type: "named_text",
      x: point.x,
      y: point.y - 12, // offset up a bit so cursor is inside the shape
      props: {
        name: "untitled",
        text: "",
        w: 200,
      },
    });

    editor.select(id);
    editor.setEditingShape(id);

    if (editor.getInstanceState().isToolLocked) {
      this.parent.transition("idle");
    } else {
      editor.setCurrentTool("select");
    }
  }

  private cancel() {
    this.parent.transition("idle");
  }
}

export class NamedTextTool extends StateNode {
  static override id = "named_text";
  static override initial = "idle";
  static override children(): TLStateNodeConstructor[] {
    return [Idle, Pointing];
  }
  override shapeType = "named_text";
}
