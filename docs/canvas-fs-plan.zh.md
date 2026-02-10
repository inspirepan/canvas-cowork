# Canvas FS 实现计划

> 基于: `canvas-cowork-proposal.md`, `architecture.md`, `tldraw-research.md`, `pi-sdk-api.md`

> 创建日期: 2026-02-09

---

## 当前状态

Phase 1（TLDraw 集成）和 Phase 2（CanvasFS 核心）已完成。

- **后端**: Bun HTTP/WS 服务器 + `AgentManager` 包装 `@mariozechner/pi-coding-agent` SDK
- **协议**: 完整的 WebSocket 双向协议（流式 delta、会话生命周期、canvas FS 事件）
- **前端**: `CanvasEditor`（全屏 tldraw）+ 浮动 `AgentPanel` 侧边栏（380px，可切换）
- **CanvasFS**: 启动时自动创建 `canvas/`，递归文件监视器，300ms 防抖，读取/写入 `.canvas.json`，文件‑形状映射规则
- **新增协议类型**: `canvas_fs_change`（服务器→客户端），`canvas_sync`（客户端→服务器），`CanvasFSEvent`，`CanvasSyncChange`

已不存在的内容：
- 没有自定义形状（NamedText）或工具限制
- 没有双向同步（canvas <-> 文件系统）
- 没有代理自定义工具或系统提示自定义

---

## 阶段概览
```
Phase 1: TLDraw 集成 + 布局                              [DONE]
Phase 2: CanvasFS 核心（目录、文件监视器、.canvas.json）     [DONE]
Phase 3: 自定义形状 + 工具限制（NamedText、框架规则） [DONE]
Phase 4: 双向同步（canvas <-> 文件系统）
Phase 5: 代理工具 + 系统提示（canvas_snapshot, screenshot）
Phase 6: 前端打磨（自动布局、框架大小调节、平滑过渡）
Phase 7: Canvas 引用 + 选中作为代理上下文
```

---

## 阶段 1：TLDraw 集成 + 布局

**目标**：嵌入 tldraw 为主要画布，将 AgentPanel 设为浮动侧边栏。

### 1.1 安装 tldraw
```
bun add tldraw
```

### 1.2 创建 `CanvasEditor` 组件
- 新文件: `src/web/src/components/CanvasEditor.tsx`
- 渲染全视口 `<Tldraw>`
- 引入 `tldraw/tldraw.css`
- 接收 `onMount` 回调，返回 `Editor` 实例
- 将 Editor 引用存储，以供同步层后使用

### 1.3 重构 `App.tsx` 布局
- 从居中 AgentPanel 改为:
```
+--------------------------------------------------+
|                                                  |
|              TLDraw 画布（全屏）        [Panel] |
|                                          380px   |
|                                                  |
+--------------------------------------------------+
```
- 画布占满视口
- AgentPanel 右侧浮动（absolute/fixed，宽 380px，高度全屏）
- 面板切换按钮显示/隐藏

### 1.4 验证
- 画布渲染，平移/缩放正常
- AgentPanel 覆盖在画布上，聊天功能正常
- 面板可切换

---

## 阶段 2：CanvasFS 核心

**目标**：建立 `canvas/` 目录和映射数据模型。暂不实现同步，仅提供后端基础。

### 2.1 自动创建 `canvas/` 目录
在 `src/server/index.ts` 启动时:
```typescript
import { mkdirSync, existsSync } from "fs";
const canvasDir = join(cwd, "canvas");
if (!existsSync(canvasDir)) mkdirSync(canvasDir, { recursive: true });
```

### 2.2 创建 `src/server/canvas-fs.ts`
- `CanvasFS` 类负责管理画布形状与文件系统的映射

**元素‑文件映射规则**（来源于提案）：
| Canvas 元素 | 文件系统 | 说明 |
|---|---|---|
| NamedText 形状 | `{name}.txt` | 文本内容 = 文件内容 |
| Image 形状 | `{name}.png/jpg` | 二进制文件 |
| Frame 形状 | `{name}/` 目录 | 互斥，不允许嵌套 |
| Arrow 形状 | 连接元数据 | 两端必须附着到元素才能有语义 |
| Draw（画笔） | 无直接文件 | 仅在覆盖图像时才有语义 |

