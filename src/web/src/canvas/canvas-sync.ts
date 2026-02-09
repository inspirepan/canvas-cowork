import {
  AssetRecordType,
  createShapeId,
  type Editor,
  getSnapshot,
  loadSnapshot,
  type TLAssetId,
  type TLParentId,
  type TLShapeId,
  type TLStoreEventInfo,
} from "tldraw";
import type {
  CanvasFileEntry,
  CanvasFSEvent,
  CanvasSyncChange,
  ClientMessage,
} from "../../../shared/protocol.js";

// Shape-to-file path derivation helpers
function nameToTxtPath(name: string, parentFramePath: string | null): string {
  const fileName = `${name}.txt`;
  return parentFramePath ? `${parentFramePath}/${fileName}` : fileName;
}

function pathToName(relPath: string): string {
  const parts = relPath.split("/");
  const filename = parts[parts.length - 1];
  // Remove extension
  const dotIdx = filename.lastIndexOf(".");
  return dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
}

function pathToDir(relPath: string): string | null {
  const slashIdx = relPath.indexOf("/");
  if (slashIdx < 0) return null;
  return relPath.slice(0, slashIdx);
}

const _IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

function getImageMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
  };
  return mimeMap[ext] ?? "image/png";
}

function loadImageDimensions(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 300, h: 200 });
    img.src = src;
  });
}

// Layout constants
const SHAPE_SPACING = 20;
const DEFAULT_WIDTH = 200;
const DEFAULT_FRAME_WIDTH = 320;
const DEFAULT_FRAME_HEIGHT = 200;
const FRAME_INNER_PADDING = 20;
const FRAME_HEADER_OFFSET = 44; // Space below frame header (32px header + 12px gap)
const FADE_IN_DURATION = 300;
const FADE_OUT_DURATION = 200;

export class CanvasSync {
  private editor: Editor;
  private sendMsg: (msg: ClientMessage) => void;
  private shapeToFile = new Map<string, string>(); // shapeId -> relative path
  private fileToShape = new Map<string, string>(); // relative path -> shapeId
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  // Shapes pending fade-out deletion (ignore FS events for these)
  private pendingDeletes = new Set<string>();

  constructor(editor: Editor, sendMsg: (msg: ClientMessage) => void) {
    this.editor = editor;
    this.sendMsg = sendMsg;
  }

  // Wrap shape mutations in mergeRemoteChanges so the store listener
  // (source: 'user') ignores them, preventing canvas->FS->canvas loops.
  private applyRemote(fn: () => void): void {
    this.editor.store.mergeRemoteChanges(fn);
  }

