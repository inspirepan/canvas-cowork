# Tldraw Library Source Code Research

This document provides comprehensive research on the tldraw library's source code, covering custom shape definitions, tool restrictions, frame shapes, store/snapshot APIs, shape events, and programmatic shape manipulation.

---

## 1. Custom Shape Definition

### 1.1 Overview

To define a custom shape in tldraw, you need to create a ShapeUtil class that extends either `ShapeUtil<T>` or `BaseBoxShapeUtil<T>`. The shape definition consists of:

1. **Shape Type Definition**: A TypeScript type defining the shape's structure
2. **ShapeUtil Class**: A class that handles rendering, interactions, and lifecycle events
3. **Props Definition**: Validation schema for shape properties
4. **Migrations**: Version handling for shape data evolution
5. **Components**: React components for rendering the shape on canvas

### 1.2 Base Classes

#### ShapeUtil (Abstract Base Class)
**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/editor/src/lib/editor/shapes/ShapeUtil.ts`

The `ShapeUtil` is the base class for all shape utilities. Key members:

```typescript
abstract class ShapeUtil<Shape extends TLShape = TLShape> {
    constructor(public editor: Editor) {}
    
    // Static properties for shape metadata
    static type: string
    static props?: RecordProps<TLUnknownShape>
    static migrations?: LegacyMigrations | TLPropsMigrations | MigrationSequence
    
    // Abstract methods (must be implemented)
    abstract getDefaultProps(): Shape['props']
    abstract getGeometry(shape: Shape, opts?: TLGeometryOpts): Geometry2d
    abstract component(shape: Shape): any
    abstract indicator(shape: Shape): any
    
    // Optional lifecycle callbacks
    onBeforeCreate?(next: Shape): Shape | void
    onBeforeUpdate?(prev: Shape, next: Shape): Shape | void
    onResize?(shape: Shape, info: TLResizeInfo<Shape>): TLShapePartial<Shape> | void
    // ... many more callbacks
}
```

#### BaseBoxShapeUtil
**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/editor/src/lib/editor/shapes/BaseBoxShapeUtil.tsx`

For shapes with width and height (like rectangles, frames, images), use `BaseBoxShapeUtil`:

```typescript
export type TLBaseBoxShape = ExtractShapeByProps<{ w: number; h: number }>

export abstract class BaseBoxShapeUtil<Shape extends TLBaseBoxShape> extends ShapeUtil<Shape> {
    getGeometry(shape: Shape): Geometry2d {
        return new Rectangle2d({
            width: shape.props.w,
            height: shape.props.h,
            isFilled: true,
        })
    }
    
    override onResize(shape: any, info: TLResizeInfo<any>) {
        return resizeBox(shape, info)
    }
}
```

### 1.3 Example: GeoShapeUtil

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tldraw/src/lib/shapes/geo/GeoShapeUtil.tsx`

Complete example of a custom shape with rendering and interactions:

```typescript
export class GeoShapeUtil extends BaseBoxShapeUtil<TLGeoShape> {
    static override type = 'geo' as const
    static override props = geoShapeProps
    static override migrations = geoShapeMigrations
    
    override options = {
        showTextOutline: true,
    }
    
    override canEdit() {
        return true
    }
    
    override getDefaultProps(): TLGeoShape['props'] {
        return {
            w: 100,
            h: 100,
            geo: 'rectangle',
            dash: 'draw',
            growY: 0,
            url: '',
            scale: 1,
            color: 'black',
            labelColor: 'black',
            fill: 'none',
            size: 'm',
            font: 'draw',
            align: 'middle',
            verticalAlign: 'middle',
            richText: toRichText(''),
        }
    }
    
    override getGeometry(shape: TLGeoShape): Geometry2d {
        // Custom geometry implementation
        const path = getGeoShapePath(shape)
        return path.toGeometry()
    }
    
    component(shape: TLGeoShape) {
        return (
            <>
                <SVGContainer>
                    <GeoShapeBody shape={shape} shouldScale={true} />
                </SVGContainer>
                <HTMLContainer>
                    <RichTextLabel {...} />
                </HTMLContainer>
            </>
        )
    }
    
