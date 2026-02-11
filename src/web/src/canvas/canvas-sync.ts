import {
  AssetRecordType,
  createShapeId,
  type Editor,
  getSnapshot,
  getSvgAsImage,
  loadSnapshot,
  type TLAssetId,
  type TLParentId,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  type TLStoreEventInfo,
} from "tldraw";
import type {
  CanvasFileEntry,
  CanvasFSEvent,
  CanvasSyncChange,
  ClientMessage,
} from "../../../shared/protocol.js";
import { buildCacheBustedSrc, detectMovesEnhanced, ensureUniquePath } from "./canvas-sync-utils.js";

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

function isAnnotatedPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  return base.endsWith("_annotated");
}

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

interface KnownMeta {
  size?: number;
  mtimeMs?: number;
  content?: string;
  isDirectory?: boolean;
}

// Layout constants
const SHAPE_SPACING = 20;
const DEFAULT_WIDTH = 200;
const DEFAULT_FRAME_WIDTH = 320;
const DEFAULT_FRAME_HEIGHT = 200;
const FRAME_INNER_PADDING = 40;
const FRAME_HEADER_OFFSET = 56; // Space below frame header (32px header + 24px gap)
const FADE_IN_DURATION = 300;
const FADE_OUT_DURATION = 200;
const MAX_IMAGE_DISPLAY_DIM = 480;

const ANNOTATION_DEBOUNCE_MS = 800;

function scaleImageDisplay(w: number, h: number): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 300, h: 200 };
  if (w <= MAX_IMAGE_DISPLAY_DIM && h <= MAX_IMAGE_DISPLAY_DIM) return { w, h };
  const scale = MAX_IMAGE_DISPLAY_DIM / Math.max(w, h);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

export class CanvasSync {
  private editor: Editor;
  private sendMsg: (msg: ClientMessage) => void;
  private shapeToFile = new Map<string, string>(); // shapeId -> relative path
  private fileToShape = new Map<string, string>(); // relative path -> shapeId
  private knownPaths = new Set<string>();
  private knownMeta = new Map<string, KnownMeta>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  // Shapes pending fade-out deletion (ignore FS events for these)
  private pendingDeletes = new Set<string>();
  // Annotation export state
  private annotationTimer: ReturnType<typeof setTimeout> | null = null;
  // Track which images currently have annotated exports (to know when to delete)
  private annotatedImages = new Set<string>(); // image shapeId

  constructor(editor: Editor, sendMsg: (msg: ClientMessage) => void) {
    this.editor = editor;
    this.sendMsg = sendMsg;
  }

  // Public accessors for external consumers (selection hook, @ mention)
  getShapeToFile(): ReadonlyMap<string, string> {
    return this.shapeToFile;
  }

  getFileToShape(): ReadonlyMap<string, string> {
    return this.fileToShape;
  }