  // Initialize from server state
  init(
    snapshot: Record<string, unknown> | null,
    shapeToFile: Record<string, string>,
    files: CanvasFileEntry[],
  ): void {
    if (snapshot) {
      // Restore from saved snapshot
      try {
        loadSnapshot(this.editor.store, snapshot as Parameters<typeof loadSnapshot>[1]);
      } catch (_e) {
        this.bootstrapFromFiles(files);
        return;
      }
      // Restore mapping
      for (const [shapeId, path] of Object.entries(shapeToFile)) {
        this.shapeToFile.set(shapeId, path);
        this.fileToShape.set(path, shapeId);
      }
      // Reconcile: check if files on disk match the snapshot
      this.reconcileWithFiles(files);
    } else if (files.length > 0) {
      // No snapshot but files exist: bootstrap canvas from filesystem
      this.bootstrapFromFiles(files);
    }

    this.startListening();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // -- Canvas -> FS sync (user edits) --

  private startListening(): void {
    this.unsubscribe = this.editor.store.listen(
      (entry: TLStoreEventInfo) => {
        this.handleStoreChange(entry);
        this.scheduleSave();
      },
      { scope: "document", source: "user" },
    );
  }

  private handleStoreChange(entry: TLStoreEventInfo): void {
    const changes: CanvasSyncChange[] = [];
    const { added, updated, removed } = entry.changes;

    // Handle added shapes
    for (const record of Object.values(added)) {
      if (record.typeName !== "shape") continue;
      const shape = record as unknown as {
        id: string;
        type: string;
        parentId: string;
        props: Record<string, unknown>;
      };
      const change = this.handleShapeCreated(shape);
      if (change) changes.push(change);
    }

    // Handle updated shapes
    for (const [from, to] of Object.values(updated)) {
      if (from.typeName !== "shape") continue;
      const fromShape = from as unknown as {
        id: string;
        type: string;
        parentId: string;
        props: Record<string, unknown>;
      };
      const toShape = to as unknown as {
        id: string;
        type: string;
        parentId: string;
        props: Record<string, unknown>;
      };
      const updateChanges = this.handleShapeUpdated(fromShape, toShape);
      changes.push(...updateChanges);
    }

    // Handle removed shapes
    for (const record of Object.values(removed)) {
      if (record.typeName !== "shape") continue;
      const shape = record as unknown as {
        id: string;
        type: string;
        props: Record<string, unknown>;
      };
      const change = this.handleShapeDeleted(shape);
      if (change) changes.push(change);
    }

    if (changes.length > 0) {
      this.sendMsg({ type: "canvas_sync", changes });
    }
  }

  private handleShapeCreated(shape: {
    id: string;
    type: string;
    parentId: string;
    props: Record<string, unknown>;
  }): CanvasSyncChange | null {
    if (shape.type === "named_text") {
      const name = (shape.props.name as string) || "untitled";
      const text = (shape.props.text as string) || "";
      const parentPath = this.getFramePath(shape.parentId);
      const path = nameToTxtPath(name, parentPath);
      this.shapeToFile.set(shape.id, path);
      this.fileToShape.set(path, shape.id);
      return { action: "create", shapeType: "named_text", path, content: text };
    }
    if (shape.type === "frame") {
      const name = (shape.props.name as string) || "untitled";
      const path = name;
      this.shapeToFile.set(shape.id, path);
      this.fileToShape.set(path, shape.id);
      return { action: "create", shapeType: "frame", path };
    }
    if (shape.type === "image") {
      // Image was uploaded via assets.upload which already wrote the file.
      // We just need to register the mapping from the asset src URL.
      const assetId = shape.props.assetId as string | null;
      if (assetId) {
        const asset = this.editor.getAsset(assetId as TLAssetId);
        if (asset?.type === "image" && asset.props.src) {
          const src = asset.props.src as string;
          // Extract relative path from /canvas/... URL
          if (src.startsWith("/canvas/")) {
            const path = src.slice("/canvas/".length);
            this.shapeToFile.set(shape.id, path);
            this.fileToShape.set(path, shape.id);
            // File already exists from upload, no sync needed
            return null;
          }
        }
      }
    }
    return null;
  }

  private handleShapeUpdated(
    from: { id: string; type: string; parentId: string; props: Record<string, unknown> },
    to: { id: string; type: string; parentId: string; props: Record<string, unknown> },
  ): CanvasSyncChange[] {
    const changes: CanvasSyncChange[] = [];

    if (to.type === "named_text") {
      const oldPath = this.shapeToFile.get(to.id);
      if (!oldPath) return changes;

      const oldName = from.props.name as string;
      const newName = to.props.name as string;
      const oldText = from.props.text as string;
      const newText = to.props.text as string;

      // Check for reparenting (moved in/out of frame)
      if (from.parentId !== to.parentId) {
        const newParentPath = this.getFramePath(to.parentId);
        const newPath = nameToTxtPath(newName, newParentPath);
        this.fileToShape.delete(oldPath);
        this.shapeToFile.set(to.id, newPath);
        this.fileToShape.set(newPath, to.id);
        changes.push({
          action: "move",
          shapeType: "named_text",
          path: newPath,
          oldPath,
        });
        return changes;
      }

      // Check for rename
      if (oldName !== newName) {
        const parentPath = this.getFramePath(to.parentId);
        const newPath = nameToTxtPath(newName, parentPath);
        this.fileToShape.delete(oldPath);
        this.shapeToFile.set(to.id, newPath);
        this.fileToShape.set(newPath, to.id);
        changes.push({
          action: "rename",
          shapeType: "named_text",
          path: newPath,
          oldPath,
        });
        return changes;
      }

      // Check for text content change
      if (oldText !== newText) {
        changes.push({
          action: "update",
          shapeType: "named_text",
          path: oldPath,
          content: newText,
        });
      }
    } else if (to.type === "frame") {
      const oldPath = this.shapeToFile.get(to.id);
      if (!oldPath) return changes;

      const oldName = from.props.name as string;
      const newName = to.props.name as string;

      if (oldName !== newName) {
        // Frame renamed -> rename directory and update all children mappings
        this.fileToShape.delete(oldPath);
        this.shapeToFile.set(to.id, newName);
        this.fileToShape.set(newName, to.id);
        // Update children paths
        for (const [shapeId, filePath] of this.shapeToFile.entries()) {
          if (shapeId === to.id) continue;
          if (filePath.startsWith(`${oldPath}/`)) {
            const newChildPath = newName + filePath.slice(oldPath.length);
            this.shapeToFile.set(shapeId, newChildPath);
            this.fileToShape.delete(filePath);
            this.fileToShape.set(newChildPath, shapeId);
          }
        }
        changes.push({
          action: "rename",
          shapeType: "frame",
          path: newName,
          oldPath,
        });
      }
    }

    return changes;
  }

  private handleShapeDeleted(shape: {
    id: string;
    type: string;
    props: Record<string, unknown>;
  }): CanvasSyncChange | null {
    const path = this.shapeToFile.get(shape.id);
    if (!path) return null;

    this.shapeToFile.delete(shape.id);
    this.fileToShape.delete(path);

    if (shape.type === "named_text") {
      return { action: "delete", shapeType: "named_text", path };
    }
    if (shape.type === "frame") {
      // Remove all children mappings too
      const prefix = `${path}/`;
      for (const [sid, fp] of this.shapeToFile.entries()) {
        if (fp.startsWith(prefix)) {
          this.shapeToFile.delete(sid);
          this.fileToShape.delete(fp);
        }
      }
      return { action: "delete", shapeType: "frame", path };
    }
    if (shape.type === "image") {
      return { action: "delete", shapeType: "image", path };
    }
    return null;
  }

  // -- FS -> Canvas sync (agent/external edits) --

  handleFSChanges(changes: CanvasFSEvent[]): void {
    // Categorize changes
    const syncCreates: CanvasFSEvent[] = [];
    const syncModifies: CanvasFSEvent[] = [];
    const syncDeletes: CanvasFSEvent[] = [];
    const asyncImageCreates: CanvasFSEvent[] = [];

    for (const change of changes) {
      if (
        change.action === "created" &&
        !change.isDirectory &&
        this.inferShapeType(change.path) === "image"
      ) {
        asyncImageCreates.push(change);
      } else if (change.action === "deleted") {
        syncDeletes.push(change);
      } else if (change.action === "modified") {
        syncModifies.push(change);
      } else {
        syncCreates.push(change);
      }
    }

    // Detect moves: a delete followed by a create of the same filename
    // (with the same base name, just different directory).
    // This happens when `mv canvas/a.txt canvas/folder/a.txt`.
    const moves = this.detectMoves(syncDeletes, syncCreates);
    for (const move of moves) {
      // Remove from pending create/delete lists
      const delIdx = syncDeletes.indexOf(move.deleteEvent);
      if (delIdx >= 0) syncDeletes.splice(delIdx, 1);
      const createIdx = syncCreates.indexOf(move.createEvent);
      if (createIdx >= 0) syncCreates.splice(createIdx, 1);
    }

    // Handle moves with reparent animation
    if (moves.length > 0) {
      this.handleFSMoves(moves);
    }

    // Handle creates + modifies inside mergeRemoteChanges
    const createdShapeIds: TLShapeId[] = [];
    const toProcess = [...syncCreates, ...syncModifies];
    if (toProcess.length > 0) {
      this.applyRemote(() => {
        for (const change of toProcess) {
          const id = this.applyFSChangeSync(change);
          if (id) createdShapeIds.push(id);
        }
      });
    }

    // Fade-in animation for newly created shapes
    if (createdShapeIds.length > 0) {
      requestAnimationFrame(() => {
        this.editor.animateShapes(
          createdShapeIds
            .map((id) => {
              const shape = this.editor.getShape(id);
              if (!shape) return null;
              return { id, type: shape.type, opacity: 1 as const };
            })
            .filter(Boolean),
          { animation: { duration: FADE_IN_DURATION } },
        );
      });
    }

    // Handle deletes with fade-out animation
    for (const change of syncDeletes) {
      this.handleFSDeletedAnimated(change);
    }

    // Handle async image creates
    for (const change of asyncImageCreates) {
      this.createImageFromFS(change);
    }

    this.scheduleSave();
  }

  private detectMoves(
    deletes: CanvasFSEvent[],
    creates: CanvasFSEvent[],
  ): { deleteEvent: CanvasFSEvent; createEvent: CanvasFSEvent }[] {
    const moves: { deleteEvent: CanvasFSEvent; createEvent: CanvasFSEvent }[] = [];
    const usedCreates = new Set<number>();

    for (const del of deletes) {
      if (del.isDirectory) continue;
      const delName = pathToName(del.path);
      const delExt = del.path.split(".").pop() ?? "";

      for (let i = 0; i < creates.length; i++) {
        if (usedCreates.has(i)) continue;
        const create = creates[i];
        if (create.isDirectory) continue;
        const createName = pathToName(create.path);
        const createExt = create.path.split(".").pop() ?? "";

        // Same filename (name + extension), different directory = move
        if (delName === createName && delExt === createExt && del.path !== create.path) {
          // Must have an existing shape for the deleted path
          if (this.fileToShape.has(del.path)) {
            moves.push({ deleteEvent: del, createEvent: create });
            usedCreates.add(i);
            break;
          }
        }
      }
    }
    return moves;
  }

  private handleFSMoves(moves: { deleteEvent: CanvasFSEvent; createEvent: CanvasFSEvent }[]): void {
    for (const { deleteEvent, createEvent } of moves) {
      const shapeId = this.fileToShape.get(deleteEvent.path);
      if (!shapeId) continue;

      const shape = this.editor.getShape(shapeId as TLShapeId);
      if (!shape) continue;

      // Get old page-space position before reparent
      const oldPageBounds = this.editor.getShapePageBounds(shape);

      // Determine new parent
      const newDir = pathToDir(createEvent.path);
      const newParentId = newDir ? this.getFrameShapeId(newDir) : null;
      const newPos = newParentId ? this.findPositionInFrame(newParentId) : this.findOpenPosition();

      // Update mapping
      this.fileToShape.delete(deleteEvent.path);
      this.shapeToFile.set(shapeId, createEvent.path);
      this.fileToShape.set(createEvent.path, shapeId);

      // Reparent and move
      this.applyRemote(() => {
        const targetParent = newParentId
          ? (newParentId as TLParentId)
          : this.editor.getCurrentPageId();
        this.editor.reparentShapes([shapeId as TLShapeId], targetParent);
        this.editor.updateShape({
          id: shapeId as TLShapeId,
          type: shape.type,
          x: newPos.x,
          y: newPos.y,
        });

        // Update text content if provided
        if (createEvent.content !== undefined && shape.type === "named_text") {
          this.editor.updateShape({
            id: shapeId as TLShapeId,
            type: "named_text",
            props: { text: createEvent.content },
          });
        }
      });

      // Animate from old position to new position if we have old bounds
      if (oldPageBounds) {
        const newPageBounds = this.editor.getShapePageBounds(shapeId as TLShapeId);
        if (newPageBounds) {
          const dx = oldPageBounds.x - newPageBounds.x;
          const dy = oldPageBounds.y - newPageBounds.y;
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
            // Temporarily offset shape to old position, then animate to new
            this.applyRemote(() => {
              this.editor.updateShape({
                id: shapeId as TLShapeId,
                type: shape.type,
                x: newPos.x + dx,
                y: newPos.y + dy,
              });
            });
            requestAnimationFrame(() => {
              this.editor.animateShapes(
                [{ id: shapeId as TLShapeId, type: shape.type, x: newPos.x, y: newPos.y }],
                { animation: { duration: FADE_IN_DURATION } },
              );
            });
          }
        }
      }
    }
  }