**CanvasFS 负责**：
- 读取 `canvas/` 目录并生成形状‑映射清单
- 在画布变化时写入/删除/重命名/移动 `canvas/` 中的文件
- 解析 `.canvas.json` 以获取非语义数据（位置、大小、样式、箭头绑定）
- 生成语义快照（目录树 + 箭头连接）

### 2.3 `.canvas.json` 格式
存放于 `canvas/.canvas.json`，持久化所有非文件内容的画布状态：
```jsonc
{
  "version": 1,
  // 完整的 tldraw 快照（形状、位置、样式等）
  "tldraw": { /* getSnapshot(editor.store) 输出 */ },
  // tldraw 形状 ID 与文件路径的映射
  "shapeToFile": {
    "shape:abc123": "notes.txt",
    "shape:def456": "refs/style.png",
    "shape:frame1": "refs/"
  }
}
```

### 2.4 文件监视器
- 使用 `fs.watch`（或 Bun 的监视器）递归监视 `canvas/`
- 检测文件创建/修改/删除/重命名
- 对频繁更改进行 300ms 防抖（代理编辑经常产生多次写入）
- 向同步层（第 4 阶段）发出事件
- 忽略 `.canvas.json` 的更改（自触发）

---

## 阶段 3：自定义形状 + 工具限制

**目标**：限制画布仅使用项目相关工具，创建 NamedText 自定义形状。

### 3.1 限制工具/形状
仅在 tldraw 工具栏中保留以下工具：
| 工具 | 用途 |
|---|---|
| Select | 默认选择/移动 |
| Hand | 平移画布 |
| Frame | 创建文件夹 |
| NamedText | 创建命名文本文件 |
| Image（上传） | 添加图片 |
| Draw（画笔） | 自由手绘注释 |
| Arrow | 连接元素 |
| Eraser | 删除元素 |

移除：Geo、Note、Line、Highlight、Laser、Zoom（保留手势缩放）

实现方式：向 `<Tldraw>` 传递自定义 `tools` 与 `shapeUtils`，通过 tldraw 的 `components` 或 `overrides` 覆盖默认工具栏 UI。

### 3.2 NamedText 自定义形状
- 新文件：`src/web/src/canvas/NamedTextShapeUtil.tsx`
- 与 tldraw 内置文本形状不同，拥有 **name**（类似 Figma 的图层名称）

**属性**：
```typescript
{
  name: string   // 显示在文本上方的标签，映射到文件名（如 "brief"）
  text: string   // 文件内容
  w: number      // 宽度
}
```

**渲染**：
```
brief.txt              <-- 名称标签（小、灰色、位于形状上方）
+---------------------+
| This is the design  |  <-- 可编辑文本内容区域
| brief for the       |
| project...          |
+---------------------+
```
- 名称标签渲染在形状边界上方，类似框架名称的显示方式
- 双击文本区域可编辑
- 自动高度：高度根据文本内容自适应
- 双击名称标签或通过属性面板编辑名称

**文件扩展名**：始终为 `.txt`。`name` 属性不包含扩展名。文件路径 = `{parent_frame_name}/{name}.txt`（若在根目录则为 `{name}.txt`）

### 3.3 框架形状适配
- 使用 tldraw 内置 `FrameShapeUtil` 并覆盖 `canReceiveNewChildrenOfType` 实现 **不允许嵌套框架**（一个框架不能被拖入另一个框架）
- 互斥：形状一次只能属于一个框架（tldraw 默认的重新父级处理）
- 名称 = 文件夹名称：框架的 `name` 属性映射到 `canvas/` 中的目录名称

### 3.4 图片形状
- 使用 tldraw 内置图片形状。注意事项：
- 图片名称来源于资产文件名或用户自定义名称
- 框架内的图片映射为 `{frame_name}/{image_name}.png`
- 支持桌面拖拽上传

---

## 阶段 4：双向同步