  // Get all canvas items for @ mention autocomplete
  getAllCanvasItems(): {
    shapeId: string;
    path: string;
    type: "text" | "image" | "frame";
    name: string;
  }[] {
    const items: {
      shapeId: string;
      path: string;
      type: "text" | "image" | "frame";
      name: string;
    }[] = [];
    for (const [shapeId, path] of this.shapeToFile) {
      const shape = this.editor.getShape(shapeId as TLShapeId);
      if (!shape) continue;
      let type: "text" | "image" | "frame";
      let name: string;
      if (shape.type === "named_text") {
        type = "text";
        name = (shape.props as { name: string }).name;
      } else if (shape.type === "image") {
        type = "image";
        name = path.split("/").pop() ?? path;
      } else if (shape.type === "frame") {
        type = "frame";
        name = (shape.props as { name: string }).name;
      } else {
        continue;
      }
      items.push({ shapeId, path, type, name });
    }
    // Sort: frames first, then alphabetical
    items.sort((a, b) => {
      if (a.type === "frame" && b.type !== "frame") return -1;
      if (a.type !== "frame" && b.type === "frame") return 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  }

  // Add an image from base64 data: upload to server, create asset + shape.
  // Returns shapeId and path for the caller to reference.
  async addImageFromBase64(
    base64: string,
    mimeType: string,
  ): Promise<{ shapeId: string; path: string }> {
    const ext =
      { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[
        mimeType
      ] ?? "png";
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const fileName = `paste-${mm}${dd}-${hh}${mi}${ss}.${ext}`;

    // Decode base64 and upload to server
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const file = new File([blob], fileName, { type: mimeType });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("fileName", fileName);
    const res = await fetch("/canvas/upload", { method: "POST", body: formData });
    if (!res.ok) throw new Error("Upload failed");
    const { src } = (await res.json()) as { src: string };
    const path = src.slice("/canvas/".length);

    // Get image dimensions from data URL
    const { w, h } = await loadImageDimensions(`data:${mimeType};base64,${base64}`);
    const { w: displayW, h: displayH } = scaleImageDisplay(w, h);

    const assetId = AssetRecordType.createId();
    const shapeId = createShapeId();
    const pos = this.findOpenPosition();

    this.applyRemote(() => {
      this.editor.createAssets([
        AssetRecordType.create({
          id: assetId,
          type: "image",
          props: {
            w,
            h,
            name: path.split("/").pop() ?? path,
            isAnimated: mimeType === "image/gif",
            mimeType,
            src,
          },
        }),
      ]);
      this.editor.createShape({
        id: shapeId,
        type: "image",
        x: pos.x,
        y: pos.y,
        opacity: 0,
        props: { w: displayW, h: displayH, assetId: assetId as TLAssetId },
      });
    });

    requestAnimationFrame(() => {
      this.editor.animateShapes([{ id: shapeId, type: "image" as const, opacity: 1 as const }], {
        animation: { duration: FADE_IN_DURATION },
      });
    });

    this.shapeToFile.set(shapeId, path);
    this.fileToShape.set(path, shapeId);
    this.rememberPath(path, { isDirectory: false });
    this.scheduleSave();
    this.scheduleAnnotationCheck();

    return { shapeId, path };
  }

  // Wrap shape mutations in mergeRemoteChanges so the store listener
  // (source: 'user') ignores them, preventing canvas->FS->canvas loops.
  private applyRemote(fn: () => void): void {
    this.editor.store.mergeRemoteChanges(fn);
  }

  private seedKnownFromFiles(files: CanvasFileEntry[]): void {
    this.knownPaths.clear();
    this.knownMeta.clear();
    for (const file of files) {
      this.knownPaths.add(file.path);
      this.knownMeta.set(file.path, {
        size: file.size,
        mtimeMs: file.mtimeMs,
        content: file.content,
        isDirectory: file.type === "directory",
      });
    }
  }

  private rememberPath(path: string, meta?: KnownMeta): void {
    this.knownPaths.add(path);
    if (meta) {
      const prev = this.knownMeta.get(path) ?? {};
      this.knownMeta.set(path, { ...prev, ...meta });
    }
  }

  private forgetPath(path: string): void {
    this.knownPaths.delete(path);
    this.knownMeta.delete(path);
  }

  private applyKnownEvent(event: CanvasFSEvent): void {
    if (event.action === "deleted") {
      this.forgetPath(event.path);
      return;
    }
    this.rememberPath(event.path, {
      size: event.size,
      mtimeMs: event.mtimeMs,
      content: event.content,
      isDirectory: event.isDirectory,
    });
  }

  private updateImageAssetName(shapeId: string, fileName: string): void {
    const shape = this.editor.getShape(shapeId as TLShapeId);
    if (!shape || shape.type !== "image") return;
    const assetId = (shape.props as { assetId?: string }).assetId;
    if (!assetId) return;
    const asset = this.editor.getAsset(assetId as TLAssetId);
    if (!asset || asset.type !== "image") return;
    if (asset.props.name === fileName) return;
    this.applyRemote(() => {
      this.editor.updateAssets([{ ...asset, props: { ...asset.props, name: fileName } }]);
    });
  }

  private tryClampImageShape(shapeId: string, assetId: string | null, attempt = 0): void {
    if (!assetId) return;
    const shape = this.editor.getShape(shapeId as TLShapeId);
    if (!shape || shape.type !== "image") return;
    const asset = this.editor.getAsset(assetId as TLAssetId);
    if (asset?.type !== "image") {
      if (attempt < 20) {
        setTimeout(() => this.tryClampImageShape(shapeId, assetId, attempt + 1), 200);
      }
      return;
    }

    const { w, h } = asset.props as { w: number; h: number };
    const { w: displayW, h: displayH } = scaleImageDisplay(w, h);
    const { w: currentW, h: currentH } = shape.props as { w: number; h: number };
    if (currentW <= displayW && currentH <= displayH) return;

    this.applyRemote(() => {
      this.editor.updateShape({
        id: shapeId as TLShapeId,
        type: "image",
        props: { w: displayW, h: displayH },
      });
    });
  }

  private clampLargeImagesOnLoad(): void {
    this.applyRemote(() => {
      for (const shapeId of this.editor.getCurrentPageShapeIds()) {
        const shape = this.editor.getShape(shapeId);
        if (!shape || shape.type !== "image") continue;
        const assetId = (shape.props as { assetId?: string }).assetId;
        if (!assetId) continue;
        const asset = this.editor.getAsset(assetId as TLAssetId);
        if (!asset || asset.type !== "image") continue;
        const { w, h } = asset.props as { w: number; h: number };
        const { w: currentW, h: currentH } = shape.props as { w: number; h: number };
        if (Math.round(currentW) !== Math.round(w) || Math.round(currentH) !== Math.round(h)) {
          continue;
        }
        const { w: displayW, h: displayH } = scaleImageDisplay(w, h);
        if (displayW === currentW && displayH === currentH) continue;
        this.editor.updateShape({
          id: shapeId as TLShapeId,
          type: "image",
          props: { w: displayW, h: displayH },
        });
      }
    });
  }

  private async refreshImageAsset(
    shapeId: TLShapeId,
    relPath: string,
    mtimeMs?: number,
  ): Promise<void> {
    const shape = this.editor.getShape(shapeId as TLShapeId);
    if (!shape || shape.type !== "image") return;
    const assetId = (shape.props as { assetId?: string }).assetId;
    if (!assetId) return;
    const asset = this.editor.getAsset(assetId as TLAssetId);
    if (!asset || asset.type !== "image") return;

    const src = buildCacheBustedSrc(relPath, mtimeMs);
    const { w, h } = await loadImageDimensions(src);
    this.applyRemote(() => {
      this.editor.updateAssets([
        {
          ...asset,
          props: {
            ...asset.props,
            src,
            w,
            h,
          },
        },
      ]);
    });
  }

  // Initialize from server state
  init(
    snapshot: Record<string, unknown> | null,
    shapeToFile: Record<string, string>,
    files: CanvasFileEntry[],
  ): void {
    this.seedKnownFromFiles(files);
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

    this.clampLargeImagesOnLoad();

    // Fit viewport to show all content after initial load
    requestAnimationFrame(() => {
      this.editor.zoomToFit({ animation: { duration: 300 } });
    });

    this.startListening();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.annotationTimer) {
      clearTimeout(this.annotationTimer);
      this.annotationTimer = null;
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
    let drawShapeChanged = false;
    let imageShapeChanged = false;

    // Handle added shapes
    for (const record of Object.values(added)) {
      if (record.typeName !== "shape") continue;
      const shape = record as unknown as {
        id: string;
        type: string;
        parentId: string;
        x: number;
        y: number;
        props: Record<string, unknown>;
      };
      if (shape.type === "draw") drawShapeChanged = true;
      if (shape.type === "image") imageShapeChanged = true;
      const change = this.handleShapeCreated(shape);
      if (change) changes.push(change);
    }

    // Handle updated records (shapes + assets)
    for (const [from, to] of Object.values(updated)) {
      // When an image asset's src changes to /canvas/..., register the mapping
      if (to.typeName === "asset") {
        this.handleAssetUpdated(
          from as unknown as { id: string; type: string; props: Record<string, unknown> },
          to as unknown as { id: string; type: string; props: Record<string, unknown> },
        );
        continue;
      }
      if (from.typeName !== "shape") continue;
      const fromShape = from as unknown as {
        id: string;
        type: string;
        parentId: string;
        x: number;
        y: number;
        props: Record<string, unknown>;
      };
      const toShape = to as unknown as {
        id: string;
        type: string;
        parentId: string;
        x: number;
        y: number;
        props: Record<string, unknown>;
      };
      if (toShape.type === "draw") drawShapeChanged = true;
      if (toShape.type === "image") {
        const fromProps = fromShape.props as { w?: number; h?: number };
        const toProps = toShape.props as { w?: number; h?: number };
        if (
          fromShape.parentId !== toShape.parentId ||
          fromShape.x !== toShape.x ||
          fromShape.y !== toShape.y ||
          fromProps.w !== toProps.w ||
          fromProps.h !== toProps.h
        ) {
          imageShapeChanged = true;
        }
      }
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
      if (shape.type === "draw") drawShapeChanged = true;
      changes.push(...this.handleShapeDeleted(shape));
    }

    if (changes.length > 0) {
      this.sendMsg({ type: "canvas_sync", changes });
    }

    // If draw shapes changed, schedule annotation export check
    if (drawShapeChanged || imageShapeChanged) {
      this.scheduleAnnotationCheck();
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
      const desiredPath = nameToTxtPath(name, parentPath);
      const path = ensureUniquePath(desiredPath, this.knownPaths);
      if (path !== desiredPath) {
        const dedupedName = pathToName(path);
        this.applyRemote(() => {
          this.editor.updateShape({
            id: shape.id as TLShapeId,
            type: "named_text",
            props: { name: dedupedName },
          });
        });
      }
      this.shapeToFile.set(shape.id, path);
      this.fileToShape.set(path, shape.id);
      this.rememberPath(path, { content: text, isDirectory: false });
      return { action: "create", shapeType: "named_text", path, content: text };
    }
    if (shape.type === "frame") {
      const name = (shape.props.name as string) || "untitled";
      const desiredPath = name;
      const path = ensureUniquePath(desiredPath, this.knownPaths);
      if (path !== desiredPath) {
        this.applyRemote(() => {
          this.editor.updateShape({
            id: shape.id as TLShapeId,
            type: "frame",
            props: { name: path },
          });
        });
      }
      this.shapeToFile.set(shape.id, path);
      this.fileToShape.set(path, shape.id);
      this.rememberPath(path, { isDirectory: true });
      return { action: "create", shapeType: "frame", path };
    }
    if (shape.type === "image") {
      // Image was uploaded via assets.upload which already wrote the file.
      // Register the mapping from the asset src URL.
      this.tryRegisterImageMapping(shape.id, shape.props.assetId as string | null);
      this.tryClampImageShape(shape.id, shape.props.assetId as string | null);
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
        const desiredPath = nameToTxtPath(newName, newParentPath);
        const newPath = ensureUniquePath(desiredPath, this.knownPaths, oldPath);
        if (newPath !== desiredPath) {
          const dedupedName = pathToName(newPath);
          this.applyRemote(() => {
            this.editor.updateShape({
              id: to.id as TLShapeId,
              type: "named_text",
              props: { name: dedupedName },
            });
          });
        }
        this.fileToShape.delete(oldPath);
        this.shapeToFile.set(to.id, newPath);
        this.fileToShape.set(newPath, to.id);
        this.forgetPath(oldPath);
        this.rememberPath(newPath, { content: newText, isDirectory: false });
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
        const desiredPath = nameToTxtPath(newName, parentPath);
        const newPath = ensureUniquePath(desiredPath, this.knownPaths, oldPath);
        if (newPath !== desiredPath) {
          const dedupedName = pathToName(newPath);
          this.applyRemote(() => {
            this.editor.updateShape({
              id: to.id as TLShapeId,
              type: "named_text",
              props: { name: dedupedName },
            });
          });
        }
        this.fileToShape.delete(oldPath);
        this.shapeToFile.set(to.id, newPath);
        this.fileToShape.set(newPath, to.id);
        this.forgetPath(oldPath);
        this.rememberPath(newPath, { content: newText, isDirectory: false });
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
    } else if (to.type === "image") {
      const oldPath = this.shapeToFile.get(to.id);
      if (!oldPath) return changes;

      // Check for reparenting (moved in/out of frame)
      if (from.parentId !== to.parentId) {
        const fileName = oldPath.split("/").pop() ?? oldPath;
        const newParentPath = this.getFramePath(to.parentId);
        const desiredPath = newParentPath ? `${newParentPath}/${fileName}` : fileName;
        const newPath = ensureUniquePath(desiredPath, this.knownPaths, oldPath);
        const newFileName = newPath.split("/").pop() ?? newPath;
        if (newFileName !== fileName) {
          this.updateImageAssetName(to.id, newFileName);
        }
        this.fileToShape.delete(oldPath);
        this.shapeToFile.set(to.id, newPath);
        this.fileToShape.set(newPath, to.id);
        this.forgetPath(oldPath);
        this.rememberPath(newPath, { isDirectory: false });
        changes.push({
          action: "move",
          shapeType: "image",
          path: newPath,
          oldPath,
        });
        // Also move annotated export if it exists
        if (this.annotatedImages.has(to.id)) {
          const oldAnnotated = this.makeAnnotatedPath(oldPath);
          const newAnnotated = this.makeAnnotatedPath(newPath);
          changes.push({
            action: "move",
            shapeType: "image",
            path: newAnnotated,
            oldPath: oldAnnotated,
          });
        }
      }
    } else if (to.type === "frame") {
      const oldPath = this.shapeToFile.get(to.id);
      if (!oldPath) return changes;

      const oldName = from.props.name as string;
      const newName = to.props.name as string;

      if (oldName !== newName) {
        // Frame renamed -> rename directory and update all children mappings
        const desiredPath = newName;
        const uniquePath = ensureUniquePath(desiredPath, this.knownPaths, oldPath);
        if (uniquePath !== desiredPath) {
          this.applyRemote(() => {
            this.editor.updateShape({
              id: to.id as TLShapeId,
              type: "frame",
              props: { name: uniquePath },
            });
          });
        }
        this.fileToShape.delete(oldPath);
        this.shapeToFile.set(to.id, uniquePath);
        this.fileToShape.set(uniquePath, to.id);
        this.forgetPath(oldPath);
        this.rememberPath(uniquePath, { isDirectory: true });
        // Update children paths
        for (const [shapeId, filePath] of this.shapeToFile.entries()) {
          if (shapeId === to.id) continue;
          if (filePath.startsWith(`${oldPath}/`)) {
            const newChildPath = uniquePath + filePath.slice(oldPath.length);
            this.shapeToFile.set(shapeId, newChildPath);
            this.fileToShape.delete(filePath);
            this.fileToShape.set(newChildPath, shapeId);
            this.forgetPath(filePath);
            this.rememberPath(newChildPath, { isDirectory: false });
          }
        }
        changes.push({
          action: "rename",
          shapeType: "frame",
          path: uniquePath,
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
  }): CanvasSyncChange[] {
    const path = this.shapeToFile.get(shape.id);
    if (!path) return [];

    this.shapeToFile.delete(shape.id);
    this.fileToShape.delete(path);
    this.forgetPath(path);

    if (shape.type === "named_text") {
      return [{ action: "delete", shapeType: "named_text", path }];
    }
    if (shape.type === "frame") {
      // Remove all children mappings too
      const prefix = `${path}/`;
      for (const [sid, fp] of this.shapeToFile.entries()) {
        if (fp.startsWith(prefix)) {
          this.shapeToFile.delete(sid);
          this.fileToShape.delete(fp);
          this.forgetPath(fp);
        }
      }
      return [{ action: "delete", shapeType: "frame", path }];
    }
    if (shape.type === "image") {
      const result: CanvasSyncChange[] = [{ action: "delete", shapeType: "image", path }];
      // Also delete the annotated export if it exists
      if (this.annotatedImages.has(shape.id)) {
        this.annotatedImages.delete(shape.id);
        result.push({ action: "delete", shapeType: "image", path: this.makeAnnotatedPath(path) });
      }
      return result;
    }
    return [];
  }

  // When an image asset gets its src updated (upload complete), register the mapping
  private handleAssetUpdated(
    _from: { id: string; type: string; props: Record<string, unknown> },
    to: { id: string; type: string; props: Record<string, unknown> },
  ): void {
    if (to.type !== "image") return;
    const newSrc = to.props.src as string | undefined;
    if (!newSrc?.startsWith("/canvas/")) return;

    const path = newSrc.slice("/canvas/".length);
    if (this.fileToShape.has(path)) return;

    // Find the image shape referencing this asset
    for (const shapeId of this.editor.getCurrentPageShapeIds()) {
      const shape = this.editor.getShape(shapeId);
      if (!shape || shape.type !== "image") continue;
      const assetId = (shape.props as unknown as Record<string, unknown>).assetId as
        | string
        | undefined;
      if (assetId === to.id && !this.shapeToFile.has(shape.id)) {
        this.shapeToFile.set(shape.id, path);
        this.fileToShape.set(path, shape.id);
        this.rememberPath(path, { isDirectory: false });
        break;
      }
    }
  }

  // Try to register image shape mapping, retry if asset src not yet available
  private tryRegisterImageMapping(shapeId: string, assetId: string | null, attempt = 0): void {
    if (!assetId || this.shapeToFile.has(shapeId)) return;

    const asset = this.editor.getAsset(assetId as TLAssetId);
    if (asset?.type === "image" && asset.props.src) {
      const src = asset.props.src as string;
      if (src.startsWith("/canvas/")) {
        const path = src.slice("/canvas/".length);
        this.shapeToFile.set(shapeId, path);
        this.fileToShape.set(path, shapeId);
        this.rememberPath(path, { isDirectory: false });
        return;
      }
    }

    // Asset src not yet available (still uploading), retry
    if (attempt < 20) {
      setTimeout(() => this.tryRegisterImageMapping(shapeId, assetId, attempt + 1), 500);
    }
  }

  // -- FS -> Canvas sync (agent/external edits) --

  handleFSChanges(changes: CanvasFSEvent[]): void {
    // Categorize changes
    const syncCreates: CanvasFSEvent[] = [];
    const syncModifies: CanvasFSEvent[] = [];
    const syncDeletes: CanvasFSEvent[] = [];
    const asyncImageCreates: CanvasFSEvent[] = [];

    for (const change of changes) {
      // Skip _annotated files -- they're managed by the annotation export system
      if (isAnnotatedPath(change.path)) continue;

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
    const createCandidates = [...syncCreates, ...asyncImageCreates];
    const moves = this.detectMoves(syncDeletes, createCandidates);
    for (const move of moves) {
      // Remove from pending create/delete lists
      const delIdx = syncDeletes.indexOf(move.deleteEvent);
      if (delIdx >= 0) syncDeletes.splice(delIdx, 1);
      const createIdx = syncCreates.indexOf(move.createEvent);
      if (createIdx >= 0) {
        syncCreates.splice(createIdx, 1);
      } else {
        const asyncIdx = asyncImageCreates.indexOf(move.createEvent);
        if (asyncIdx >= 0) asyncImageCreates.splice(asyncIdx, 1);
      }
    }

    // Handle moves with reparent animation
    if (moves.length > 0) {
      this.handleFSMoves(moves);
      for (const move of moves) {
        const oldMeta = this.knownMeta.get(move.deleteEvent.path);
        this.forgetPath(move.deleteEvent.path);
        this.rememberPath(move.createEvent.path, {
          size: move.createEvent.size ?? oldMeta?.size,
          mtimeMs: move.createEvent.mtimeMs ?? oldMeta?.mtimeMs,
          content: move.createEvent.content ?? oldMeta?.content,
          isDirectory: move.createEvent.isDirectory ?? oldMeta?.isDirectory,
        });
      }
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
      for (const change of toProcess) {
        this.applyKnownEvent(change);
      }
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
      this.applyKnownEvent(change);
    }

    // Handle async image creates
    for (const change of asyncImageCreates) {
      this.createImageFromFS(change);
      this.applyKnownEvent(change);
    }

    // Zoom to fit after folder create/delete so the new layout is fully visible
    const hasDirChange = changes.some(
      (c) => c.isDirectory && (c.action === "created" || c.action === "deleted"),
    );
    if (hasDirChange) {
      const delay = Math.max(FADE_IN_DURATION, FADE_OUT_DURATION) + 100;
      setTimeout(() => {
        this.editor.zoomToFit({ animation: { duration: 300 } });
      }, delay);
    }

    this.scheduleSave();
  }

  private detectMoves(
    deletes: CanvasFSEvent[],
    creates: CanvasFSEvent[],
  ): { deleteEvent: CanvasFSEvent; createEvent: CanvasFSEvent }[] {
    const eligibleDeletes = deletes.filter(
      (del) => !del.isDirectory && this.fileToShape.has(del.path),
    );
    return detectMovesEnhanced(eligibleDeletes, creates, this.knownMeta);
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
      const shapeBounds = oldPageBounds
        ? { w: oldPageBounds.w, h: oldPageBounds.h }
        : { w: DEFAULT_WIDTH, h: 60 };
      const newPos = newParentId
        ? this.findPositionInFrame(newParentId)
        : this.findOpenPosition(shapeBounds.w, shapeBounds.h);

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

        if (shape.type === "named_text") {
          const newName = pathToName(createEvent.path);
          const currentName = (shape.props as { name?: string }).name;
          if (newName && newName !== currentName) {
            this.editor.updateShape({
              id: shapeId as TLShapeId,
              type: "named_text",
              props: { name: newName },
            });
          }
        }
      });

      if (shape.type === "image") {
        const newFileName = createEvent.path.split("/").pop() ?? createEvent.path;
        this.updateImageAssetName(shapeId, newFileName);
        this.scheduleAnnotationCheck();
      }

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
      const pos = this.findOpenPosition(DEFAULT_FRAME_WIDTH, DEFAULT_FRAME_HEIGHT);
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
    if (isAnnotatedPath(event.path)) return;

    const name = pathToName(event.path);
    const src = `/canvas/${event.path}`;
    const mimeType = getImageMimeType(event.path);

    // Load image to get dimensions
    const { w, h } = await loadImageDimensions(src);

    // Scale down large images to reasonable canvas size
    const { w: displayW, h: displayH } = scaleImageDisplay(w, h);

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
    this.scheduleAnnotationCheck();
  }

  private handleFSModified(event: CanvasFSEvent): void {
    if (event.isDirectory) return;
    const shapeId = this.fileToShape.get(event.path);
    if (!shapeId) return;

    const shape = this.editor.getShape(shapeId as TLShapeId);
    if (!shape) return;

    if (shape.type === "named_text" && event.content !== undefined) {
      this.editor.updateShape({
        id: shapeId as TLShapeId,
        type: "named_text",
        props: { text: event.content },
      });
      return;
    }

    if (shape.type === "image") {
      void this.refreshImageAsset(shapeId as TLShapeId, event.path, event.mtimeMs);
      this.scheduleAnnotationCheck();
    }
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
        const pos = this.findOpenPosition(DEFAULT_FRAME_WIDTH, DEFAULT_FRAME_HEIGHT);
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
    const imageFiles = files.filter(
      (f) => f.type === "image" && !this.fileToShape.has(f.path) && !isAnnotatedPath(f.path),
    );
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

  private findOpenPosition(width = DEFAULT_WIDTH, height = 60): { x: number; y: number } {
    // Collect page-level bounds of all top-level shapes
    const allBounds: { x: number; y: number; w: number; h: number }[] = [];
    for (const id of this.editor.getCurrentPageShapeIds()) {
      const shape = this.editor.getShape(id);
      if (!shape) continue;
      if (shape.parentId !== this.editor.getCurrentPageId()) continue;
      const bounds = this.editor.getShapePageBounds(shape);
      if (bounds) {
        allBounds.push({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
      }
    }

    // Get current viewport in page coordinates
    let vp: { x: number; y: number; w: number; h: number } | null = null;
    try {
      const vpBounds = this.editor.getViewportPageBounds();
      vp = { x: vpBounds.x, y: vpBounds.y, w: vpBounds.w, h: vpBounds.h };
    } catch {
      // ignore
    }

    if (allBounds.length === 0) {
      if (vp) {
        return { x: Math.round(vp.x + vp.w / 2 - width / 2), y: Math.round(vp.y + vp.h / 2) };
      }
      return { x: 100, y: 100 };
    }

    // Find shapes visible in the current viewport
    const visibleBounds = vp
      ? allBounds.filter(
          (b) => b.x < vp.x + vp.w && b.x + b.w > vp.x && b.y < vp.y + vp.h && b.y + b.h > vp.y,
        )
      : [];

    // Use visible shapes if any, otherwise fall back to all shapes
    const refBounds = visibleBounds.length > 0 ? visibleBounds : allBounds;

    // Place to the right of the rightmost reference shape, top-aligned
    const topY = Math.min(...refBounds.map((b) => b.y));
    let maxRight = 0;
    for (const b of refBounds) {
      maxRight = Math.max(maxRight, b.x + b.w);
    }
    const candidate = { x: maxRight + SHAPE_SPACING * 2, y: topY };
    if (!this.overlapsAny(candidate.x, candidate.y, width, height, allBounds)) {
      return candidate;
    }

    // Fallback: scan right until we find a non-overlapping position
    let x = candidate.x;
    for (let i = 0; i < 50; i++) {
      x += SHAPE_SPACING;
      if (!this.overlapsAny(x, topY, width, height, allBounds)) {
        return { x, y: topY };
      }
    }
    return candidate;
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

    // Collect bounds of existing children (in frame-local coordinates)
    const childBounds: { x: number; y: number; w: number; h: number }[] = [];
    let maxW = DEFAULT_WIDTH;
    let maxH = 60;
    for (const childId of childIds) {
      const child = this.editor.getShape(childId);
      if (!child) continue;
      const geom = this.editor.getShapeGeometry(childId);
      const w = geom ? geom.bounds.w : DEFAULT_WIDTH;
      const h = geom ? geom.bounds.h : 60;
      childBounds.push({ x: child.x, y: child.y, w, h });
      maxW = Math.max(maxW, w);
      maxH = Math.max(maxH, h);
    }

    // Grid layout: max 5 per row, scan until we find a non-overlapping cell
    const MAX_PER_ROW = 5;
    const cellW = maxW + SHAPE_SPACING;
    const cellH = maxH + SHAPE_SPACING;
    for (let i = 0; i < 100; i++) {
      const col = i % MAX_PER_ROW;
      const row = Math.floor(i / MAX_PER_ROW);
      const x = FRAME_INNER_PADDING + col * cellW;
      const y = FRAME_HEADER_OFFSET + row * cellH;
      if (!this.overlapsAny(x, y, maxW, maxH, childBounds)) {
        return { x, y };
      }
    }

    // Fallback: place after last row
    const rows = Math.ceil(childIds.length / MAX_PER_ROW);
    return { x: FRAME_INNER_PADDING, y: FRAME_HEADER_OFFSET + rows * cellH };
  }

  // -- Organize canvas --

  organizeCanvas(): void {
    const pageId = this.editor.getCurrentPageId();

    // Collect top-level shapes (frame, named_text, image only)
    const topLevelIds: TLShapeId[] = [];
    for (const id of this.editor.getCurrentPageShapeIds()) {
      const shape = this.editor.getShape(id);
      if (!shape || shape.parentId !== pageId) continue;
      if (shape.type === "frame" || shape.type === "named_text" || shape.type === "image") {
        topLevelIds.push(shape.id);
      }
    }

    if (topLevelIds.length === 0) return;

    // Step 1: Organize children inside each frame, track computed sizes
    const frameSizes = new Map<TLShapeId, { w: number; h: number }>();
    for (const id of topLevelIds) {
      const shape = this.editor.getShape(id);
      if (shape?.type === "frame") {
        const size = this.organizeFrameChildren(id);
        if (size) frameSizes.set(id, size);
      }
    }

    // Step 2: Sort top-level shapes: frames first, then text, then images
    const typeOrder: Record<string, number> = { frame: 0, named_text: 1, image: 2 };
    topLevelIds.sort((a, b) => {
      const sa = this.editor.getShape(a);
      const sb = this.editor.getShape(b);
      const orderA = typeOrder[sa?.type ?? ""] ?? 3;
      const orderB = typeOrder[sb?.type ?? ""] ?? 3;
      if (orderA !== orderB) return orderA - orderB;
      return this.getShapeSortName(a).localeCompare(this.getShapeSortName(b));
    });

    // Step 3: Adaptive greedy row packing
    // Target ~3 items per row by using median width to compute max row width
    const gap = SHAPE_SPACING * 2;

    // Collect sizes for all shapes
    const sizes: { id: TLShapeId; type: TLShape["type"]; w: number; h: number }[] = [];
    for (const id of topLevelIds) {
      const shape = this.editor.getShape(id);
      if (!shape) continue;
      const knownSize = frameSizes.get(id);
      const bounds = knownSize ?? this.editor.getShapePageBounds(id);
      if (!bounds) continue;
      sizes.push({ id, type: shape.type, w: bounds.w, h: bounds.h });
    }

    // Compute max row width from median element width * 3
    const sortedWidths = sizes.map((s) => s.w).sort((a, b) => a - b);
    const medianW = sortedWidths[Math.floor(sortedWidths.length / 2)] ?? DEFAULT_WIDTH;
    const maxRowWidth = medianW * 3 + gap * 2;

    // Greedy row packing
    const updates: TLShapePartial[] = [];
    let curX = 0;
    let curY = 0;
    let rowMaxHeight = 0;

    for (const item of sizes) {
      if (curX > 0 && curX + item.w > maxRowWidth) {
        curX = 0;
        curY += rowMaxHeight + gap;
        rowMaxHeight = 0;
      }
      updates.push({ id: item.id, type: item.type, x: curX, y: curY });
      curX += item.w + gap;
      rowMaxHeight = Math.max(rowMaxHeight, item.h);
    }

    // Step 4: Animate to new positions
    this.editor.animateShapes(updates, { animation: { duration: 300 } });

    // Step 5: Zoom to fit after animation completes
    setTimeout(() => {
      this.editor.zoomToFit({ animation: { duration: 300 } });
    }, 350);

    this.scheduleSave();
  }

  private organizeFrameChildren(frameId: TLShapeId): { w: number; h: number } | null {
    const childIds = this.editor.getSortedChildIdsForParent(frameId);
    if (childIds.length === 0) {
      const shape = this.editor.getShape(frameId);
      if (!shape) return null;
      const props = shape.props as { w: number; h: number };
      return { w: props.w, h: props.h };
    }

    // Collect only named_text and image children
    const children: { id: TLShapeId; type: TLShape["type"]; w: number; h: number }[] = [];
    for (const childId of childIds) {
      const child = this.editor.getShape(childId);
      if (!child) continue;
      if (child.type !== "named_text" && child.type !== "image") continue;
      const geom = this.editor.getShapeGeometry(childId);
      const w = geom ? geom.bounds.w : DEFAULT_WIDTH;
      const h = geom ? geom.bounds.h : 60;
      children.push({ id: childId, type: child.type, w, h });
    }

    if (children.length === 0) {
      const shape = this.editor.getShape(frameId);
      if (!shape) return null;
      const props = shape.props as { w: number; h: number };
      return { w: props.w, h: props.h };
    }

    const MAX_PER_ROW = 5;
    let maxW = 0;
    let maxH = 0;
    for (const child of children) {
      maxW = Math.max(maxW, child.w);
      maxH = Math.max(maxH, child.h);
    }

    const cellW = maxW + SHAPE_SPACING;
    const cellH = maxH + SHAPE_SPACING;
    const effectiveCols = Math.min(children.length, MAX_PER_ROW);
    const rows = Math.ceil(children.length / MAX_PER_ROW);

    // Update children positions
    for (let i = 0; i < children.length; i++) {
      const col = i % MAX_PER_ROW;
      const row = Math.floor(i / MAX_PER_ROW);
      this.editor.updateShape({
        id: children[i].id,
        type: children[i].type,
        x: FRAME_INNER_PADDING + col * cellW,
        y: FRAME_HEADER_OFFSET + row * cellH,
      });
    }

    // Compute and set frame size
    const frameW = Math.max(FRAME_INNER_PADDING * 2 + effectiveCols * cellW - SHAPE_SPACING, 240);
    const frameH = Math.max(
      FRAME_HEADER_OFFSET + rows * cellH - SHAPE_SPACING + FRAME_INNER_PADDING,
      120,
    );
    this.editor.updateShape({
      id: frameId,
      type: "frame",
      props: { w: frameW, h: frameH },
    });

    return { w: frameW, h: frameH };
  }

  private getShapeSortName(id: TLShapeId): string {
    const shape = this.editor.getShape(id);
    if (!shape) return "";
    if (shape.type === "named_text" || shape.type === "frame") {
      return (shape.props as { name: string }).name;
    }
    if (shape.type === "image") {
      return this.shapeToFile.get(shape.id)?.split("/").pop() ?? "";
    }
    return "";
  }

  // -- Annotation export --

  private scheduleAnnotationCheck(): void {
    if (this.annotationTimer) clearTimeout(this.annotationTimer);
    this.annotationTimer = setTimeout(() => {
      this.annotationTimer = null;
      this.checkAnnotations();
    }, ANNOTATION_DEBOUNCE_MS);
  }

  private checkAnnotations(): void {
    // Find all image shapes that have a file mapping
    const imageShapes: { id: TLShapeId; parentId: string; path: string }[] = [];
    for (const [shapeId, path] of this.shapeToFile.entries()) {
      const shape = this.editor.getShape(shapeId as TLShapeId);
      if (!shape || shape.type !== "image") continue;
      imageShapes.push({ id: shape.id, parentId: shape.parentId, path });
    }

    // For each image, find overlapping draw shapes
    for (const img of imageShapes) {
      const overlapping = this.findOverlappingDrawShapes(img.id);
      const wasAnnotated = this.annotatedImages.has(img.id);

      if (overlapping.length > 0) {
        // Has annotations: export flattened image
        this.annotatedImages.add(img.id);
        this.exportAnnotatedImage(img.id, img.path, overlapping);
      } else if (wasAnnotated) {
        // Was annotated but annotations removed: delete the annotated file
        this.annotatedImages.delete(img.id);
        const annotatedPath = this.makeAnnotatedPath(img.path);
        this.sendMsg({
          type: "canvas_sync",
          changes: [{ action: "delete", shapeType: "image", path: annotatedPath }],
        });
      }
    }
  }

  private findOverlappingDrawShapes(imageShapeId: TLShapeId): TLShapeId[] {
    const imgBounds = this.editor.getShapePageBounds(imageShapeId);
    const imgShape = this.editor.getShape(imageShapeId);
    if (!(imgBounds && imgShape)) return [];

    const result: TLShapeId[] = [];
    for (const id of this.editor.getCurrentPageShapeIds()) {
      const shape = this.editor.getShape(id);
      if (!shape || shape.type !== "draw") continue;
      // Must share parent (same frame or both on page)
      if (shape.parentId !== imgShape.parentId) continue;
      const drawBounds = this.editor.getShapePageBounds(id);
      if (!drawBounds) continue;
      // AABB overlap check
      if (
        drawBounds.x < imgBounds.x + imgBounds.w &&
        drawBounds.x + drawBounds.w > imgBounds.x &&
        drawBounds.y < imgBounds.y + imgBounds.h &&
        drawBounds.y + drawBounds.h > imgBounds.y
      ) {
        result.push(id);
      }
    }
    return result;
  }

  private makeAnnotatedPath(originalPath: string): string {
    const dotIdx = originalPath.lastIndexOf(".");
    if (dotIdx <= 0) return `${originalPath}_annotated`;
    return `${originalPath.slice(0, dotIdx)}_annotated.png`;
  }

  private async exportAnnotatedImage(
    imageShapeId: TLShapeId,
    originalPath: string,
    drawShapeIds: TLShapeId[],
  ): Promise<void> {
    const shapeIds = [imageShapeId, ...drawShapeIds];
    const svgResult = await this.editor.getSvgElement(shapeIds);
    if (!svgResult) return;

    const { svg, width, height } = svgResult;
    const svgString = new XMLSerializer().serializeToString(svg);
    const blob = await getSvgAsImage(svgString, {
      type: "png",
      width,
      height,
      pixelRatio: 2,
    });
    if (!blob) return;

    // Upload via existing endpoint
    const annotatedPath = this.makeAnnotatedPath(originalPath);
    const fileName = annotatedPath.split("/").pop() ?? annotatedPath;
    const formData = new FormData();
    formData.append("file", blob, fileName);
    formData.append("fileName", annotatedPath);
    try {
      await fetch("/canvas/upload-annotated", { method: "POST", body: formData });
    } catch {
      // Silently fail -- annotation export is best-effort
    }
  }
}