  private applyFSChangeSync(event: CanvasFSEvent): TLShapeId | null {
    switch (event.action) {
      case "created":
        return this.handleFSCreatedSync(event);
      case "modified":
        this.handleFSModified(event);
        return null;
      case "deleted":
        this.handleFSDeleted(event);
        return null;
    }
    return null;
  }

  private handleFSCreatedSync(event: CanvasFSEvent): TLShapeId | null {
    if (this.fileToShape.has(event.path)) return null;

    if (event.isDirectory) {
      const name = pathToName(event.path);
      const id = createShapeId();
      const pos = this.findOpenPosition();
      this.editor.createShape({
        id,
        type: "frame",
        x: pos.x,
        y: pos.y,
        opacity: 0,
        props: { w: DEFAULT_FRAME_WIDTH, h: DEFAULT_FRAME_HEIGHT, name },
      });
      this.shapeToFile.set(id, event.path);
      this.fileToShape.set(event.path, id);
      return id;
    }

    const shapeType = this.inferShapeType(event.path);
    if (shapeType === "named_text") {
      const name = pathToName(event.path);
      const dir = pathToDir(event.path);
      const parentId = dir ? this.getFrameShapeId(dir) : null;
      const id = createShapeId();
      const pos = parentId ? this.findPositionInFrame(parentId) : this.findOpenPosition();

      this.editor.createShape({
        id,
        type: "named_text",
        ...(parentId ? { parentId: parentId as TLParentId } : {}),
        x: pos.x,
        y: pos.y,
        opacity: 0,
        props: { name, text: event.content ?? "", w: DEFAULT_WIDTH },
      });
      this.shapeToFile.set(id, event.path);
      this.fileToShape.set(event.path, id);
      return id;
    }
    return null;
  }