**目标**：画布更改同步到文件系统；文件系统更改（来自代理）同步到画布。

### 4.1 同步方向标记
每个更改都有 **source**：
- `"canvas"`：用户操作画布
- `"fs"`：代理（或外部进程）修改文件
- `"init"`：启动时从 `.canvas.json` 加载

同步层 **忽略来自相反来源的更改**，防止循环。

### 4.2 Canvas -> Filesystem（用户编辑）
监听 tldraw `store.listen()`（`{ source: 'user', scope: 'document' }`）：
- **形状创建**：
  - NamedText → 写入 `{name}.txt`（文本内容）
  - Frame → 创建 `{name}/` 目录
  - Image → 复制图像数据至 `{name}.png`
- **形状更新**：
  - NamedText 文本变化 → 重写文件内容
  - NamedText/Frame 名称变化 → 重命名文件/目录
  - 形状重新父级（移入/移出框架） → 移动文件
- **形状删除**：
  - NamedText → 删除 `.txt` 文件
  - Frame → 删除目录（若非空则阻止或删除）
  - Image → 删除图像文件
- **非语义更改**（位置、大小、样式）→ 只更新 `.canvas.json`（防抖），不触发文件操作

### 4.3 Filesystem -> Canvas（代理编辑）
文件监视器检测 `canvas/` 的更改：
- **文件创建**：
  - `.txt` → 创建 NamedText 形状
  - `.png/.jpg` → 创建 Image 形状
  - 新目录 → 创建 Frame 形状
- **文件修改**：
  - `.txt` → 更新对应 NamedText 形状的文本属性
- **文件删除**：
  - 移除对应画布形状
- **文件移动**（检测为删除+创建或重命名事件）→
  - `reparentShapes()` 将形状在框架之间移动

### 4.4 新形状的位置信息计算
- 如果文件在子目录（框架）中 → 放置在该框架内部并自动布局
- 根目录文件 → 放置在画布的空白区域
- 使用简单网格/流布局，避免与现有形状重叠

### 4.5 WebSocket 协议扩展
在 `protocol.ts` 中新增消息类型：
```typescript
// Server -> Client: 文件系统更改，更新画布
| { type: "canvas_fs_change"; changes: CanvasFSChange[] }

// Client -> Server: 画布更改，更新文件系统
| { type: "canvas_sync"; changes: CanvasSyncChange[] }

interface CanvasFSChange {
  action: "create" | "update" | "delete" | "move"
  path: string           // 相对 canvas/ 的路径
  content?: string       // 文本文件内容
  oldPath?: string       // 移动时的旧路径
}

interface CanvasSyncChange {
  action: "create" | "update" | "delete" | "move" | "rename"
  shapeType: "named_text" | "frame" | "image"
  path: string
  content?: string
  oldPath?: string
}
```

### 4.6 `.canvas.json` 持久化
- 对任何画布存变化进行 500ms 防抖写入
- 包含完整 tldraw 快照 + 形状‑文件映射
- 启动时若 `.canvas.json` 存在，加载快照恢复画布状态
- 若 `.canvas.json` 不存在但 `canvas/` 有文件，基于文件系统引导初始化画布

---

## 阶段 5：代理工具 + 系统提示

**目标**：通过自定义工具和系统提示让代理感知 Canvas FS。

### 5.1 `canvas_snapshot` 工具
在 `agent-manager.ts` 中通过 `createAgentSession({ customTools: [canvasSnapshotTool] })` 注册。

**工具定义**（TypeBox schema）：
```typescript
const canvasSnapshotTool: ToolDefinition = {
  name: "canvas_snapshot",
  label: "Canvas Snapshot",
  description: "获取当前画布状态的语义快照，以目录树 + 连接（箭头）关系的形式呈现。",
  parameters: Type.Object({
    include_coords: Type.Optional(Type.Boolean({
      description: "在输出中包含形状坐标。默认: false。"
    })),
    include_content: Type.Optional(Type.Boolean({
      description: "在输出中包含文本文件内容。默认: false。"
    })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 读取 canvas/ 目录结构
    // 解析 .canvas.json 获取箭头绑定
    // 构建树形输出
    // 返回格式化快照
  }
}
```