    indicator(shape: TLGeoShape) {
        const path = getGeoShapePath(shape)
        return path.toSvg({...})
    }
    
    override onResize(
        shape: TLGeoShape,
        info: TLResizeInfo<TLGeoShape>
    ) {
        // Custom resize logic
        return {
            x: info.newPoint.x,
            y: info.newPoint.y,
            props: {
                w: Math.max(Math.abs(info.scaleX * shape.props.w), 1),
                h: Math.max(Math.abs(info.scaleY * shape.props.h), 1),
            },
        }
    }
}
```

### 1.4 Example: TextShapeUtil

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tldraw/src/lib/shapes/text/TextShapeUtil.tsx`

Example showing auto-sizing and editing:

```typescript
export class TextShapeUtil extends ShapeUtil<TLTextShape> {
    static override type = 'text' as const
    static override props = textShapeProps
    static override migrations = textShapeMigrations
    
    override canEdit() {
        return true
    }
    
    override isAspectRatioLocked() {
        return true
    }
    
    override onBeforeUpdate(prev: TLTextShape, next: TLTextShape) {
        if (!next.props.autoSize) return
        
        // Auto-resize based on text content
        const bounds = this.getMinDimensions(next)
        return {
            ...next,
            x: next.x - delta.x,
            y: next.y - delta.y,
            props: { ...next.props, w: bounds.width },
        }
    }
    
    override onEditEnd(shape: TLTextShape) {
        // Delete empty text shapes
        if (trimmedText.length === 0) {
            this.editor.deleteShapes([shape.id])
        }
    }
}
```

### 1.5 Example: ArrowShapeUtil

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tldraw/src/lib/shapes/arrow/ArrowShapeUtil.tsx`

Complex shape with bindings and handles:

```typescript
export class ArrowShapeUtil extends ShapeUtil<TLArrowShape> {
    static override type = 'arrow' as const
    static override props = arrowShapeProps
    static override migrations = arrowShapeMigrations
    
    override canEdit() {
        return true
    }
    
    override canBind({ toShapeType }: TLShapeUtilCanBindOpts<TLArrowShape>): boolean {
        // Arrows can bind to shapes, but not to other arrows
        return toShapeType !== 'arrow'
    }
    
    override hideResizeHandles() {
        return true
    }
    
    override getHandles?(shape: TLArrowShape): TLHandle[] {
        return [
            { id: 'start', type: 'vertex', ... },
            { id: 'end', type: 'vertex', ... },
        ]
    }
}
```

### 1.6 Props and Migrations

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tlschema/src/shapes/TLGeoShape.ts`

Props definition with validation:

```typescript
import { T } from '@tldraw/tlschema'

export const geoShapeProps = {
    w: T.number,
    h: T.number,
    geo: T.enum('rectangle', 'ellipse', 'triangle', ...),
    dash: T.enum('draw', 'solid', 'dashed', 'dotted'),
    color: DefaultColorStyle,
    fill: T.enum('none', 'solid', 'pattern', ...),
    size: T.enum('s', 'm', 'l', 'xl'),
    align: T.enum('start', 'middle', 'end'),
    richText: T.json,
    // ... more props
}

export const geoShapeMigrations = [
    {
        id: 'geo-shape-v1-v2',
        migrate(prev) {
            // Migration logic
        },
    },
]
```

---

## 2. Tool Restriction

### 2.1 Overview

The Tldraw component accepts `tools`, `shapeUtils`, and `bindingUtils` props to configure which tools and shapes are available.

