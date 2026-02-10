# Canvas FS 操作映射

画布上的每个语义元素都有对应的文件系统表示。本文档梳理所有画布操作与文件系统之间的双向映射关系。

## 元素类型

| 画布元素 | 文件系统表示 | 是否语义 |
|---|---|---|
| NamedText | `{name}.txt` | 是 |
| Image | `{name}.png/jpg/...` | 是 |
| Frame | `{name}/` 目录 | 是 |
| Draw (画笔) | 无直接文件 | 条件语义 |
| Arrow (箭头) | 无直接文件 | 条件语义 |

> "条件语义"指这些元素本身不产生文件，但当它们附着到语义元素上时，会影响 snapshot 的输出。

---

## 一、创建操作

### 画布 -> 文件系统

| 画布操作 | 文件系统效果 | 实现方式 |
|---|---|---|
| 创建 NamedText | 写入 `canvas/{name}.txt` | `handleShapeCreated` 发送 `create` + `named_text` |
| 上传/粘贴图片 | 写入 `canvas/{name}.png` | 通过 `/canvas/upload` HTTP 上传，文件已在服务端；前端注册映射 |
| 创建 Frame | 创建 `canvas/{name}/` 目录 | `handleShapeCreated` 发送 `create` + `frame` |
| 画笔轨迹 | 无文件操作 | 仅保存在 `.canvas.json` 的 tldraw 快照中 |
| 画箭头 | 无文件操作 | 仅保存在 `.canvas.json` 的 tldraw 快照中 |

### 文件系统 -> 画布

| 文件系统操作 | 画布效果 | 实现方式 |
|---|---|---|
| 创建 `.txt` 文件 | 创建 NamedText 形状（淡入动画） | `handleFSCreatedSync` |
| 创建图片文件 | 创建 Image 形状（异步加载尺寸 + 淡入动画） | `createImageFromFS` |
| 创建目录 | 创建 Frame 形状（淡入动画） | `handleFSCreatedSync` |

新形状的位置计算：
- 在 Frame 内：垂直堆叠在已有子元素下方 (`findPositionInFrame`)
- 在根级别：优先靠近视口中心的空闲区域 (`findOpenPosition`)

---

## 二、删除操作

### 画布 -> 文件系统

| 画布操作 | 文件系统效果 |
|---|---|
| 删除 NamedText | 删除 `canvas/{path}.txt` |
| 删除 Image | 删除 `canvas/{path}.png`；如果有 annotated 导出，一并删除 `{name}_annotated.png` |
| 删除 Frame | 删除 `canvas/{name}/` 目录（服务端递归删除） |
| 删除画笔轨迹 | 无文件操作；但会触发 annotation 检查，可能删除相关 `_annotated.png` |
| 删除箭头 | 无文件操作 |

### 文件系统 -> 画布

| 文件系统操作 | 画布效果 |
|---|---|
| 删除 `.txt` 文件 | 对应 NamedText 淡出动画后删除 |
| 删除图片文件 | 对应 Image 淡出动画后删除 |
| 删除目录 | 对应 Frame 及其所有子形状淡出删除 |

---

## 三、修改操作

### 画布 -> 文件系统

| 画布操作 | 文件系统效果 |
|---|---|
| 编辑 NamedText 文本内容 | 重写 `canvas/{path}.txt` 内容 |
| 移动形状位置（拖拽） | 无文件操作；仅更新 `.canvas.json` |
| 调整形状大小 | 无文件操作；仅更新 `.canvas.json` |
| 修改形状样式 | 无文件操作；仅更新 `.canvas.json` |

### 文件系统 -> 画布

| 文件系统操作 | 画布效果 |
|---|---|
| 修改 `.txt` 文件内容 | 更新对应 NamedText 的文本内容 |
| 修改图片文件 | 刷新 Image 资源（cache-bust；尺寸异步更新） |

---

## 四、重命名操作

### 画布 -> 文件系统

| 画布操作 | 文件系统效果 |
|---|---|
| 重命名 NamedText（改名称标签） | 重命名文件，如 `old.txt` -> `new.txt` |
| 重命名 Frame（改名称标签） | 重命名目录 `old/` -> `new/`；**递归更新**所有子元素的路径映射 |

### 文件系统 -> 画布

文件系统层面的重命名表现为"删除旧 + 创建新"，由 `detectMoves` 检测：
- 同名文件在不同路径出现时，识别为移动
- 同扩展名且 size+mtime 或内容相同的创建/删除，会识别为移动/改名

