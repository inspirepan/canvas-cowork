~/code/GITHUB/badlogic-pi-mono

## SDK 集成现状资料文档

### 一、入口函数 `createAgentSession()`

位于 `packages/coding-agent/src/core/sdk.ts`，从 `@mariozechner/pi-coding-agent` 导出。

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent"

const { session, extensionsResult, modelFallbackMessage } = await createAgentSession(options)
```

**`CreateAgentSessionOptions`**：

| 字段              | 类型                            | 默认值                                    | 说明                                         |
| ----------------- | ------------------------------- | ----------------------------------------- | -------------------------------------------- |
| `cwd`             | `string`                        | `process.cwd()`                           | 工作目录，所有文件工具以此为根               |
| `agentDir`        | `string`                        | `~/.pi/agent`                             | 全局配置目录（auth、models、settings）       |
| `authStorage`     | `AuthStorage`                   | 基于 agentDir 自动创建                    | 凭证存储                                     |
| `modelRegistry`   | `ModelRegistry`                 | 基于 authStorage 自动创建                 | 模型发现和 API key 解析                      |
| `model`           | `Model<any>`                    | 从 settings/环境变量自动发现              | 指定使用的模型                               |
| `thinkingLevel`   | `ThinkingLevel`                 | `"medium"`                                | 推理级别，自动 clamp 到模型能力              |
| `scopedModels`    | `Array<{model, thinkingLevel}>` | `[]`                                      | 可在运行时切换的模型列表                     |
| `tools`           | `Tool[]`                        | `codingTools` = [read, bash, edit, write] | 启用的内置工具                               |
| `customTools`     | `ToolDefinition[]`              | `[]`                                      | 自定义工具                                   |
| `resourceLoader`  | `ResourceLoader`                | `DefaultResourceLoader`                   | 控制技能、提示模板、上下文文件、系统提示加载 |
| `sessionManager`  | `SessionManager`                | `SessionManager.create(cwd)`              | 会话持久化                                   |
| `settingsManager` | `SettingsManager`               | `SettingsManager.create(cwd, agentDir)`   | 用户设置                                     |

**返回值 `CreateAgentSessionResult`**：

```typescript
{
  session: AgentSession       // 主操作对象
  extensionsResult: LoadExtensionsResult  // 扩展加载结果
  modelFallbackMessage?: string           // 模型恢复失败的警告
}
```

---

### 二、`AgentSession` 公开 API

位于 `packages/coding-agent/src/core/agent-session.ts`，约 2800 行。

#### 核心操作

```typescript
// 发送提示
await session.prompt(text: string, options?: PromptOptions)

// 中断当前执行（agent 正在跑工具时插入新指令）
await session.steer(text: string, images?: ImageContent[])

// 等当前执行完后追加指令
await session.followUp(text: string, images?: ImageContent[])

// 中止
await session.abort()

// 释放资源
session.dispose()
```

**`PromptOptions`**：

```typescript
{
  expandPromptTemplates?: boolean     // 默认 true，展开 /skill 和模板
  images?: ImageContent[]             // 附图
  streamingBehavior?: "steer" | "followUp"  // agent 正在跑时必须指定
  source?: InputSource                // 输入来源标记
}
```

#### 状态读取

```typescript
session.model                    // Model<any> | undefined
session.thinkingLevel            // ThinkingLevel
session.isStreaming              // boolean
session.messages                 // AgentMessage[]
session.systemPrompt             // string (当前生效的完整系统提示)
session.sessionId                // string
session.sessionFile              // string | undefined
session.pendingMessageCount      // number
session.isCompacting             // boolean
session.state                    // AgentState (完整底层状态)