### 2.2 Tldraw Component Configuration

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tldraw/src/lib/Tldraw.tsx`

The Tldraw component merges custom tools with default tools:

```typescript
export function Tldraw(props: TldrawProps) {
    const {
        shapeUtils = [],
        bindingUtils = [],
        tools = [],
        // ...
    } = props
    
    // Merge custom shape utils with defaults
    const shapeUtilsWithDefaults = useMemo(
        () => mergeArraysAndReplaceDefaults('type', _shapeUtils, defaultShapeUtils),
        [_shapeUtils]
    )
    
    // Merge custom binding utils with defaults
    const bindingUtilsWithDefaults = useMemo(
        () => mergeArraysAndReplaceDefaults('type', _bindingUtils, defaultBindingUtils),
        [_bindingUtils]
    )
    
    // Merge custom tools with all default tools
    const toolsWithDefaults = useMemo(
        () => mergeArraysAndReplaceDefaults('id', _tools, allDefaultTools),
        [_tools]
    )
    
    return (
        <TldrawEditor
            shapeUtils={shapeUtilsWithDefaults}
            bindingUtils={bindingUtilsWithDefaults}
            tools={toolsWithDefaults}
            // ...
        />
    )
}
```

### 2.3 Restricting Tools Example

To restrict which tools appear in the toolbar:

```tsx
import { Tldraw } from 'tldraw'
import { GeoShapeUtil } from './GeoShapeUtil'
import { TextShapeUtil } from './TextShapeUtil'
import { FrameShapeUtil } from './FrameShapeUtil'
import { ArrowShapeUtil } from './ArrowShapeUtil'
import { SelectTool, HandTool, ZoomTool } from 'tldraw'

// Custom shape utilities
const customShapeUtils = [
    GeoShapeUtil,
    TextShapeUtil,
    FrameShapeUtil,
    ArrowShapeUtil,
]

// Custom tools (or use default shape tools)
const customTools = [
    SelectTool,
    HandTool,
    ZoomTool,
    // Omit tools you don't want: EraserTool, LaserTool
]

function MyApp() {
    return (
        <Tldraw
            shapeUtils={customShapeUtils}
            tools={customTools}
        />
    )
}
```

### 2.4 Default Tools

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tldraw/src/lib/defaultTools.ts`

```typescript
export const defaultTools = [
    EraserTool,
    HandTool,
    LaserTool,
    SelectTool,
    ZoomTool,
] as const
```

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tldraw/src/lib/defaultShapeTools.ts`

```typescript
export const defaultShapeTools = [
    TextShapeTool,
    DrawShapeTool,
    GeoShapeTool,
    NoteShapeTool,
    LineShapeTool,
    FrameShapeTool,
    ArrowShapeTool,
    HighlightShapeTool,
] as const
```

---

## 3. Frame Shape and Parenting

### 3.1 Frame Shape Overview

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tldraw/src/lib/shapes/frame/FrameShapeUtil.tsx`

Frames are special container shapes that can have children shapes nested inside them.

### 3.2 Frame Configuration

```typescript
export interface FrameShapeOptions {
    showColors: boolean
    resizeChildren: boolean
}

export class FrameShapeUtil extends BaseBoxShapeUtil<TLFrameShape> {
    static override type = 'frame' as const
    static override props = frameShapeProps
    static override migrations = frameShapeMigrations
    
    override options: FrameShapeOptions = {
        showColors: false,
        resizeChildren: false,
    }
    
    // Configure frame with options
    static override configure<T extends TLShapeUtilConstructor<any, any>>(
        this: T,
        options: Partial<FrameShapeOptions>
    ): T {
        const withOptions = super.configure.call(this, options) as T
        if ((options as any).showColors) {
            ;(withOptions as any).props = { ...withOptions.props, color: DefaultColorStyle }
        }
        return withOptions
    }
}
```

### 3.3 Container Methods

Frames implement container-specific methods:

```typescript
// Return true if this shape provides a background for its children
override providesBackgroundForChildren(): boolean {
    return true
}

// Return clip path for children
override getClipPath(shape: TLFrameShape) {
    return this.editor.getShapeGeometry(shape.id).vertices
}

// Allow/disallow children of specific types
override canReceiveNewChildrenOfType(shape: TLShape) {
    return !shape.isLocked
}

// Resize children when frame is resized
override canResizeChildren() {
    return this.options.resizeChildren
}
```

### 3.4 Drag and Drop (Reparenting)

The FrameShapeUtil implements callbacks for handling shapes dragged in/out:

```typescript
// Called when shapes are dragged INTO the frame
override onDragShapesIn(
    shape: TLFrameShape,
    draggingShapes: TLShape[],
    { initialParentIds, initialIndices }: TLDragShapesOverInfo
) {
    const { editor } = this
    
    // Check if shapes can have their original indices restored
    let canRestoreOriginalIndices = false
    const previousChildren = draggingShapes.filter(
        (s) => shape.id === initialParentIds.get(s.id)
    )
    
    if (previousChildren.length > 0) {
        const currentChildren = compact(
            editor.getSortedChildIdsForParent(shape).map((id) => editor.getShape(id))
        )
        if (previousChildren.every((s) => !currentChildren.find((c) => c.index === s.index))) {
            canRestoreOriginalIndices = true
        }
    }
    
    // Prevent circular references
    if (draggingShapes.some((s) => editor.hasAncestor(shape, s.id))) return
    
    // Reparent the shapes to the new parent (the frame)
    editor.reparentShapes(draggingShapes, shape.id)
    
    // Restore original indices if possible
    if (canRestoreOriginalIndices) {
        for (const shape of previousChildren) {
            editor.updateShape({
                id: shape.id,
                type: shape.type,
                index: initialIndices.get(shape.id),
            })
        }
    }
}

// Called when shapes are dragged OUT of the frame
override onDragShapesOut(
    shape: TLFrameShape,
    draggingShapes: TLShape[],
    info: TLDragShapesOutInfo
): void {
    const { editor } = this
    
    // When dragging shapes out of a frame, and not dragging into a new shape,
    // reparent the dragging shapes onto the current page
    if (!info.nextDraggingOverShapeId) {
        editor.reparentShapes(
            draggingShapes.filter(
                (s) => s.parentId === shape.id && this.canReceiveNewChildrenOfType(s)
            ),
            editor.getCurrentPageId()
        )
    }
}
```

### 3.5 Double-Click Frame Operations

```typescript
// Double-click corner to fit frame to content
override onDoubleClickCorner(shape: TLFrameShape) {
    fitFrameToContent(this.editor, shape.id, { padding: 10 })
    return {
        id: shape.id,
        type: shape.type,
    }
}

// Double-click edge to resize frame to children bounds
override onDoubleClickEdge(shape: TLFrameShape, info: TLClickEventInfo) {
    if (info.target !== 'selection') return
    const { handle } = info
    
    const childIds = this.editor.getSortedChildIdsForParent(shape.id)
    const children = compact(childIds.map((id) => this.editor.getShape(id)))
    if (!children.length) return
    
    const { dx, dy, w, h } = getFrameChildrenBounds(children, this.editor, { padding: 10 })
    
    this.editor.run(() => {
        const changes: TLShapePartial[] = childIds.map((childId) => {
            const childShape = this.editor.getShape(childId)!
            return {
                id: childShape.id,
                type: childShape.type,
                x: isHorizontalEdge ? childShape.x + dx : childShape.x,
                y: isVerticalEdge ? childShape.y + dy : childShape.y,
            }
        })
        this.editor.updateShapes(changes)
    })
    
    return {
        id: shape.id,
        type: shape.type,
        props: {
            w: isHorizontalEdge ? w : shape.props.w,
            h: isVerticalEdge ? h : shape.props.h,
        },
    }
}
```

---

## 4. Store/Snapshot API

### 4.1 Overview

The tldraw store is a reactive store that manages all document data (shapes, assets, pages, etc.).

### 4.2 Creating a Store

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/editor/src/lib/config/createTLStore.ts`

```typescript
export interface TLStoreOptions {
    initialData?: SerializedStore<TLRecord>
    snapshot?: Partial<TLEditorSnapshot> | TLStoreSnapshot
    defaultName?: string
    assets?: TLAssetStore
    onMount?(editor: Editor): void | (() => void)
    collaboration?: {
        status: Signal<'online' | 'offline'> | null
        mode?: Signal<'readonly' | 'readwrite'> | null
    }
    schema?: StoreSchema<TLRecord, TLStoreProps>
    shapeUtils?: readonly TLAnyShapeUtilConstructor[]
    bindingUtils?: readonly TLAnyBindingUtilConstructor[]
    migrations?: readonly MigrationSequence[]
}