---

## 五、移动操作（reparent）

### 画布 -> 文件系统

| 画布操作 | 文件系统效果 |
|---|---|
| 将 NamedText 拖入 Frame | 移动文件：`canvas/note.txt` -> `canvas/folder/note.txt` |
| 将 NamedText 拖出 Frame | 移动文件：`canvas/folder/note.txt` -> `canvas/note.txt` |
| 将 NamedText 从 Frame A 拖到 Frame B | 移动文件：`canvas/a/note.txt` -> `canvas/b/note.txt` |
| 将 Image 拖入 Frame | 移动文件：`canvas/img.png` -> `canvas/folder/img.png`；如有 annotated 导出一并移动 |
| 将 Image 拖出 Frame | 移动文件：`canvas/folder/img.png` -> `canvas/img.png`；同上 |
| 将 Frame 拖入另一个 Frame | **被阻止** -- Frame 不允许嵌套 (`NoNestFrameShapeUtil`) |

### 文件系统 -> 画布

| 文件系统操作 | 画布效果 |
|---|---|
| `mv canvas/note.txt canvas/folder/` | NamedText 重新设置父级到对应 Frame，移动动画 |
| `mv canvas/folder/note.txt canvas/` | NamedText 移出 Frame 到画布根级，移动动画 |

移动检测逻辑 (`detectMoves`)：在同一批 FS 事件中，如果检测到"删除 A + 创建 B"且
- 文件名相同但路径不同，或
- 同扩展名且 size+mtime 或内容相同
则识别为移动操作。

---

## 六、画笔 (Draw) 与图片的关系

画笔轨迹本身不产生文件，但与图片的空间关系会产生语义：

| 画布操作 | 效果 |
|---|---|
| 在图片上画笔（AABB 重叠） | 触发 annotation 导出：将图片+画笔合成为 `{name}_annotated.png` 写入文件系统 |
| 移除图片上的画笔 | 删除 `{name}_annotated.png` |
| 修改图片上的画笔 | 重新导出 `{name}_annotated.png`（800ms 防抖） |
| 将画笔拖动到图片上方 | 触发 annotation 检查，如果 AABB 重叠则导出 |
| 将画笔从图片上方移走 | 触发 annotation 检查，不再重叠则删除 `_annotated.png` |
| 移动/缩放图片使其与已有画笔重叠 | 触发 annotation 检查并导出 |

检测条件：
- 画笔和图片必须在同一个父级（同一 Frame 或都在根级别）
- 使用 AABB 重叠检测（`findOverlappingDrawShapes`）
- 导出时使用 tldraw 的 `getSvgElement` + `getSvgAsImage` 合成带注解的图片
- **注意**：annotation 检查在 draw 形状增删改 **或** image 位置/尺寸/父级变更时触发

---

## 七、箭头 (Arrow) 的语义

箭头本身不产生文件，但影响两个地方：

### 7.1 `canvas_snapshot` 工具输出

| 箭头状态 | snapshot 表现 |
|---|---|
| 两端都连接到语义元素（text/image/frame） | 出现在 `Arrows:` 部分，如 `brief.txt -> refs/style.png` |
| 只有一端连接到语义元素 | **不出现**在 Arrows 中 |
| 两端都未连接（浮动箭头） | **不出现**在 Arrows 中 |
| 箭头连接到图片 | 该图片在快照中标记为 `(annotated)` |

箭头连接关系的解析方式：从 tldraw 快照中查找 `binding:` 记录，提取 `fromId` (arrow) -> `toId` (target) 的 `start`/`end` 绑定。

### 7.2 箭头连接变化的操作

| 画布操作 | 效果 |
|---|---|
| 将箭头两端连接到语义元素 | 下次 snapshot 输出 Arrows 连接 |
| 将箭头一端断开（拖走端点） | 下次 snapshot 不再输出该连接 |
| 将箭头从 Shape A 重连到 Shape B | 下次 snapshot 更新连接关系 |
| 将箭头连接到图片 | 下次 snapshot 该图片标记 `(annotated)` |
| 将箭头从图片上断开 | 下次 snapshot 该图片不再标记 `(annotated)`（如无其他 draw/arrow 覆盖） |

> 箭头连接变化不产生文件操作，也不触发客户端的 annotation 导出（`_annotated.png`）。它只影响 `canvas_snapshot` 的输出。

### 7.3 两套 annotated 机制

"annotated"在系统中有两个含义，由不同机制驱动：