session.getSteeringMessages()    // readonly string[]
session.getFollowUpMessages()    // readonly string[]
session.getActiveToolNames()     // string[]
session.getAllTools()             // Array<{name, description}>
```

#### 模型和思考级别

```typescript
await session.setModel(model: Model<any>)
session.setThinkingLevel(level: ThinkingLevel)
await session.cycleModel("forward" | "backward")  // 返回 ModelCycleResult | undefined
```

#### 工具管理

```typescript
session.setActiveToolsByName(["read", "bash", "edit", "write"])  // 同时重建系统提示
session.getAllTools()  // 返回已注册的全部工具（含自定义）
```

#### 会话管理

```typescript
await session.newSession({ parentSession?: string })
await session.compact(customInstructions?: string)  // 手动压缩上下文
session.getStats()  // SessionStats
```

#### 事件订阅

```typescript
const unsub = session.subscribe((event: AgentSessionEvent) => { ... })
```

#### 扩展绑定

```typescript
await session.bindExtensions({
  uiContext?: ExtensionUIContext,       // UI 交互实现
  commandContextActions?: ...,          // 命令上下文
  shutdownHandler?: ShutdownHandler,
  onError?: ExtensionErrorListener,
})
```

`bindExtensions` 必须在使用扩展前调用，它触发 `session_start` 事件并加载扩展资源。如果不使用扩展系统，可以不调用。

---

### 三、事件类型 `AgentSessionEvent`

是 `AgentEvent`（来自 pi-agent-core）加上会话级扩展事件的联合类型：

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
  | { type: "auto_compaction_end"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
```

`AgentEvent` 来自 `@mariozechner/pi-agent-core`：

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
```

`message_update` 中的 `assistantMessageEvent` 是 pi-ai 的流式事件，包含 `text_delta`、`thinking_delta`、`toolcall_start`/`delta`/`end` 等。

---

### 四、自定义工具 `ToolDefinition`

位于 `packages/coding-agent/src/core/extensions/types.ts`。

```typescript
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string                    // LLM 调用的工具名
  label: string                   // UI 显示标签
  description: string             // LLM 看到的工具描述
  parameters: TParams             // TypeBox schema

  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,         // 可访问 cwd、model、ui 等
  ): Promise<AgentToolResult<TDetails>>

  renderCall?: (args, theme) => Component     // 可选：TUI 渲染工具调用
  renderResult?: (result, options, theme) => Component  // 可选：TUI 渲染工具结果
}
```

`AgentToolResult`：

```typescript
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[]   // 返回给 LLM 的内容
  details: T                                 // UI/日志用的附加信息
}
```

通过 `createAgentSession({ customTools: [...] })` 传入，与内置工具合并注册。

---

### 五、系统提示

**默认行为**：`createAgentSession` 内部调用 `buildSystemPrompt()` 生成系统提示，包含：
1. 当前启用工具的描述和使用指南
2. `AGENTS.md` / `CLAUDE.md` 项目上下文文件
3. 技能列表
4. 当前日期时间和 cwd

**自定义方式**（三选一，可组合）：

| 方式                                 | 说明                                  |
| ------------------------------------ | ------------------------------------- |
| `.pi/SYSTEM.md` 文件                 | 完全替换默认系统提示                  |
| `.pi/APPEND_SYSTEM.md` 文件          | 追加到默认提示末尾                    |
| `session.agent.setSystemPrompt(str)` | 运行时直接替换（绕过 ResourceLoader） |

注意：`setActiveToolsByName()` 会重建系统提示（因为提示包含工具描述）。如果你在之后手动 `setSystemPrompt`，不会包含工具描述除非你自己拼。

`buildSystemPrompt()` 也是公开导出的，可以直接调用：

```typescript
import { buildSystemPrompt } from "@mariozechner/pi-coding-agent"