export function createTLStore(opts: TLStoreOptions = {}): TLStore {
    const schema = createTLSchemaFromUtils(opts)
    
    const store = new Store({
        id: opts.id,
        schema,
        initialData: opts.initialData,
        props: {
            defaultName: opts.defaultName ?? '',
            assets: {
                upload: opts.assets?.upload ?? inlineBase64AssetStore.upload,
                resolve: opts.assets?.resolve ?? defaultAssetResolve,
                remove: opts.assets?.remove ?? (() => Promise.resolve()),
            },
            onMount: (editor) => opts.onMount?.(editor as Editor),
            collaboration: opts.collaboration,
        },
    })
    
    if (opts.snapshot) {
        loadSnapshot(store, opts.snapshot, { forceOverwriteSessionState: true })
    }
    
    return store
}
```

### 4.3 Getting a Snapshot

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/editor/src/lib/config/TLEditorSnapshot.ts`

```typescript
export function getSnapshot(store: TLStore): TLEditorSnapshot {
    const sessionState$ = sessionStateCache.get(store, createSessionStateSnapshotSignal)
    const session = sessionState$.get()
    
    return {
        document: store.getStoreSnapshot(),
        session,
    }
}
```

Usage:

```typescript
import { getSnapshot } from '@tldraw/editor'

function saveDocument(editor: Editor) {
    const snapshot = getSnapshot(editor.store)
    localStorage.setItem('drawing', JSON.stringify(snapshot))
}
```

### 4.4 Loading a Snapshot

```typescript
import { loadSnapshot, TLEditorSnapshot } from '@tldraw/editor'

function loadDocument(editor: Editor, savedData: string) {
    const snapshot: TLEditorSnapshot = JSON.parse(savedData)
    loadSnapshot(editor.store, snapshot)
}
```

### 4.5 Store Listener

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/store/src/lib/Store.ts`

Listen for changes to the store:

```typescript
export interface StoreListenerFilters {
    scope?: 'document' | 'session' | 'all'
    source?: 'user' | 'remote' | 'all'
    names?: string[]
}

store.listen(
    (entry) => {
        const { changes, source } = entry
        console.log('Changes:', changes)
        console.log('Source:', source) // 'user' or 'remote'
    },
    {
        scope: 'document', // Only listen to document-scoped changes
        source: 'user',    // Only listen to user changes
    }
)
```

### 4.6 Editor Store Listener

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/editor/src/lib/editor/Editor.ts`

```typescript
// Inside Editor constructor
this.store.listen((changes) => {
    // Handle store changes
    const { changes: diff, source } = changes
    
    // Check for added shapes
    for (const [id, record] of Object.entries(diff.added)) {
        if (this.schema.getType(record.typeName).scope === 'document') {
            console.log('Shape added:', id)
        }
    }
    
    // Check for updated shapes
    for (const [id, { from, to }] of Object.entries(diff.updated)) {
        console.log('Shape updated:', id)
    }
    
    // Check for removed shapes
    for (const [id, record] of Object.entries(diff.removed)) {
        console.log('Shape removed:', id)
    }
})
```

### 4.7 Side Effects API

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/store/src/lib/StoreSideEffects.ts`

Register handlers for specific events:

```typescript
// Register a handler to run after a shape is created
store.sideEffects.registerAfterCreateHandler('shape', (record) => {
    console.log('Shape created:', record.id)
})

// Register a handler to run after a shape is updated
store.sideEffects.registerAfterUpdateHandler('shape', ({ oldRecord, newRecord }) => {
    console.log('Shape updated:', oldRecord.id)
    console.log('Old props:', oldRecord.props)
    console.log('New props:', newRecord.props)
})

// Register a handler to run after a shape is deleted
store.sideEffects.registerAfterDeleteHandler('shape', (record) => {
    console.log('Shape deleted:', record.id)
})
```

---

## 5. Shape Events/Listeners

### 5.1 Overview

There are multiple ways to detect shape lifecycle events:

1. **ShapeUtil Callbacks**: `onBeforeCreate`, `onBeforeUpdate`, etc.
2. **Store Listeners**: Listen to store changes
3. **Editor Events**: `created-shapes`, `updated-shapes`, `deleted-shapes` events
4. **Side Effects**: Store-level event handlers

### 5.2 ShapeUtil Lifecycle Callbacks

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/editor/src/lib/editor/shapes/ShapeUtil.ts`