  private async createImageFromFS(event: CanvasFSEvent): Promise<void> {
    if (this.fileToShape.has(event.path)) return;

    const name = pathToName(event.path);
    const src = `/canvas/${event.path}`;
    const mimeType = getImageMimeType(event.path);

    // Load image to get dimensions
    const { w, h } = await loadImageDimensions(src);

    // Scale down large images to reasonable canvas size
    const maxDim = 600;
    let displayW = w;
    let displayH = h;
    if (w > maxDim || h > maxDim) {
      const scale = maxDim / Math.max(w, h);
      displayW = Math.round(w * scale);
      displayH = Math.round(h * scale);
    }

    const assetId = AssetRecordType.createId();
    const shapeId = createShapeId();
    const dir = pathToDir(event.path);
    const parentId = dir ? this.getFrameShapeId(dir) : null;
    const pos = parentId ? this.findPositionInFrame(parentId) : this.findOpenPosition();

    this.applyRemote(() => {
      // Create asset
      this.editor.createAssets([
        AssetRecordType.create({
          id: assetId,
          type: "image",
          props: {
            w,
            h,
            name: `${name}.${event.path.split(".").pop()}`,
            isAnimated: mimeType === "image/gif",
            mimeType,
            src,
          },
        }),
      ]);

      // Create image shape at opacity 0 for fade-in
      this.editor.createShape({
        id: shapeId,
        type: "image",
        ...(parentId ? { parentId: parentId as TLParentId } : {}),
        x: pos.x,
        y: pos.y,
        opacity: 0,
        props: {
          w: displayW,
          h: displayH,
          assetId: assetId as TLAssetId,
        },
      });
    });

    // Fade in
    requestAnimationFrame(() => {
      this.editor.animateShapes([{ id: shapeId, type: "image" as const, opacity: 1 as const }], {
        animation: { duration: FADE_IN_DURATION },
      });
    });

    this.shapeToFile.set(shapeId, event.path);
    this.fileToShape.set(event.path, shapeId);
    this.scheduleSave();
  }

