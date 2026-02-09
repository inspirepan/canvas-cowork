# Canvas FS 实现计划

> 基础文档: `canvas-cowork-proposal.md`, `architecture.md`, `tldraw-research.md`, `pi-sdk-api.md`
>
> 创建时间: 2026-02-09

---

## 当前状态

第一阶段（Agent 面板）已完成：

- **后端**: Bun HTTP/WS 服务器 + `AgentManager` 包装 `@mariozechner/pi-coding-agent` SDK
- **协议**: 完整的 WebSocket 双向协议（流增量、会话生命周期）
- **前端**: `AgentPanel` 组件（SessionList + SessionChat）配合 `useAgent` 钩子
- **App.tsx**: 在居中容器中渲染独立的 380px AgentPanel。无画布。

还不存在的内容：

- 没有 tldraw 依赖或画布渲染
- 没有 `canvas/` 目录概念
- 没有自定义工具或系统提示词自定义
- 没有文件到画布的映射或双向同步

---

## 阶段总览

```
阶段 1: TLDraw 集成 + 布局
阶段 2: CanvasFS 核心（目录、文件监视器、.canvas.json）
阶段 3: 自定义形状 + 工具限制（NamedText、Frame 规则）
阶段 4: 双向同步（画布 ↔ 文件系统）
阶段 5: Agent 工具 + 系统提示词（canvas_snapshot、screenshot）
阶段 6: 前端优化（自动布局、frame 调整、平滑过渡）
```

---

## 阶段 1: TLDraw 集成 + 布局

**目标**: 将 tldraw 嵌入为主画布，将 AgentPanel 重新定位为浮动侧边栏。

### 1.1 安装 tldraw

```bash
bun add tldraw
```

### 1.2 创建 `CanvasEditor` 组件

新文件: `src/web/src/components/CanvasEditor.tsx`

- 使用完整视口渲染 `<Tldraw>`
- 导入 `tldraw/tldraw.css`
- 接受 `onMount` 回调，接收 `Editor` 实例
- 存储 Editor ref 供后续同步层使用

### 1.3 重构 `App.tsx` 布局

从居中 AgentPanel 改为：

```
+--------------------------------------------------+
|                                                  |
|              TLDraw 画布（全屏）         [面板] |
|                                          380px   |
|                                                  |
+--------------------------------------------------+
```

- 画布占满整个视口
- AgentPanel 浮动在右侧（绝对/固定定位，380px 宽度，全高）
- 面板切换按钮显示/隐藏

### 1.4 验证

- 画布渲染，平移/缩放工作正常
- AgentPanel 覆盖在画布上，聊天工作正常
- 面板可以切换

---

## 阶段 2: CanvasFS 核心

**目标**: 建立 `canvas/` 目录和映射数据模型。暂无同步 —— 仅是后端基础。

### 2.1 自动创建 `canvas/` 目录

在 `src/server/index.ts` 启动时：

```typescript
import { mkdirSync, existsSync } from "fs";
const canvasDir = join(cwd, "canvas");
if (!existsSync(canvasDir)) mkdirSync(canvasDir, { recursive: true });
```

### 2.2 创建 `src/server/canvas-fs.ts`

`CanvasFS` 类管理画布形状与文件系统之间的映射：

**元素到文件的映射规则**（来自提案）：

| 画布元素 | 文件系统 | 说明 |
|---|---|---|
| NamedText 形状 | `{name}.txt` | 文本内容 = 文件内容 |
| Image 形状 | `{name}.png/jpg` | 二进制文件 |
| Frame 形状 | `{name}/` 目录 | 互斥，无嵌套 |
| Arrow | 连接元数据 | 两端必须附着到元素以获得语义 |
| Draw（笔刷） | 无直接文件 | 仅在覆盖图像时具有语义 |

**CanvasFS 职责**：

- 读取 `canvas/` 目录并生成形状映射清单
- 根据画布变化在 `canvas/` 中写入/删除/重命名/移动文件
- 解析 `.canvas.json` 以获取非语义数据（位置、大小、样式、箭头绑定）
- 生成语义快照（目录树 + 箭头连接）

### 2.3 `.canvas.json` 格式

存储在 `canvas/.canvas.json`。保持所有非文件内容的画布状态：