```typescript
abstract class ShapeUtil<Shape extends TLShape = TLShape> {
    // Called just before a shape is created
    onBeforeCreate?(next: Shape): Shape | void
    
    // Called just before a shape is updated
    onBeforeUpdate?(prev: Shape, next: Shape): Shape | void
    
    // Called when some shapes are dragged INTO this shape
    onDragShapesIn?(shape: Shape, shapes: TLShape[], info: TLDragShapesInInfo): void
    
    // Called when some shapes are dragged OVER this shape
    onDragShapesOver?(shape: Shape, shapes: TLShape[], info: TLDragShapesOverInfo): void
    
    // Called when some shapes are dragged OUT of this shape
    onDragShapesOut?(shape: Shape, shapes: TLShape[], info: TLDragShapesOutInfo): void
    
    // Called when shapes are dropped over this shape
    onDropShapesOver?(shape: Shape, shapes: TLShape[], info: TLDropShapesOverInfo): void
    
    // Resize callbacks
    onResizeStart?(shape: Shape): TLShapePartial<Shape> | void
    onResize?(shape: Shape, info: TLResizeInfo<Shape>): TLShapePartial<Shape> | void
    onResizeEnd?(initial: Shape, current: Shape): TLShapePartial<Shape> | void
    onResizeCancel?(initial: Shape, current: Shape): void
    
    // Translate callbacks
    onTranslateStart?(shape: Shape): TLShapePartial<Shape> | void
    onTranslate?(initial: Shape, current: Shape): TLShapePartial<Shape> | void
    onTranslateEnd?(initial: Shape, current: Shape): TLShapePartial<Shape> | void
    onTranslateCancel?(initial: Shape, current: Shape): void
    
    // Handle callbacks
    onHandleDragStart?(shape: Shape, info: TLHandleDragInfo<Shape>): TLShapePartial<Shape> | void
    onHandleDrag?(shape: Shape, info: TLHandleDragInfo<Shape>): TLShapePartial<Shape> | void
    onHandleDragEnd?(current: Shape, info: TLHandleDragInfo<Shape>): TLShapePartial<Shape> | void
    onHandleDragCancel?(current: Shape, info: TLHandleDragInfo<Shape>): void
    
    // Click/double-click callbacks
    onClick?(shape: Shape): TLShapePartial<Shape> | void
    onDoubleClick?(shape: Shape): TLShapePartial<Shape> | void
    onDoubleClickEdge?(shape: Shape, info: TLClickEventInfo): TLShapePartial<Shape> | void
    onDoubleClickCorner?(shape: Shape, info: TLClickEventInfo): TLShapePartial<Shape> | void
    
    // Edit callbacks
    onEditStart?(shape: Shape): void
    onEditEnd?(shape: Shape): void
    
    // Child change callback
    onChildrenChange?(shape: Shape): TLShapePartial[] | void
}
```

### 5.3 Editor Events

```typescript
import { useEditor } from '@tldraw/editor'

function ShapeWatcher() {
    const editor = useEditor()
    
    useEffect(() => {
        // Listen for shape creation
        const cleanup1 = editor.store.listen((entry) => {
            const { changes } = entry
            
            // Check for created shapes
            for (const [id, shape] of Object.entries(changes.added)) {
                if (shape.typeName === 'shape') {
                    console.log('Shape created:', id)
                }
            }
            
            // Check for deleted shapes
            for (const [id, shape] of Object.entries(changes.removed)) {
                if (shape.typeName === 'shape') {
                    console.log('Shape deleted:', id)
                }
            }
            
            // Check for updated shapes
            for (const [id, { from, to }] of Object.entries(changes.updated)) {
                if (from.typeName === 'shape') {
                    // Check for parent change (reparenting)
                    if (from.parentId !== to.parentId) {
                        console.log('Shape reparented:', id)
                        console.log('Old parent:', from.parentId)
                        console.log('New parent:', to.parentId)
                    }
                }
            }
        }, { scope: 'document' })
        
        return () => {
            cleanup1()
        }
    }, [editor])
    
    return null
}
```