**输出格式**（示例）：
```
/
+-- refs/
|   +-- style.png (annotated)
|   +-- notes.txt
+-- reference.png
+-- brief.txt

Arrows:
  reference.png (0.25, 0.10) -> refs/style.png
```

“(annotated)” 标记（原提案使用 emoji）指示带有箭头/画笔注释的图片。代理可以单独请求标注视图。

### 5.2 `canvas_screenshot` 工具（低优先级）
捕获整幅画布的 PNG 图像。使用 tldraw 的导出 API (`editor.toImage()`)。

```typescript
const canvasScreenshotTool: ToolDefinition = {
  name: "canvas_screenshot",
  label: "Canvas Screenshot",
  description: "捕获整个画布的可视截图，包含所有非语义元素。",
  parameters: Type.Object({}),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 前端通过 WebSocket 请求截图
    // 前端调用 editor.toImage()
    // 返回 ImageContent
  }
}
```

### 5.3 图片双视图（标注图像）
若图像上有任何箭头或画笔注释，代理获取两张图像：原始和标注（带有箭头/画笔的截图）。

**实现要点**：
- 在 `canvas_snapshot` 中检测图像是否有箭头或画笔覆盖 → 标记为 `(annotated)`
- 提供 `get_annotated_image` 工具或在 `canvas_snapshot` 参数中实现：
  1. 确认与图像层绑定或重叠的箭头/画笔
  2. 使用 tldraw 的导出 API 渲染该图像区域并包含覆盖
  3. 返回原始图像文件和标注截图

### 5.4 系统提示
在 `canvas/` 工作目录下使用 `.pi/APPEND_SYSTEM.md`，或在运行时通过 SDK 注入。

在 `agent-manager.ts` 中创建会话后，将 Canvas FS 上下文追加到系统提示：
```typescript
const canvasSystemPrompt = `
## Canvas FS

You are working in a Canvas FS environment. The `canvas/` directory is a bidirectional mirror of a spatial canvas that the user sees and interacts with.

### File-to-Canvas Mapping
- `.txt` files = text elements on the canvas (named text blocks the user can see)
- `.png/.jpg` files = image elements on the canvas
- Subdirectories = frames (visual groups/containers) on the canvas
- Frames are flat (one level only, no nested frames)

### How It Works
- When you create/edit/delete files in `canvas/`, the changes appear on the user's canvas in real-time
- When the user creates/edits/deletes elements on the canvas, the files update accordingly
- Moving a file between directories = moving an element between frames on the canvas

### Tools
- Use `canvas_snapshot` to see the current canvas structure (directory tree + arrow connections)
- Images marked as "(annotated)" have user annotations (arrows/drawings on them)
- Standard file tools (read, write, edit, bash) work on canvas/ files and are reflected on canvas