  private handleFSModified(event: CanvasFSEvent): void {
    if (event.isDirectory) return;
    const shapeId = this.fileToShape.get(event.path);
    if (!shapeId) return;

    const shape = this.editor.getShape(shapeId as TLShapeId);
    if (!shape || shape.type !== "named_text" || event.content === undefined) return;

    this.editor.updateShape({
      id: shapeId as TLShapeId,
      type: "named_text",
      props: { text: event.content },
    });
  }

  // Immediate delete (used inside mergeRemoteChanges during init/reconcile)
  private handleFSDeleted(event: CanvasFSEvent): void {
    const shapeId = this.fileToShape.get(event.path);
    if (!shapeId) return;

    const shape = this.editor.getShape(shapeId as TLShapeId);
    if (shape) {
      this.editor.deleteShape(shapeId as TLShapeId);
    }
    this.shapeToFile.delete(shapeId);
    this.fileToShape.delete(event.path);

    if (event.isDirectory) {
      const prefix = `${event.path}/`;
      const childEntries = [...this.fileToShape.entries()].filter(([path]) =>
        path.startsWith(prefix),
      );
      for (const [path, sid] of childEntries) {
        const childShape = this.editor.getShape(sid as TLShapeId);
        if (childShape) {
          this.editor.deleteShape(sid as TLShapeId);
        }
        this.shapeToFile.delete(sid);
        this.fileToShape.delete(path);
      }
    }
  }