```jsonc
{
  "version": 1,
  // 完整的 tldraw 快照，包含形状、位置、样式等
  // 这是序列化的 tldraw 存储状态
  "tldraw": { /* getSnapshot(editor.store) 输出 */ },
  // tldraw 形状 ID 到文件系统路径的映射
  "shapeToFile": {
    "shape:abc123": "notes.txt",
    "shape:def456": "refs/style.png",
    "shape:frame1": "refs/"
  }
}
```

### 2.4 文件监视器

在 `canvas/` 上递归使用 `fs.watch`（或 Bun 的监视器）：

- 检测文件创建/修改/删除/重命名
- 对快速变化进行防抖（agent 编辑通常产生多次写入）
- 向同步层发出事件（阶段 4）
- 忽略 `.canvas.json` 变化（自触发）

---

## 阶段 3: 自定义形状 + 工具限制

**目标**: 将画布限制为仅项目相关的工具。创建 NamedText 自定义形状。

### 3.1 限制工具/形状

在 tldraw 工具栏中仅允许以下工具：

| 工具 | 目的 |
|---|---|
| Select | 默认选择/移动 |
| Hand | 平移画布 |
| Frame | 创建文件夹 |
| NamedText | 创建命名文本文件 |
| Image（上传） | 添加图像 |
| Draw（笔刷） | 自由手绘注释 |
| Arrow | 连接元素 |
| Eraser | 移除元素 |

移除: Geo、Note、Line、Highlight、Laser、Zoom 工具（保持手势缩放）。

实现: 传递自定义 `tools` 和 `shapeUtils` 给 `<Tldraw>` 组件。通过 tldraw 的 `components` 属性或 `overrides` 覆盖默认工具栏 UI。

### 3.2 NamedText 自定义形状

新文件: `src/web/src/canvas/NamedTextShapeUtil.tsx`

这是核心自定义形状。与 tldraw 的内置文本形状不同，它有一个**名称**（如 Figma 的图层名称）。

**属性**:

```typescript
{
  name: string     // 显示在文本上方，映射到文件名（如 "brief"）
  text: string     // 文件内容
  w: number        // 宽度
}
```

**渲染**:

```
  brief.txt              <-- 名称标签（小的、柔和的、在形状上方）
+---------------------+
| This is the design  |  <-- 文本内容区域（可编辑）
| brief for the       |
| project...          |
+---------------------+
```

- 名称标签在形状边界上方渲染（类似于 frame 名称的显示方式）
- 文本区域在双击时可编辑
- 自动高度: 高度根据文本内容调整
- 名称可通过单独交互编辑（双击标签，或属性面板）

**文件扩展名**: 始终是 `.txt`。名称属性不包含扩展名。文件路径 = `{parent_frame_name}/{name}.txt` 或根目录时 `{name}.txt`。

### 3.3 Frame 形状适配

使用 tldraw 的内置 `FrameShapeUtil` 并添加约束：

- **无嵌套**: 覆盖 `canReceiveNewChildrenOfType` 以拒绝其他 frame。Frame 不能被拖入另一个 frame。
- **互斥性**: 一个形状只能同时属于一个 frame（tldraw 的默认重新父级处理）。
- **名称 = 文件夹名**: Frame 的 `name` 属性映射到 `canvas/` 中的目录名。

### 3.4 Image 形状

使用 tldraw 的内置图像形状。注意事项：

- 图像名称从资源文件名或用户指定的名称派生
- Frame 内的图像映射到 `{frame_name}/{image_name}.png`
- 支持从桌面拖放上传

---

## 阶段 4: 双向同步

**目标**: 画布变化传播到文件系统；文件系统变化（来自 agent）传播到画布。

这是最复杂的阶段。关键挑战是避免无限循环（画布变化 -> 文件写入 -> 文件监视 -> 画布更新 -> ...）。

### 4.1 同步方向标记

每个变化都有一个**源**：

- `"canvas"`: 用户操纵了画布
- `"fs"`: Agent（或外部进程）修改了文件
- `"init"`: 从 `.canvas.json` 加载启动时

同步层**忽略来自相反源的变化**以打破循环。

### 4.2 画布 -> 文件系统（用户编辑）

使用 `{ source: 'user', scope: 'document' }` 监听 tldraw `store.listen()`：

**形状创建**:
- NamedText -> 写入 `{name}.txt`，包含文本内容
- Frame -> 创建 `{name}/` 目录
- Image -> 复制图像数据到 `{name}.png`