### 5.4 Detecting Reparenting

To detect when a shape is moved in/out of a frame:

```typescript
function watchReparenting(editor: Editor) {
    editor.store.listen((entry) => {
        const { changes } = entry
        
        for (const [id, { from, to }] of Object.entries(changes.updated)) {
            if (
                from.typeName === 'shape' &&
                to.typeName === 'shape' &&
                from.parentId !== to.parentId
            ) {
                // Shape was reparented
                const oldParent = editor.store.get(from.parentId)
                const newParent = editor.store.get(to.parentId)
                
                console.log(`Shape ${id} moved from ${oldParent?.typeName} to ${newParent?.typeName}`)
                
                // Check if moved into/out of a frame
                if (newParent?.typeName === 'shape' && newParent.type === 'frame') {
                    console.log('Shape moved into frame:', newParent.id)
                }
                if (oldParent?.typeName === 'shape' && oldParent.type === 'frame') {
                    console.log('Shape moved out of frame:', oldParent.id)
                }
            }
        }
    })
}
```

---

## 6. Programmatic Shape Manipulation

### 6.1 Creating Shapes

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/editor/src/lib/editor/Editor.ts`

```typescript
// Create a single shape
editor.createShape<TShape extends TLShape>(shape: TLCreateShapePartial<TShape>): this

// Create multiple shapes
editor.createShapes<TShape extends TLShape>(shapes: TLCreateShapePartial<TShape>[]): this

// Example: Create a rectangle
editor.createShapes([{
    type: 'geo',
    x: 100,
    y: 200,
    props: {
        w: 150,
        h: 100,
        geo: 'rectangle',
        color: 'red',
        fill: 'solid',
    },
}])

// Example: Create a text shape
editor.createShapes([{
    type: 'text',
    x: 100,
    y: 200,
    props: {
        richText: toRichText('Hello, World!'),
        color: 'black',
        size: 'm',
    },
}])

// Example: Create a frame with children
editor.createShapes([
    {
        id: createShapeId('frame1'),
        type: 'frame',
        x: 100,
        y: 100,
        props: { w: 400, h: 300, name: 'My Frame' },
    },
    {
        type: 'geo',
        x: 150,
        y: 150,
        parentId: createShapeId('frame1'), // Child of frame
        props: { w: 100, h: 100, geo: 'rectangle' },
    },
])
```

### 6.2 Updating Shapes

```typescript
// Update a single shape
editor.updateShape<T extends TLShape>(partial: TLShapePartial<T>): this

// Update multiple shapes
editor.updateShapes<T extends TLShape>(partials: (TLShapePartial<T> | null | undefined)[]): this

// Example: Move a shape
editor.updateShapes([{
    id: 'shape:123',
    type: 'geo',
    x: 300,
    y: 400,
}])

// Example: Resize a shape
editor.updateShapes([{
    id: 'shape:123',
    type: 'geo',
    props: {
        w: 200,
        h: 150,
    },
}])

// Example: Update shape properties
editor.updateShapes([{
    id: 'shape:123',
    type: 'geo',
    props: {
        color: 'blue',
        fill: 'solid',
        dash: 'draw',
    },
}])

// Example: Batch update multiple shapes
editor.updateShapes([
    { id: 'shape:1', type: 'geo', x: 100, y: 100 },
    { id: 'shape:2', type: 'geo', x: 200, y: 200 },
    { id: 'shape:3', type: 'geo', x: 300, y: 300 },
])
```

### 6.3 Deleting Shapes

```typescript
// Delete a single shape
editor.deleteShape(id: TLShapeId): this

// Delete multiple shapes
editor.deleteShapes(ids: TLShapeId[]): this

// Example: Delete one shape
editor.deleteShape('shape:123')

// Example: Delete multiple shapes
editor.deleteShapes(['shape:1', 'shape:2', 'shape:3'])

// Example: Delete selected shapes
const selectedIds = editor.getSelectedShapeIds()
editor.deleteShapes(selectedIds)