  // Animated delete: fade out then remove (used for agent-driven changes)
  private handleFSDeletedAnimated(event: CanvasFSEvent): void {
    const shapeId = this.fileToShape.get(event.path);
    if (!shapeId) return;

    const shape = this.editor.getShape(shapeId as TLShapeId);
    if (!shape) {
      this.shapeToFile.delete(shapeId);
      this.fileToShape.delete(event.path);
      return;
    }

    // Collect all shape IDs to delete (including directory children)
    const idsToDelete: TLShapeId[] = [shapeId as TLShapeId];
    if (event.isDirectory) {
      const prefix = `${event.path}/`;
      for (const [path, sid] of this.fileToShape.entries()) {
        if (path.startsWith(prefix)) {
          idsToDelete.push(sid as TLShapeId);
        }
      }
    }

    // Mark as pending so we don't re-process
    for (const id of idsToDelete) {
      this.pendingDeletes.add(id);
    }

    // Animate opacity to 0
    this.editor.animateShapes(
      idsToDelete
        .map((id) => {
          const s = this.editor.getShape(id);
          if (!s) return null;
          return { id, type: s.type, opacity: 0 as const };
        })
        .filter(Boolean),
      { animation: { duration: FADE_OUT_DURATION } },
    );

    // After animation, delete shapes
    setTimeout(() => {
      this.applyRemote(() => {
        for (const id of idsToDelete) {
          const s = this.editor.getShape(id);
          if (s) this.editor.deleteShape(id);
          this.pendingDeletes.delete(id);
        }
      });
      // Clean up mappings
      this.shapeToFile.delete(shapeId);
      this.fileToShape.delete(event.path);
      if (event.isDirectory) {
        const prefix = `${event.path}/`;
        for (const [path, sid] of [...this.fileToShape.entries()]) {
          if (path.startsWith(prefix)) {
            this.shapeToFile.delete(sid);
            this.fileToShape.delete(path);
          }
        }
      }
      this.scheduleSave();
    }, FADE_OUT_DURATION + 50);
  }

  // -- Bootstrap & reconciliation --