**形状更新**:
- NamedText 文本改变 -> 重写文件内容
- NamedText/Frame 名称改变 -> 重命名文件/目录
- 形状重新父级化（移入/移出 frame） -> 在目录间移动文件

**形状删除**:
- NamedText -> 删除 `.txt` 文件
- Frame -> 删除目录（及内容？或禁止非空时删除？）
- Image -> 删除图像文件

**非语义变化**（位置、大小、样式）:
- 仅更新 `.canvas.json`（防抖）
- 不触发文件操作

### 4.3 文件系统 -> 画布（agent 编辑）

文件监视器检测 `canvas/` 中的变化：

**文件创建**:
- `.txt` 文件 -> 在画布上创建 NamedText 形状
- `.png/.jpg` 文件 -> 创建 Image 形状
- 新目录 -> 创建 Frame 形状

**文件修改**:
- `.txt` 文件 -> 更新 NamedText 形状的 text 属性

**文件删除**:
- 从画布移除相应形状

**文件移动**（检测为删除 + 创建相同内容，或通过重命名事件）:
- `reparentShapes()` 以在 frame 间移动形状

### 4.4 从 FS 创建新形状的位置计算

当 agent 创建文件且需要在画布上放置新形状时：

- 如果文件在子目录（frame）中，在该 frame 内放置自动布局
- 如果文件在根目录，放置在画布的开放区域
- 在 frame 内使用简单网格/流式布局
- 避免重叠现有形状

### 4.5 WebSocket 协议扩展

`protocol.ts` 中的新消息类型：

