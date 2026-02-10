# Canvas Cowork

给 Claude Cowork 添加一个画布 UI

一个空间画布界面，让人类和 AI 代理在共享工作区协同工作。画布抽象为文件系统——用户在画布上可视化交互，代理读取写入文件。



## 工作原理

### 画布文件系统（Canvas FS）

每个画布元素都双向映射到文件或目录：

| 画布元素 | 文件系统 | 说明 |
|----------|----------|------|
| 文本 | `name.txt` | 文本内容存于文件 |
| 图片 | `name.png` | 图片文件，可带说明覆盖层 |
| 框架 | `name/` | 用于分组元素的目录 |
| 箭头 | 连接元数据 | 表示元素之间的语义链接 |

当用户将图片拖入框架时，代理会看到文件被移动到相应目录。代理写入新文件时，画布会自动显示该文件。同步层会处理去重、重命名检测以及图片刷新，以保持双方一致。

### 注释图片（Annotated Images）

图片上有箭头或绘图时，代理会收到两种视图：原始图片和带有标记的注释图片（截图），从而实现精确的视觉反馈。

## 代理工具

- `canvas_snapshot`：画布的语义快照，树状目录结构并包含箭头连接
- `canvas_screenshot`：完整画布截图，用于提供视觉上下文
- `generate_image`：支持多图引用（style_reference、content_reference、edit_target）的 AI 图像生成与编辑，支持子目录输出路径
- 标准文件操作（read、write、edit、bash），范围限制在画布目录

### 大纲面板（Outline Panel）

文件树侧边栏，映射画布结构。框架显示为可折叠文件夹，文本和图片为叶子节点（图片带缩略图）。点击节点可选中并放大对应的画布形状。

### 粘贴图片（Paste Images）

可以直接粘贴或从文件选择图片到画布。图片在服务器端（via sharp）自动压缩后再发送给模型。

### 提示文件自动保存（Prompt File Auto‑Save）

超过 200 字的用户消息会自动保存为画布目录下的文本文件，完整保留提示内容，便于代理后续引用。

### 画布组织（Canvas Organization）

代理主动创建框架对相关元素进行分组，遵循与用户语言相匹配的命名约定。

## 带上下文的聊天（Chat with Context）

聊天输入支持 `@` 提及画布元素，并可将当前画布选区作为上下文附加给代理。

## 技术栈

- **运行时**：Bun
- **画布**：tldraw v4
- **前端**：React 19、Tailwind CSS v4、shadcn/ui
- **构建**：Vite
- **图像处理**：[sharp](https://sharp.pixelplumbing.com)（服务器端压缩）
- **代理**：Anthropic Claude via [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

## 快速开始

```bash
bun install
bun run dev
```

上述命令会启动 Vite 开发服务器（端口 5173）和 Bun 后端（端口 3000）。

## 配置

### LLM

默认模型为通过 OpenRouter 使用的 `anthropic/claude-opus-4.6`。设置对应的 API Key 环境变量：

```bash
export OPENROUTER_API_KEY=your-key
```

可在 UI 中切换模型。可用模型取决于已配置的 API Key。支持的供应商及对应环境变量：

| 供应商 | 环境变量 |
|--------|----------|
| OpenRouter | `OPENROUTER_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| xAI | `XAI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |

完整供应商列表参见 [pi-mono 供应商文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)。

### 图像生成

`generate_image` 工具使用 Google Gemini 图像生成 API（`scripts/generate_image.py`）。配置以下任一方式：

**方式一：Gemini API Key**

```bash
export GEMINI_API_KEY=your-key
```

**方式二：Google Vertex AI**

```bash
export GOOGLE_GENAI_USE_VERTEXAI=1
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_CLOUD_LOCATION=global
export GOOGLE_APPLICATION_CREDENTIALS=$HOME/.config/google-vertex-ai/credentials.json
```

## 架构

```
src/
  server/          # Bun HTTP/WebSocket 端，代理会管理，Canvas FS 桥接
  shared/          # WebSocket 协议类型
  web/src/
    components/    # React UI（画布编辑器、代理面板、聊天）
    canvas/        # 双向画布‑文件系统同步逻辑
    hooks/         # WebSocket 连接与代理状态管理
canvas/            # Canvas FS 工作目录（代理的工作空间）
```

## 许可证

MIT