### Best Practices
- Use `canvas_snapshot` at the start of a task to understand the current canvas state
- Create subdirectories (frames) to organize related content
- Use descriptive filenames -- they become visible labels on the canvas
- When creating text files, the content appears directly on the canvas for the user to read
`

```typescript
// After session creation
session.agent.setSystemPrompt(session.systemPrompt + canvasSystemPrompt)
```
或者使用 `APPEND_SYSTEM.md` 文件方式。

---

## 阶段 6：前端打磨
**目标**：为代理驱动的画布更改提供平滑的用户体验。

### 6.1 代理文件操作 → 画布动画
- **创建**：新形状淡入
- **删除**：形状淡出
- **移动（重新父级）**：形状从旧位置平滑动画到新框架
- **重命名**：名称标签就地更新

### 6.2 框架自动大小调节
- 当框架的子元素增删时，重新计算框架边界并适配所有子元素（使用 `fitFrameToContent(editor, frameId, { padding: 16 })`）
- 防抖以避免批量操作时的抖动

### 6.3 框架内部自动布局
- 对文本元素垂直堆叠并保持一致间距
- 对图片进行网格布局
- 新元素放置在已有元素下方或下一个可用网格单元
- 尊重最小间距

### 6.4 根级形状的智能放置
- 找到画布空白区域（避免与现有形状重叠）
- 如可能，放置在当前视口中心附近
- 将相关创建的文件聚合在一起

### 6.5 箭头语义检测
- 检测与图像绑定或几何重叠的箭头/画笔 → 语义，包含在快照输出中
- 只在两个形状之间的箭头 → 语义，包含在 Arrows 部分
- 浮动的箭头/画笔 → 非语义，不出现在快照中

---

## 阶段 7：Canvas 引用 + 选中作为代理上下文

**目标**：用户在画布上选中形状时，选中的内容会出现在 AgentPanel 输入框的附件芯片中；在输入框中键入 `@` 时弹出画布内容自动补全菜单。

### 7.1 选中作为实时附件
- 选中 NamedText、Image、Frame 时，在 AgentPanel 输入框上方显示附件芯片（如 `brief.txt`、`style.png`、`refs/`）
- 多选时显示多个芯片
- 点击空白区域取消选中，所有芯片消失
- 对框架，芯片显示框架名称，发送时递归包含所有子内容
- 对 Arrow 或 Draw 形状不显示附件
- 芯片有关闭按钮 X，点击后芯片消失但画布仍保持选中状态
- 芯片在选中变化时实时更新（防抖 100‑200ms）

### 7.2 `@` 触发自动补全
- 在 AgentPanel 输入框键入 `@` 时弹出自动补全菜单，列出所有可引用的画布内容（NamedText、Image、Frame）
- 支持模糊搜索过滤，例如 `@br` 只显示 `brief.txt`
- 支持键盘导航（上下箭头、Enter、Escape）
- 选中后插入样式化的引用 token `[@brief.txt]`（不可编辑的内联标记）
- `@` 引用是持久的，除非用户手动删除；即使画布选中变化也不会消失
- 发送消息前进行去重：若同一形状既通过选中又通过 `@` 引用，仅保留一个 `<doc>` 块

### 7.3 消息构造
- 使用 `buildMessageWithAttachments()` 将附件包装为 `<doc>` 格式并拼接到用户消息前
- 对于图片，使用 `ImageContent` 块而不是在文本中嵌入 base64
- 对框架，递归生成 `<doc path="refs/" type="frame">...</doc>` 结构

---

## 依赖变更

```bash
# Phase 1
bun add tldraw

# Phase 5（自定义工具的 TypeBox schema）
bun add @sinclair/typebox
```

---

## 文件结构（新/修改）
```
src/
  server/
    index.ts               # Modified: auto-create canvas/, pass canvasFS to manager
    agent-manager.ts       # Modified: add customTools, system prompt
    canvas-fs.ts           # NEW: CanvasFS 类（目录管理、快照、文件监视）
  shared/
    protocol.ts            # Modified: add canvas_fs_change, canvas_sync messages
  web/
    src/
      App.tsx                  # Modified: canvas + floating panel layout
      components/
        CanvasEditor.tsx       # NEW: tldraw 包装组件
        AgentPanel.tsx         # Modified: positioning for floating sidebar
      canvas/
        NamedTextShapeUtil.tsx  # NEW: custom shape for named text files
        NamedTextTool.ts       # NEW: tool for creating NamedText shapes
        canvas-tools.ts        # NEW: tool/shape restriction config
        canvas-sync.ts         # NEW: bidirectional sync logic (canvas <-> WS <-> FS)
        layout.ts              # NEW: auto-layout calculations
      hooks/
        useCanvasSelection.ts  # NEW: track selection -> resolve to CanvasAttachment[]
      canvas/
        canvas-attachments.ts  # NEW: buildMessageWithAttachments(), formatAttachment()
        canvas-mention.ts      # NEW: @ mention autocomplete logic (fuzzy search, menu state)
```

---

## 任务清单
- 读取 `docs/canvas-fs-plan.md`
- 将其翻译为中文并保存为 `docs/canvas-fs-plan.zh.md`

---

已完成中文翻译。