```typescript
// 服务器 -> 客户端: 文件系统已更改，更新画布
| { type: "canvas_fs_change"; changes: CanvasFSChange[] }

// 客户端 -> 服务器: 画布已更改，更新文件系统  
| { type: "canvas_sync"; changes: CanvasSyncChange[] }

interface CanvasFSChange {
  action: "create" | "update" | "delete" | "move"
  path: string           // 相对于 canvas/
  content?: string       // 文本文件
  oldPath?: string       // 移动时
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

- 任何画布存储变化时防抖写入（500ms）
- 完整的 tldraw 快照 + 形状到文件的映射
- 启动时: 如果 `.canvas.json` 存在，加载快照以恢复画布状态
- 如果 `.canvas.json` 不存在但 `canvas/` 有文件，从文件系统引导画布

---

## 阶段 5: Agent 工具 + 系统提示词

**目标**: 通过自定义工具和系统提示词让 agent 了解 Canvas FS。

### 5.1 `canvas_snapshot` 工具

通过 `createAgentSession({ customTools: [canvasSnapshotTool] })` 注册。

**工具定义**（TypeBox 模式）:

```typescript
const canvasSnapshotTool: ToolDefinition = {
  name: "canvas_snapshot",
  label: "Canvas Snapshot",
  description: "获取当前画布状态的语义快照，包含目录树和连接（箭头）关系。",
  parameters: Type.Object({
    include_coords: Type.Optional(Type.Boolean({
      description: "在输出中包含形状坐标。默认: false。"
    })),
    include_content: Type.Optional(Type.Boolean({
      description: "内联包含文本文件内容。默认: false。"
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

**输出格式**（来自提案）:

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

`(annotated)` 标记（提案中使用 emoji）表示具有箭头/笔刷覆盖的图像。Agent 可以单独请求带注释的视图。

### 5.2 `canvas_screenshot` 工具（较低优先级）

将整个画布捕获为 PNG 图像。使用 tldraw 的导出 API（`editor.toImage()`）。

```typescript
const canvasScreenshotTool: ToolDefinition = {
  name: "canvas_screenshot",
  label: "Canvas Screenshot",
  description: "捕获整个画布的视觉截图，包含所有非语义元素。",
  parameters: Type.Object({}),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 通过 WebSocket 向前端请求截图
    // 前端调用 editor.toImage()，发送结果回来
    // 返回为 ImageContent
  }
}
```

这需要往返: 后端请求前端截图，前端调用 `editor.toImage()`，将结果发送回来。

### 5.3 图像双视图（带注释的图像）

来自提案："当图像具有任何箭头或笔刷注释时，Agent 获得两个图像: **原始**和**带注释的**（类似截图，包含箭头和笔刷笔划）。"

**实现**:

- 在 `canvas_snapshot` 中，检测具有覆盖它们的箭头或绘制形状的图像
- 在快照输出中用 `(annotated)` 标记这些
- 提供 `get_annotated_image` 工具（或 `canvas_snapshot` 中的参数）:
  1. 识别在图像层上的箭头/绘制形状（绑定或覆盖图像）
  2. 使用 tldraw 导出 API 渲染包含覆盖层的图像区域
  3. 返回原始图像文件和带注释的截图

**语义边界规则**:

- 箭头/绘制笔刷**在图像上**（绑定或覆盖） -> **语义**，包含在带注释视图中
- 箭头**在元素间**（连接两个形状） -> **语义**，包含在快照 Arrows 部分
- 浮动箭头/绘制笔刷（未附着到任何东西） -> **非语义**，不在 FS 视图中

### 5.4 系统提示词

在 canvas/ 工作目录中使用 `.pi/APPEND_SYSTEM.md`，或在运行时通过 SDK 注入。

在 `agent-manager.ts` 中，创建会话后，将 Canvas FS 上下文附加到系统提示词：

```typescript
const canvasSystemPrompt = `
## Canvas FS

你在 Canvas FS 环境中工作。\`canvas/\` 目录是用户看到和交互的空间画布的双向镜像。

### 文件到画布映射
- \`.txt\` 文件 = 画布上的文本元素（用户可以看到的命名文本块）
- \`.png/.jpg\` 文件 = 画布上的图像元素
- 子目录 = frame（画布上的可视组/容器）
- Frame 是平面的（仅一个级别，无嵌套 frame）

### 工作原理
- 当你在 \`canvas/\` 中创建/编辑/删除文件时，用户的画布会实时显示变化
- 当用户在画布上创建/编辑/删除元素时，文件会相应更新
- 在目录间移动文件 = 在画布上在 frame 间移动元素

### 工具
- 使用 \`canvas_snapshot\` 查看当前画布结构（目录树 + 箭头连接）
- 标记为 "(annotated)" 的图像具有用户注释（它们上的箭头/绘图）
- 标准文件工具（read、write、edit、bash）适用于 canvas/ 文件并反映在画布上

### 最佳实践
- 在任务开始时使用 \`canvas_snapshot\` 理解当前画布状态
- 创建子目录（frame）组织相关内容
- 使用描述性文件名 -- 它们在画布上变成可见标签
- 创建文本文件时，内容直接在画布上显示供用户阅读
`;
```

方法: 在会话创建后通过 `session.agent.setSystemPrompt(session.systemPrompt + canvasSystemPrompt)` 附加到系统提示词。或者如果我们希望基于文件，使用 `APPEND_SYSTEM.md`。

---

## 阶段 6: 前端优化

**目标**: 为 agent 驱动的画布变化提供平滑的用户体验。

### 6.1 Agent 文件操作 -> 画布动画

当 agent 创建/移动/删除文件且画布更新时：

- **创建**: 新形状在计算的位置淡入
- **删除**: 形状淡出
- **移动（重新父级化）**: 形状从旧位置动画到新 frame
- **重命名**: 名称标签原地更新

实现: 使用 tldraw 的 `editor.animateShapes()` 实现平滑过渡。

### 6.2 Frame 自动调整大小

当元素添加到或从 frame 中移除时：

- 重新计算 frame 边界以适应所有子元素及填充
- 使用 tldraw 中的 `fitFrameToContent(editor, frameId, { padding: 16 })`
- 在 FrameShapeUtil 覆盖中的 `onChildrenChange` 回调上触发
- 防抖以避免批量操作时的调整大小闪烁

### 6.3 Frame 内自动布局

当 agent 在 frame 中创建多个文件时：

- 垂直堆叠文本元素，保持一致的间距
- 以网格布局排列图像
- 新元素放在现有元素下方（或下一个可用网格单元）
- 尊重元素间的最小间距

### 6.4 根级形状的智能放置

当 agent 在 `canvas/` 根目录创建文件时（不在任何 frame 中）：

- 查找画布上的开放区域（避免重叠现有形状）
- 尽可能靠近当前视口中心放置
- 将相关创建分组在一起

### 6.5 箭头语义检测

对于带注释的图像功能：

- 检测起点或终点绑定附着到图像形状的箭头
- 检测几何上覆盖图像形状边界的绘制形状
- 缓存此覆盖关系，并在形状移动时更新

---

## 技术风险和缓解措施

| 风险 | 影响 | 缓解 |
|---|---|---|
| 双向同步循环 | 画布 <-> FS 无限循环 | 源标记；忽略自触发的变化 |
| pi-coding-agent 系统提示词覆盖 | 可能丢失内置工具描述 | 改用 `APPEND_SYSTEM.md` 方法，而不是完全替换 |
| tldraw 快照大小 | `.canvas.json` 可能很大 | 仅存储文档范围，排除会话状态。防抖写入。 |
| 文件监视器可靠性 | 错过事件，平台差异 | 使用轮询作为后备；焦点时协调 |
| Agent 快速文件编辑 | 画布更新泛滥 | 防抖 FS 事件；批处理画布更新 |
| tldraw `toImage()` 用于截图 | 需要浏览器上下文 | 截图工具需要 WS 往返到前端 |
| Frame 嵌套防止 | tldraw 本身允许嵌套 frame | 在 FrameShapeUtil 上覆盖 `canReceiveNewChildrenOfType` |

---

## 依赖更改

```bash
# 阶段 1
bun add tldraw

# 阶段 5（用于自定义工具中的 TypeBox 模式）
bun add @sinclair/typebox
```

---

## 文件结构（新建/修改）

```
src/
  server/
    index.ts                   # 修改: 自动创建 canvas/，将 canvasFS 传递给 manager
    agent-manager.ts           # 修改: 添加 customTools、系统提示词
    canvas-fs.ts               # 新增: CanvasFS 类（目录管理、快照、文件监视器）
  shared/
    protocol.ts                # 修改: 添加 canvas_fs_change、canvas_sync 消息
  web/
    src/
      App.tsx                  # 修改: 画布 + 浮动面板布局
      components/
        CanvasEditor.tsx       # 新增: tldraw 包装组件
        AgentPanel.tsx         # 修改: 浮动侧边栏的定位
      canvas/
        NamedTextShapeUtil.tsx  # 新增: 命名文本文件的自定义形状
        NamedTextTool.ts       # 新增: 用于创建 NamedText 形状的工具
        canvas-tools.ts        # 新增: 工具/形状限制配置
        canvas-sync.ts         # 新增: 双向同步逻辑（画布 <-> WS <-> FS）
        layout.ts              # 新增: 自动布局计算
```

---

## 任务

> 每个阶段完成后必须满足：`bun run dev` 能正常启动（前端 5173 + 后端 3000），无编译错误，无运行时崩溃。每个阶段附带具体的验证步骤和测试要求。

---

### 阶段 1: TLDraw 集成 + 布局

**运行要求**: `bun run dev` 启动后，浏览器打开 `localhost:5173` 能看到全屏画布 + 右侧浮动 Agent 面板。

**验证手段**:
1. 打开浏览器 DevTools Console，确认无 JS 报错
2. 在画布上用鼠标拖拽平移、滚轮缩放，确认画布交互正常
3. 在画布上绘制默认形状（矩形等），确认 tldraw 基础功能正常
4. 点击面板切换按钮，确认 AgentPanel 可以展开/收起
5. 在 AgentPanel 中创建新会话，发送一条消息，确认 agent 回复正常流式渲染
6. 面板收起时，画布不应有被遮挡的区域

**任务**:
- [ ] 安装 tldraw 依赖 (`bun add tldraw`)
- [ ] 创建包装 `<Tldraw>` 的 `CanvasEditor.tsx` 组件
- [ ] 重构 `App.tsx` 为全屏画布 + 浮动 AgentPanel
- [ ] 将 AgentPanel 样式设置为浮动侧边栏（绝对定位，右侧）
- [ ] 添加面板切换按钮
- [ ] 验证: 画布平移/缩放正常，面板不拦截画布事件
- [ ] 验证: Agent 聊天功能不受影响（创建会话、发送消息、流式回复、工具调用展示）

---

### 阶段 2: CanvasFS 核心

**运行要求**: `bun run dev` 启动后，自动创建 `{cwd}/canvas/` 目录。手动在 `canvas/` 中创建/修改/删除文件时，服务器日志输出相应的文件变化事件。

**验证手段**:
1. 启动服务器，确认终端输出 `[canvas-fs] watching: {cwd}/canvas/`
2. `touch canvas/test.txt` -> 服务器日志输出 `[canvas-fs] created: test.txt`
3. `echo "hello" > canvas/test.txt` -> 日志输出 `[canvas-fs] modified: test.txt`
4. `mkdir canvas/refs` -> 日志输出 `[canvas-fs] created: refs/`
5. `rm canvas/test.txt` -> 日志输出 `[canvas-fs] deleted: test.txt`
6. 多次快速写入同一文件（`for i in {1..10}; do echo $i > canvas/test.txt; done`），确认防抖生效，不会输出 10 条日志
7. 修改 `canvas/.canvas.json` 不触发文件变化事件（忽略自身）
8. 在浏览器 DevTools 的 Network WS 面板中，能看到新增的 canvas 相关消息类型被正确定义（协议编译通过）

**任务**:
- [ ] 服务器启动时自动创建 `canvas/` 目录
- [ ] 创建 `canvas-fs.ts`，实现 `CanvasFS` 类骨架（构造函数、start/stop）
- [ ] 实现文件到形状的映射规则接口（txt -> named_text, png/jpg -> image, dir -> frame）
- [ ] 实现 `.canvas.json` 读/写方法（序列化/反序列化）
- [ ] 实现 `canvas/` 目录的递归文件监视器，带 300ms 防抖
- [ ] 文件监视器输出结构化日志（类型、路径、时间戳）
- [ ] 向 `protocol.ts` 添加 `canvas_fs_change` 和 `canvas_sync` 消息类型
- [ ] 确认 TypeScript 编译通过，无类型错误

---

### 阶段 3: 自定义形状 + 工具限制

**运行要求**: `bun run dev` 启动后，画布工具栏只显示 8 个工具（Select, Hand, Frame, NamedText, Image, Draw, Arrow, Eraser）。可以创建 NamedText 形状并编辑。

**验证手段**:
1. 工具栏检查：确认只有 8 个工具按钮，没有 Geo/Note/Line/Highlight/Laser
2. 创建 NamedText：选择 NamedText 工具，在画布上点击创建，确认出现带名称标签的文本块
3. 编辑文本：双击 NamedText 的文本区域，输入多行文本，确认高度自动增长
4. 编辑名称：双击名称标签（或通过面板），修改名称，确认标签更新
5. 名称标签样式：名称标签显示为小字、浅色，在形状上方，类似 Figma layer name
6. Frame 嵌套测试：创建两个 Frame，尝试将一个 Frame 拖入另一个 Frame，确认被拒绝（不发生嵌套）
7. Frame 子元素：创建一个 Frame 和一个 NamedText，将 NamedText 拖入 Frame，确认成为 Frame 的子元素
8. 互斥测试：将已在 Frame A 中的 NamedText 拖入 Frame B，确认它从 Frame A 中移出
9. 默认文本形状不可用：确认工具栏中没有原生 Text 工具（已被 NamedText 替代）

**任务**:
- [ ] 创建 `NamedTextShapeUtil`：渲染名称标签 + 文本内容，继承合适的基类
- [ ] 创建 `NamedTextTool`：工具栏图标和交互（点击画布创建形状）
- [ ] 实现 NamedText 双击编辑文本内容
- [ ] 实现 NamedText 名称编辑交互
- [ ] 实现 NamedText 根据文本内容自动高度
- [ ] 配置工具限制：传 `tools` 和 `shapeUtils` 给 `<Tldraw>`
- [ ] 自定义工具栏 UI：只显示允许的 8 个工具
- [ ] 扩展 `FrameShapeUtil`：覆盖 `canReceiveNewChildrenOfType` 禁止 frame 嵌套
- [ ] 验证: Frame 嵌套被阻止
- [ ] 验证: NamedText 可创建、编辑、在 frame 间拖拽

---

### 阶段 4: 双向同步

**运行要求**: `bun run dev` 启动后，画布操作实时同步到 `canvas/` 文件系统，反之亦然。刷新页面后画布状态从 `.canvas.json` 恢复。

**验证手段 -- 画布 -> 文件系统方向**:
1. 在画布创建一个 NamedText（名为 "hello"），确认 `canvas/hello.txt` 被创建
2. 编辑该 NamedText 的文本内容，确认 `canvas/hello.txt` 内容同步更新
3. 在画布创建一个 Frame（名为 "refs"），确认 `canvas/refs/` 目录被创建
4. 将 NamedText 拖入 Frame，确认 `canvas/hello.txt` 被移动到 `canvas/refs/hello.txt`
5. 重命名 NamedText，确认文件名相应变化
6. 删除 NamedText，确认对应文件被删除
7. 移动 shape 位置（不改内容），确认只有 `.canvas.json` 更新，不触发文件操作

**验证手段 -- 文件系统 -> 画布方向**:
8. 在终端 `echo "world" > canvas/new.txt`，确认画布上出现新的 NamedText 形状
9. 在终端 `echo "updated" > canvas/new.txt`，确认画布上 NamedText 内容更新
10. 在终端 `mkdir canvas/folder && mv canvas/new.txt canvas/folder/`，确认画布上 NamedText 移入对应 Frame
11. 在终端 `rm canvas/folder/new.txt`，确认画布上 NamedText 消失

**验证手段 -- 持久化与恢复**:
12. 在画布上创建多个形状，刷新页面（F5），确认所有形状位置和内容都恢复
13. 关闭服务器再重启 `bun run dev`，确认 `.canvas.json` 加载正确

**验证手段 -- 循环防护**:
14. 在画布创建 NamedText -> 文件被创建 -> 不会在画布上重复创建第二个形状
15. 终端写入文件 -> 画布出现形状 -> 不会重复写入文件

**任务**:
- [ ] 实现画布 -> FS 同步：NamedText 创建 -> 写入 .txt 文件
- [ ] 实现画布 -> FS 同步：NamedText 更新 -> 重写文件内容
- [ ] 实现画布 -> FS 同步：Frame 创建 -> 创建目录
- [ ] 实现画布 -> FS 同步：形状删除 -> 删除文件/目录
- [ ] 实现画布 -> FS 同步：形状 reparent（拖入/拖出 frame） -> 移动文件
- [ ] 实现画布 -> FS 同步：形状/frame 重命名 -> 重命名文件/目录
- [ ] 实现画布 -> FS 同步：非语义变化（位置/大小）-> 只更新 .canvas.json
- [ ] 实现 FS -> 画布同步：.txt 文件创建 -> 创建 NamedText 形状
- [ ] 实现 FS -> 画布同步：.txt 文件修改 -> 更新 NamedText 内容
- [ ] 实现 FS -> 画布同步：文件删除 -> 移除画布形状
- [ ] 实现 FS -> 画布同步：文件移动 -> reparentShapes
- [ ] 实现 FS -> 画布同步：目录创建 -> 创建 Frame 形状
- [ ] 实现 FS -> 画布同步：图片文件创建 -> 创建 Image 形状
- [ ] 实现同步源标记（source flag），防止 canvas->fs->canvas 循环
- [ ] 实现 `.canvas.json` 防抖持久化（500ms debounce）
- [ ] 实现启动时从 `.canvas.json` 加载恢复画布
- [ ] 实现引导模式：`canvas/` 有文件但无 `.canvas.json` 时，从 FS 构建初始画布
- [ ] 实现新形状的自动位置计算（frame 内 / root 级别）

---

### 阶段 5: Agent 工具 + 系统提示词

**运行要求**: `bun run dev` 启动后，在 AgentPanel 中对话时，agent 能使用 `canvas_snapshot` 工具查看画布状态。agent 对 `canvas/` 目录的文件操作实时反映到画布。

**验证手段 -- canvas_snapshot**:
1. 在画布上手动创建一些元素（文本、图片、frame、箭头），然后在 AgentPanel 告诉 agent "查看当前画布"
2. 确认 agent 调用了 `canvas_snapshot` 工具
3. 确认工具返回结果是正确的目录树格式，包含所有文件和 Arrows 连接关系
4. 在工具调用的展开面板中能看到格式化的快照输出

**验证手段 -- agent 操作画布**:
5. 告诉 agent "在画布上创建一个名为 brief 的文本，内容是项目简介"
6. 确认 agent 使用 `write` 工具写入 `canvas/brief.txt`
7. 确认画布上实时出现 NamedText 形状，内容为 agent 写入的文本
8. 告诉 agent "创建一个 refs 文件夹，把 brief 移进去"
9. 确认 agent 先 `mkdir canvas/refs` 再 `mv canvas/brief.txt canvas/refs/`
10. 确认画布上 Frame 出现，NamedText 移入 Frame

**验证手段 -- 系统提示词**:
11. 创建新会话后，查看 agent 的首条回复是否体现了对 Canvas FS 的理解（而非当作普通编码任务）
12. 在 agent 的工具列表中（`session.getAllTools()`）确认包含 `canvas_snapshot`

**验证手段 -- 带注释图像（如果图片功能已就绪）**:
13. 在画布上放一张图片，用箭头指向它，运行 `canvas_snapshot`，确认该图片标记为 `(annotated)`
14. 无箭头/画笔覆盖的图片不标记 `(annotated)`

**验证手段 -- canvas_screenshot（低优先级）**:
15. 告诉 agent "截取画布截图"，确认返回 PNG 图片（通过 WS 往返）

**任务**:
- [ ] 安装 `@sinclair/typebox` 依赖 (`bun add @sinclair/typebox`)
- [ ] 实现 `canvas_snapshot` 工具定义（TypeBox schema + execute）
- [ ] `canvas_snapshot` 输出：目录树格式 + Arrows 连接关系
- [ ] `canvas_snapshot` 输出：`(annotated)` 标记检测（箭头/画笔覆盖的图片）
- [ ] `canvas_snapshot` 可选参数：`include_coords` 和 `include_content`
- [ ] 实现 `canvas_screenshot` 工具（WS 往返：后端请求 -> 前端 `editor.toImage()` -> 返回 base64）
- [ ] 编写 Canvas FS 系统提示词内容
- [ ] 在 `agent-manager.ts` 中注入系统提示词（`APPEND_SYSTEM.md` 或运行时 append）
- [ ] 将 `customTools` 传给 `createAgentSession()`
- [ ] 测试: agent 调用 `canvas_snapshot`，输出结构正确
- [ ] 测试: agent `write canvas/test.txt` -> 画布出现 NamedText
- [ ] 测试: agent `mv` 文件 -> 画布 reparent
- [ ] 测试: 图片 annotated 检测正确

---

### 阶段 6: 前端优化

**运行要求**: `bun run dev` 启动后，agent 的文件操作在画布上有平滑的视觉反馈。Frame 自动调整大小适应内容。

**验证手段**:
1. Agent 创建文件 -> 画布上新形状平滑淡入（不是突然出现）
2. Agent 删除文件 -> 形状淡出消失
3. Agent 移动文件到另一个目录 -> 形状从旧位置平滑移动到新 frame
4. 向 Frame 中添加多个元素 -> Frame 自动扩大以容纳所有子元素
5. 从 Frame 中移除元素 -> Frame 自动缩小
6. Agent 批量创建多个文件（如一次写 3 个 .txt）-> frame 内元素自动排列整齐，不重叠
7. 根级别创建文件 -> 新形状放置在画布空闲区域，不与已有形状重叠
8. 性能：agent 连续快速写入 10 个文件，画布更新流畅无卡顿

**验证手段 -- 箭头语义**:
9. 在图片上画箭头，运行 snapshot -> 输出中该图片标记为 annotated
10. 在两个 NamedText 之间连箭头，snapshot -> Arrows 部分正确列出连接
11. 画一个不附着任何元素的游离箭头，snapshot -> 该箭头不出现在输出中

**端到端场景测试**:
12. 场景：用户在画布上放了参考图，画了箭头指向它，创建了 "brief" 文本。然后告诉 agent "根据参考图和 brief 写一个详细的设计说明"。验证 agent 先调用 snapshot 理解画布，然后创建新文件，文件出现在画布上，内容合理。

**任务**:
- [ ] 实现 frame 在子元素变化时自动调整大小（`fitFrameToContent`，debounce）
- [ ] 实现 frame 内子元素自动排列（垂直堆栈，间距 12-16px）
- [ ] 实现根级形状的智能放置算法（避免重叠，靠近视口中心）
- [ ] 为 agent 创建的元素添加淡入动画
- [ ] 为 agent 删除的元素添加淡出动画
- [ ] 添加平滑的 reparent 动画（shape 从一个 frame 移动到另一个 frame）
- [ ] 实现箭头语义边界检测（区分：图像上的箭头/画笔、元素间的箭头、游离箭头/画笔）
- [ ] 端到端验证: 完整流程测试（用户创建画布内容 -> 对话 agent -> agent 修改画布 -> 用户看到实时变化）