  private bootstrapFromFiles(files: CanvasFileEntry[]): void {
    this.applyRemote(() => {
      // First pass: create frames (directories)
      const dirs = files.filter((f) => f.type === "directory");
      for (const dir of dirs) {
        if (this.fileToShape.has(dir.path)) continue;
        // Only create top-level directories as frames
        if (dir.path.includes("/")) continue;

        const id = createShapeId();
        const pos = this.findOpenPosition();
        this.editor.createShape({
          id,
          type: "frame",
          x: pos.x,
          y: pos.y,
          props: {
            w: DEFAULT_FRAME_WIDTH,
            h: DEFAULT_FRAME_HEIGHT,
            name: dir.path,
          },
        });
        this.shapeToFile.set(id, dir.path);
        this.fileToShape.set(dir.path, id);
      }

      // Second pass: create file shapes
      const fileEntries = files.filter((f) => f.type !== "directory");
      for (const file of fileEntries) {
        if (this.fileToShape.has(file.path)) continue;

        if (file.type === "named_text") {
          const name = pathToName(file.path);
          const dir = pathToDir(file.path);
          const parentId = dir ? this.getFrameShapeId(dir) : null;
          const id = createShapeId();

          if (parentId) {
            const pos = this.findPositionInFrame(parentId);
            this.editor.createShape({
              id,
              type: "named_text",
              parentId: parentId as TLParentId,
              x: pos.x,
              y: pos.y,
              props: { name, text: file.content ?? "", w: DEFAULT_WIDTH },
            });
          } else {
            const pos = this.findOpenPosition();
            this.editor.createShape({
              id,
              type: "named_text",
              x: pos.x,
              y: pos.y,
              props: { name, text: file.content ?? "", w: DEFAULT_WIDTH },
            });
          }
          this.shapeToFile.set(id, file.path);
          this.fileToShape.set(file.path, id);
        }
      }
    });

    // Handle image files asynchronously (need to load dimensions)
    const imageFiles = files.filter((f) => f.type === "image" && !this.fileToShape.has(f.path));
    for (const file of imageFiles) {
      this.createImageFromFS({
        action: "created",
        path: file.path,
        isDirectory: false,
        timestamp: Date.now(),
      });
    }
  }

  private reconcileWithFiles(files: CanvasFileEntry[]): void {
    const currentFiles = new Set(files.map((f) => f.path));

    // Collect stale entries to remove
    const staleEntries: [string, string][] = [];
    for (const [path, shapeId] of this.fileToShape.entries()) {
      if (!currentFiles.has(path)) {
        staleEntries.push([path, shapeId]);
      }
    }

    // Remove shapes whose files no longer exist
    if (staleEntries.length > 0) {
      this.applyRemote(() => {
        for (const [path, shapeId] of staleEntries) {
          const shape = this.editor.getShape(shapeId as TLShapeId);
          if (shape) {
            this.editor.deleteShape(shapeId as TLShapeId);
          }
          this.shapeToFile.delete(shapeId);
          this.fileToShape.delete(path);
        }
      });
    }

    // Add shapes for files that don't have shapes yet
    const unmapped = files.filter((f) => !this.fileToShape.has(f.path));
    if (unmapped.length > 0) {
      this.bootstrapFromFiles(unmapped);
    }

    // Update text content for existing shapes
    const updates: { shapeId: string; content: string }[] = [];
    for (const file of files) {
      if (file.type !== "named_text" || file.content === undefined) continue;
      const shapeId = this.fileToShape.get(file.path);
      if (!shapeId) continue;
      const shape = this.editor.getShape(shapeId as TLShapeId);
      if (!shape || shape.type !== "named_text") continue;
      const currentText = (shape.props as { text: string }).text;
      if (currentText !== file.content) {
        updates.push({ shapeId, content: file.content });
      }
    }
    if (updates.length > 0) {
      this.applyRemote(() => {
        for (const { shapeId, content } of updates) {
          this.editor.updateShape({
            id: shapeId as TLShapeId,
            type: "named_text",
            props: { text: content },
          });
        }
      });
    }
  }

  // -- .canvas.json persistence --

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  private save(): void {
    const snapshot = getSnapshot(this.editor.store);
    const mapping: Record<string, string> = {};
    for (const [shapeId, path] of this.shapeToFile.entries()) {
      mapping[shapeId] = path;
    }
    this.sendMsg({
      type: "canvas_save",
      snapshot: snapshot as unknown as Record<string, unknown>,
      shapeToFile: mapping,
    });
  }