// Example: Delete all shapes on page
const pageShapes = editor.getCurrentPageShapeIds()
editor.deleteShapes([...pageShapes])
```

### 6.4 Reparenting Shapes

```typescript
// Reparent shapes to a new parent
editor.reparentShapes(
    shapes: TLShapeId[] | TLShape[],
    parentId: TLParentId,
    insertIndex?: IndexKey
): this

// Example: Move shape into frame
editor.reparentShapes(['shape:123'], 'frame:456')

// Example: Move shape out of frame to page
const pageId = editor.getCurrentPageId()
editor.reparentShapes(['shape:123'], pageId)

// Example: Move multiple shapes into frame
editor.reparentShapes(
    ['shape:1', 'shape:2', 'shape:3'],
    'frame:456'
)

// Example: Move shapes to specific position in z-order
editor.reparentShapes(
    ['shape:1'],
    'frame:456',
    'a5' // insert before existing shape with index 'a5'
)
```

### 6.5 Shape Type Definitions

**File**: `/Users/panjx/code/GITHUB/tldraw-tldraw/packages/tlschema/src/records/TLShape.ts`

```typescript
// Partial shape for updates - all properties except id and type are optional
export type TLShapePartial<T extends TLShape = TLShape> = T extends T
    ? {
        id: TLShapeId
        type: T['type']
        props?: Partial<T['props']>
        meta?: Partial<T['meta']>
    } & Partial<Omit<T, 'type' | 'id' | 'props' | 'meta'>>
    : never

// Partial shape for creation - type is required but id is optional
export type TLCreateShapePartial<T extends TLShape = TLShape> = T extends T
    ? {
        type: T['type']
        props?: Partial<T['props']>
        meta?: Partial<T['meta']>
    } & Partial<Omit<T, 'type' | 'props' | 'meta'>>
    : never
```

### 6.6 Complete Example: Adding Shapes Programmatically

```tsx
import {
    Tldraw,
    useEditor,
    createShapeId,
    toRichText,
} from 'tldraw'
import 'tldraw/tldraw.css'

function ShapeCreator() {
    const editor = useEditor()
    
    const addRectangle = () => {
        editor.createShapes([{
            type: 'geo',
            x: Math.random() * 500,
            y: Math.random() * 500,
            props: {
                w: 100,
                h: 100,
                geo: 'rectangle',
                color: 'red',
                fill: 'solid',
            },
        }])
    }
    
    const addText = () => {
        editor.createShapes([{
            type: 'text',
            x: Math.random() * 500,
            y: Math.random() * 500,
            props: {
                richText: toRichText('Hello!'),
                color: 'black',
                size: 'm',
            },
        }])
    }
    
    const addFrame = () => {
        const frameId = createShapeId('my-frame')
        editor.createShapes([{
            id: frameId,
            type: 'frame',
            x: 100,
            y: 100,
            props: {
                w: 400,
                h: 300,
                name: 'Container',
            },
        }])
    }
    
    const deleteAll = () => {
        const shapeIds = [...editor.getCurrentPageShapeIds()]
        editor.deleteShapes(shapeIds)
    }
    
    return (
        <div>
            <button onClick={addRectangle}>Add Rectangle</button>
            <button onClick={addText}>Add Text</button>
            <button onClick={addFrame}>Add Frame</button>
            <button onClick={deleteAll}>Delete All</button>
        </div>
    )
}

function App() {
    return (
        <Tldraw>
            <ShapeCreator />
        </Tldraw>
    )
}
```

---

## Summary

This research document covers the key aspects of working with tldraw:

1. **Custom Shapes**: Extend `ShapeUtil` or `BaseBoxShapeUtil`, define props with validation, implement lifecycle callbacks
2. **Tool Restriction**: Pass `shapeUtils`, `bindingUtils`, and `tools` props to the Tldraw component
3. **Frame Parenting**: Frames implement `onDragShapesIn`, `onDragShapesOut` to handle child management
4. **Store API**: Use `getSnapshot()` and `loadSnapshot()` for persistence, `store.listen()` for change detection
5. **Shape Events**: Use ShapeUtil callbacks, store listeners, or side effects handlers
6. **Shape Manipulation**: `createShapes()`, `updateShapes()`, `deleteShapes()`, `reparentShapes()`

For more details, refer to the source files referenced throughout this document.