const prompt = buildSystemPrompt({
  cwd: "/my/project",
  selectedTools: ["read", "bash", "edit", "write"],
  appendSystemPrompt: "你是一个...",
  contextFiles: [{ path: "AGENTS.md", content: "..." }],
  skills: [],
})
```

---

### 六、内置工具清单

| 工具名  | 说明                                       | 工厂函数               |
| ------- | ------------------------------------------ | ---------------------- |
| `read`  | 读文件（支持 offset/limit/encoding/image） | `createReadTool(cwd)`  |
| `write` | 创建/覆盖文件                              | `createWriteTool(cwd)` |
| `edit`  | 精确字符串替换编辑                         | `createEditTool(cwd)`  |
| `bash`  | 执行 bash 命令                             | `createBashTool(cwd)`  |
| `grep`  | 模式搜索（尊重 .gitignore）                | `createGrepTool(cwd)`  |
| `find`  | 文件 glob 查询                             | `createFindTool(cwd)`  |
| `ls`    | 目录列表                                   | `createLsTool(cwd)`    |

预组合：
- `codingTools` = [read, bash, edit, write] -- **默认启用**
- `readOnlyTools` = [read, grep, find, ls]
- `createCodingTools(cwd)` / `createReadOnlyTools(cwd)` -- 自定义 cwd 版本

---

### 七、`SessionManager` 持久化选项

```typescript
SessionManager.create(cwd)                    // 默认：文件持久化到 ~/.pi/agent/sessions/{cwd-hash}/
SessionManager.inMemory(cwd)                  // 内存模式，不写文件
SessionManager.continueRecent(cwd)            // 恢复最近的会话
SessionManager.open(path)                     // 打开指定会话文件
```

传给 `createAgentSession({ sessionManager: SessionManager.inMemory() })` 即可禁用持久化。

---

### 八、`AgentMessage` 类型体系

```typescript
// pi-ai 的基础 LLM 消息
type Message = UserMessage | AssistantMessage | ToolResultMessage

// pi-agent-core 的扩展消息（支持声明合并添加自定义类型）
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]
```

coding-agent 在内部通过 `convertToLlm()` 过滤 AgentMessage -> Message，只有 user/assistant/toolResult 传给 LLM，自定义消息类型被过滤掉。

---

### 九、模型指定

```typescript
import { getModel } from "@mariozechner/pi-ai"

// 直接指定
const model = getModel("anthropic", "claude-sonnet-4-20250514")
const { session } = await createAgentSession({ model, thinkingLevel: "high" })

// 或让 SDK 自动发现（检查环境变量中哪些 provider 有 key）
const { session } = await createAgentSession()
```

自动发现逻辑：settings 默认 > 各 provider 的环境变量检测 > 第一个可用模型。

---

### 十、现有 Web UI 包 (`@mariozechner/pi-web-ui`)

是一个独立的浏览器端 chat UI，基于 web components (mini-lit + Tailwind)。

- 使用 `@mariozechner/pi-agent-core` 的 Agent 类（**不是** coding-agent）
- 工具在浏览器端执行（JS REPL、文档提取等）
- 通过 `streamProxy()` 把 LLM 调用代理到后端
- 存储用 IndexedDB

**它和你想做的事不同**：web-ui 是纯浏览器应用，工具在浏览器端跑。你需要的是工具在服务端跑（文件系统访问），且要用 coding-agent 的完整工具链。

---

### 十一、`streamProxy()` 后端代理

位于 `packages/agent/src/proxy.ts`。为浏览器环境设计，把 LLM 调用通过你的服务端中转：

```typescript
import { Agent, streamProxy } from "@mariozechner/pi-agent-core"

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server/api/stream",
    }),
})
```

**和你的场景的关系**：如果你的 web 前端直接通过 WebSocket 和服务端通信（服务端持有 AgentSession），你不需要 streamProxy。streamProxy 是给"工具也在浏览器端跑，只有 LLM 调用需要代理"的场景设计的。

---

### 十二、关键依赖版本

```
@mariozechner/pi-ai: ^0.52.6        (LLM 流、模型定义)
@mariozechner/pi-agent-core: ^0.52.6 (Agent 类、事件、工具接口)
@sinclair/typebox: (工具参数 schema)
```