| 机制 | 触发条件 | 效果 |
|---|---|---|
| 客户端 annotation 导出 | Draw 形状与 Image 的 AABB 重叠 | 生成 `_annotated.png` 文件 |
| 服务端 snapshot 标记 | Draw 重叠 **或** Arrow 连接到 Image | 快照输出中标记 `(annotated)` |

即：Arrow 连接到图片会让 snapshot 标记 `(annotated)`，但不会生成 `_annotated.png` 文件。

---

## 八、持久化

`.canvas.json` 保存完整的画布状态，500ms 防抖写入：

```jsonc
{
  "version": 1,
  "tldraw": { /* getSnapshot(editor.store) 输出 */ },
  "shapeToFile": {
    "shape:abc123": "notes.txt",
    "shape:def456": "refs/style.png",
    "shape:frame1": "refs"
  }
}
```

触发保存的操作：
- 任何形状创建/更新/删除
- FS 变更导致的画布更新
- 映射关系变化

---

## 九、循环防护

双向同步的核心挑战是避免 画布->FS->画布 的无限循环：

- **画布 -> FS 方向**：`store.listen` 仅监听 `source: "user"` 的变更
- **FS -> 画布 方向**：通过 `applyRemote()` (`editor.store.mergeRemoteChanges`) 标记为远程变更，不会触发 user 监听器
- **FS 监视器**：服务端文件监视器使用 `ignorePaths` 集合，跳过由 canvas_sync 消息写入的路径（300ms 过期）

---

## 十、操作总览矩阵

```
                  画布->FS      FS->画布
创建 text         写 .txt       建 NamedText
创建 image        HTTP上传       建 Image + Asset
创建 frame        建目录         建 Frame
创建 draw         --            --
创建 arrow        --            --

删除 text         删 .txt       淡出 NamedText
删除 image        删 .png       淡出 Image
删除 frame        删目录         淡出 Frame + 子元素
删除 draw         (*)           --
删除 arrow        --            --

修改 text内容     重写 .txt      更新文字
修改 image内容    --            刷新 Image 资源
重命名 text       改文件名       (检测为move)
重命名 frame      改目录名       (检测为move)

移动 text入frame  mv到子目录     reparent + 动画
移动 text出frame  mv到根目录     reparent + 动画
移动 image入frame mv到子目录     reparent + 动画
移动 image出frame mv到根目录     reparent + 动画

draw覆盖image     (*) 导出annotated  --
draw移到image上   (*) 导出annotated  --
draw移离image     (*) 删annotated    --
image移到draw下   (*) 触发 annotation  --

arrow连接两端     (*) snapshot输出    --
arrow连接image    (*) snapshot标记    --
arrow断开image    (*) snapshot去标记  --
arrow重连         (*) snapshot更新    --
```

`--` 表示无操作
`(*)` 表示间接效果（不产生 canvas_sync 消息，但触发 annotation 检查或影响 snapshot）
`!` 表示已知问题

---

## 十一、名称冲突处理

当多个形状使用相同名称时（如复制一个 NamedText），文件系统会产生路径冲突。

**当前状态**：已实现去重。创建/重命名/移动时若路径冲突，自动添加数字后缀：
`brief.txt` -> `brief-1.txt` -> `brief-2.txt`。

---

## 十二、初始加载与恢复

| 场景 | 行为 |
|---|---|
| 有 `.canvas.json` + 有文件 | 从快照加载画布状态，然后与实际文件列表协调（reconcile）：删除多余形状、补建缺失形状、更新文本内容 |
| 无 `.canvas.json` + 有文件 | 从文件系统引导（bootstrap）：为每个文件/目录创建对应形状 |
| 无 `.canvas.json` + 无文件 | 空画布 |
| 页面刷新 | 等同于重新初始化，走上述流程 |

---

## 十三、当前限制与已知问题

1. **Arrow 连接不产生 annotated 文件**：Arrow 连接图片只影响 snapshot 标记，不导出 `_annotated.png` 文件（与 Draw 行为不一致）
2. **Frame 不可嵌套**：`NoNestFrameShapeUtil` 阻止 Frame 嵌套，因此 canvas/ 下目录结构只有一层
3. **画笔/箭头不产生文件**：它们没有文件映射，跨 Frame 移动只影响 `.canvas.json`
4. **文件系统重命名检测仍有歧义**：若 size/mtime/内容不足以唯一匹配，仍会回退为"删除+创建"