  // -- Helper methods --

  private getFramePath(parentId: string): string | null {
    // If parentId is a page ID (starts with "page:"), no frame path
    if (parentId.startsWith("page:")) return null;
    return this.shapeToFile.get(parentId) ?? null;
  }

  private getFrameShapeId(dirPath: string): string | null {
    return this.fileToShape.get(dirPath) ?? null;
  }

  private inferShapeType(path: string): string | null {
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "txt" || ext === "md") return "named_text";
    if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext ?? "")) return "image";
    return null;
  }

  private findOpenPosition(): { x: number; y: number } {
    // Collect page-level bounds of all top-level shapes
    const shapeBounds: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of this.editor.getCurrentPageShapeIds()) {
      const shape = this.editor.getShape(id);
      if (!shape) continue;
      // Only consider top-level shapes (not children of frames)
      if (shape.parentId !== this.editor.getCurrentPageId()) continue;
      const bounds = this.editor.getShapePageBounds(shape);
      if (bounds) {
        shapeBounds.push({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
      }
    }

    if (shapeBounds.length === 0) {
      // Place near viewport center
      try {
        const center = this.editor.getViewportScreenCenter();
        const pagePoint = this.editor.screenToPage(center);
        return { x: Math.round(pagePoint.x - DEFAULT_WIDTH / 2), y: Math.round(pagePoint.y) };
      } catch {
        return { x: 100, y: 100 };
      }
    }

    // Try placing near viewport center first
    try {
      const center = this.editor.getViewportScreenCenter();
      const pageCenter = this.editor.screenToPage(center);
      const candidate = {
        x: Math.round(pageCenter.x - DEFAULT_WIDTH / 2),
        y: Math.round(pageCenter.y),
      };
      if (!this.overlapsAny(candidate.x, candidate.y, DEFAULT_WIDTH, 60, shapeBounds)) {
        return candidate;
      }
    } catch {
      // fallback below
    }

    // Find a column-based layout position: place in the first column that has space
    // Sort existing shapes by x to find columns
    let maxY = 0;
    let columnX = 100;
    for (const b of shapeBounds) {
      const bottom = b.y + b.h;
      if (bottom > maxY) {
        maxY = bottom;
        columnX = b.x;
      }
    }

    const candidate = { x: columnX, y: maxY + SHAPE_SPACING };
    if (!this.overlapsAny(candidate.x, candidate.y, DEFAULT_WIDTH, 60, shapeBounds)) {
      return candidate;
    }

    // Last resort: place to the right of all existing shapes
    let maxRight = 0;
    for (const b of shapeBounds) {
      maxRight = Math.max(maxRight, b.x + b.w);
    }
    return { x: maxRight + SHAPE_SPACING * 2, y: shapeBounds[0]?.y ?? 100 };
  }

  private overlapsAny(
    x: number,
    y: number,
    w: number,
    h: number,
    bounds: { x: number; y: number; w: number; h: number }[],
  ): boolean {
    for (const b of bounds) {
      if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) {
        return true;
      }
    }
    return false;
  }

  private findPositionInFrame(frameShapeId: string): { x: number; y: number } {
    const childIds = this.editor.getSortedChildIdsForParent(frameShapeId as TLShapeId);
    if (childIds.length === 0) {
      return { x: FRAME_INNER_PADDING, y: FRAME_HEADER_OFFSET };
    }

    // Stack below existing children with consistent spacing
    let maxBottom = 0;
    for (const childId of childIds) {
      const child = this.editor.getShape(childId);
      if (!child) continue;
      const geom = this.editor.getShapeGeometry(childId);
      const h = geom ? geom.bounds.h : 60;
      const bottom = child.y + h;
      if (bottom > maxBottom) maxBottom = bottom;
    }

    return { x: FRAME_INNER_PADDING, y: maxBottom + SHAPE_SPACING };
  }
}
