# Pi Coding Agent SDK API Reference

> Based on source code analysis of `@mariozechner/pi-coding-agent@0.52.6`
>
> Last updated: 2026-02-08

---

## 1. Package Structure & Exports

The SDK is split into three packages:

| Package | Description |
|---------|------------|
| `@mariozechner/pi-coding-agent` | Top-level SDK: `createAgentSession`, `AgentSession`, `SessionManager`, tools, extensions |
| `@mariozechner/pi-agent-core` | Core agent loop: `Agent`, `AgentEvent`, `AgentMessage`, `ThinkingLevel` |
| `@mariozechner/pi-ai` | LLM abstraction: `Model`, `Message` types, `AssistantMessageEvent`, streaming |

### Main Exports from `@mariozechner/pi-coding-agent`

```typescript
// Factory function - primary entry point
export { createAgentSession } from "./core/sdk.js";
export type { CreateAgentSessionOptions, CreateAgentSessionResult } from "./core/sdk.js";

// Core session
export { AgentSession } from "./core/agent-session.js";
export type {
  AgentSessionConfig,
  AgentSessionEvent,
  AgentSessionEventListener,
  ModelCycleResult,
  ParsedSkillBlock,
  PromptOptions,
  SessionStats,
} from "./core/agent-session.js";

// Session management
export { SessionManager } from "./core/session-manager.js";
export type {
  SessionInfo,
  SessionEntry,
  SessionMessageEntry,
  SessionContext,
  SessionHeader,
  CompactionEntry,
  BranchSummaryEntry,
  ThinkingLevelChangeEntry,
  ModelChangeEntry,
  CustomEntry,
  CustomMessageEntry,
  SessionInfoEntry,
  NewSessionOptions,
  FileEntry,
  SessionEntryBase,
} from "./core/session-manager.js";

// Model registry
export { ModelRegistry } from "./core/model-registry.js";

// Auth
export { AuthStorage } from "./core/auth-storage.js";

// Settings
export { SettingsManager } from "./core/settings-manager.js";

// Tools
export { codingTools, readOnlyTools, createCodingTools, ... } from "./core/tools/index.js";

// Extension types
export type { ToolDefinition, ExtensionAPI, ExtensionFactory, ... } from "./core/extensions/index.js";

// SDK
export { createAgentSession } from "./core/sdk.js";

// Event bus
export { createEventBus } from "./core/event-bus.js";
export type { EventBus, EventBusController } from "./core/event-bus.js";
```

---

## 2. createAgentSession()

> Source: `packages/coding-agent/src/core/sdk.ts`

The primary entry point for creating a session programmatically.

### Options

```typescript
export interface CreateAgentSessionOptions {
  /** Working directory for project-local discovery. Default: process.cwd() */
  cwd?: string;
  /** Global config directory. Default: ~/.pi/agent */
  agentDir?: string;

  /** Auth storage for credentials. Default: new AuthStorage(agentDir/auth.json) */
  authStorage?: AuthStorage;
  /** Model registry. Default: new ModelRegistry(authStorage, agentDir/models.json) */
  modelRegistry?: ModelRegistry;

  /** Model to use. Default: from settings, else first available */
  model?: Model<any>;
  /** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
  thinkingLevel?: ThinkingLevel;
  /** Models available for cycling (Ctrl+P in interactive mode) */
  scopedModels?: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>;

  /** Built-in tools to use. Default: codingTools [read, bash, edit, write] */
  tools?: Tool[];
  /** Custom tools to register (in addition to built-in tools). */
  customTools?: ToolDefinition[];

  /** Resource loader. When omitted, DefaultResourceLoader is used. */
  resourceLoader?: ResourceLoader;

  /** Session manager. Default: SessionManager.create(cwd) */
  sessionManager?: SessionManager;

  /** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
  settingsManager?: SettingsManager;
}
```

### Return value

```typescript
export interface CreateAgentSessionResult {
  /** The created session */
  session: AgentSession;
  /** Extensions result (for UI context setup in interactive mode) */
  extensionsResult: LoadExtensionsResult;
  /** Warning if session was restored with a different model than saved */
  modelFallbackMessage?: string;
}
```

### Usage examples

```typescript
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

// Minimal - uses defaults
const { session } = await createAgentSession();

// With explicit model
const { session } = await createAgentSession({
  model: getModel("anthropic", "claude-opus-4-5"),
  thinkingLevel: "high",
});

// In-memory session (no file persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// With custom working directory
const { session } = await createAgentSession({
  cwd: "/path/to/project",
});
```

---

## 3. AgentSession

> Source: `packages/coding-agent/src/core/agent-session.ts`

Core abstraction for agent lifecycle and session management. Shared between all run modes (interactive, print, rpc).

### Constructor

```typescript
export class AgentSession {
  constructor(config: AgentSessionConfig);
}

export interface AgentSessionConfig {
  agent: Agent;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  cwd: string;
  scopedModels?: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>;
  resourceLoader: ResourceLoader;
  customTools?: ToolDefinition[];
  modelRegistry: ModelRegistry;
  initialActiveToolNames?: string[];
  baseToolsOverride?: Record<string, AgentTool>;
  extensionRunnerRef?: { current?: ExtensionRunner };
}
```

### Read-only Properties

```typescript
class AgentSession {
  // Core state
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;

  /** Full agent state (systemPrompt, model, thinkingLevel, tools, messages, isStreaming, ...) */
  get state(): AgentState;

  /** Current model (may be undefined) */
  get model(): Model<any> | undefined;

  /** Current thinking level */
  get thinkingLevel(): ThinkingLevel;

  /** Whether agent is currently streaming a response */
  get isStreaming(): boolean;

  /** Current system prompt */
  get systemPrompt(): string;

  /** All messages including custom types */
  get messages(): AgentMessage[];

  /** Current steering mode */
  get steeringMode(): "all" | "one-at-a-time";

  /** Current follow-up mode */
  get followUpMode(): "all" | "one-at-a-time";

  /** Current session file path, or undefined if in-memory */
  get sessionFile(): string | undefined;

  /** Current session ID */
  get sessionId(): string;

  /** Current session display name */
  get sessionName(): string | undefined;

  /** Number of pending messages (steering + follow-up) */
  get pendingMessageCount(): number;

  /** Whether auto-compaction is currently running */
  get isCompacting(): boolean;

  /** Whether auto-retry is in progress */
  get isRetrying(): boolean;

  /** Whether auto-compaction is enabled */
  get autoCompactionEnabled(): boolean;

  /** Whether auto-retry is enabled */
  get autoRetryEnabled(): boolean;

  /** Current retry attempt (0 if not retrying) */
  get retryAttempt(): number;

  /** Whether a bash command is currently running */
  get isBashRunning(): boolean;

  /** Scoped models for cycling */
  get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel: ThinkingLevel }>;

  /** Model registry */
  get modelRegistry(): ModelRegistry;
}
```

### Event Subscription

```typescript
class AgentSession {
  /**
   * Subscribe to agent events.
   * Multiple listeners can be added. Returns unsubscribe function.
   * Session persistence is handled internally.
   */
  subscribe(listener: AgentSessionEventListener): () => void;

  /**
   * Remove all listeners and disconnect from agent.
   * Call when completely done with the session.
   */
  dispose(): void;
}

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
```

### Prompting

```typescript
class AgentSession {
  /**
   * Send a prompt to the agent.
   * - Handles extension commands
   * - Expands prompt templates by default
   * - During streaming, queues via steer/followUp based on streamingBehavior
   * @throws Error if streaming and no streamingBehavior specified
   * @throws Error if no model selected or no API key
   */
  async prompt(text: string, options?: PromptOptions): Promise<void>;

  /**
   * Queue a steering message - interrupts agent mid-run.
   * Delivered after current tool execution, skips remaining tools.
   */
  async steer(text: string, images?: ImageContent[]): Promise<void>;

  /**
   * Queue a follow-up message - processed after agent finishes.
   */
  async followUp(text: string, images?: ImageContent[]): Promise<void>;

  /**
   * Abort current operation and wait for idle.
   */
  async abort(): Promise<void>;

  /**
   * Clear all queued messages and return them.
   */
  clearQueue(): { steering: string[]; followUp: string[] };

  /** Get pending steering messages (read-only) */
  getSteeringMessages(): readonly string[];

  /** Get pending follow-up messages (read-only) */
  getFollowUpMessages(): readonly string[];

  /**
   * Send a user message to the agent. Always triggers a turn.
   * No prompt template expansion or command handling.
   */
  async sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void>;

  /**
   * Send a custom (extension) message to the session.
   */
  async sendCustomMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>;
}

export interface PromptOptions {
  /** Whether to expand file-based prompt templates (default: true) */
  expandPromptTemplates?: boolean;
  /** Image attachments */
  images?: ImageContent[];
  /** When streaming, how to queue: "steer" (interrupt) or "followUp" (wait). */
  streamingBehavior?: "steer" | "followUp";
  /** Source of input for extension input event handlers. */
  source?: InputSource;
}
```

### Model Management

```typescript
class AgentSession {
  /**
   * Set model directly. Validates API key. Saves to session and settings.
   * @throws Error if no API key available
   */
  async setModel(model: Model<any>): Promise<void>;

  /**
   * Cycle to next/previous model.
   * @returns New model info, or undefined if only one available
   */
  async cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>;

  /** Update scoped models for cycling */
  setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>): void;
}

export interface ModelCycleResult {
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  isScoped: boolean;
}
```

### Thinking Level Management

```typescript
class AgentSession {
  /** Set thinking level. Clamps to model capabilities. Saves to session and settings. */
  setThinkingLevel(level: ThinkingLevel): void;

  /** Cycle to next thinking level. Returns new level or undefined. */
  cycleThinkingLevel(): ThinkingLevel | undefined;

  /** Get available thinking levels for current model */
  getAvailableThinkingLevels(): ThinkingLevel[];

  /** Check if current model supports thinking/reasoning */
  supportsThinking(): boolean;

  /** Check if current model supports xhigh thinking level */
  supportsXhighThinking(): boolean;
}
```

### Session Management

```typescript
class AgentSession {
  /**
   * Start a new session.
   * Clears all messages. Listeners are preserved.
   * @returns true if completed, false if cancelled by extension
   */
  async newSession(options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
  }): Promise<boolean>;

  /**
   * Switch to a different session file.
   * Loads messages, restores model/thinking level.
   * @returns true if completed, false if cancelled by extension
   */
  async switchSession(sessionPath: string): Promise<boolean>;

  /** Set a display name for the current session */
  setSessionName(name: string): void;

  /**
   * Create a fork from a specific entry.
   * @returns selectedText and cancelled status
   */
  async fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }>;

  /** Get all user messages from session for fork selector */
  getUserMessagesForForking(): Array<{ entryId: string; text: string }>;

  /** Get session statistics */
  getSessionStats(): SessionStats;

  /** Get context usage info */
  getContextUsage(): ContextUsage | undefined;

  /** Get text content of last assistant message */
  getLastAssistantText(): string | undefined;

  /** Export session to HTML */
  async exportToHtml(outputPath?: string): Promise<string>;
}

export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}
```

### Tool Management

```typescript
class AgentSession {
  /** Get names of currently active tools */
  getActiveToolNames(): string[];

  /** Get all configured tools with name and description */
  getAllTools(): Array<{ name: string; description: string }>;

  /** Set active tools by name. Unknown names are ignored. */
  setActiveToolsByName(toolNames: string[]): void;
}
```

### Queue Mode Management

```typescript
class AgentSession {
  setSteeringMode(mode: "all" | "one-at-a-time"): void;
  setFollowUpMode(mode: "all" | "one-at-a-time"): void;
}
```

### Compaction

```typescript
class AgentSession {
  /** Manually compact the session context. Aborts current operation first. */
  async compact(customInstructions?: string): Promise<CompactionResult>;

  /** Cancel in-progress compaction */
  abortCompaction(): void;

  /** Toggle auto-compaction */
  setAutoCompactionEnabled(enabled: boolean): void;
}
```

### Retry

```typescript
class AgentSession {
  /** Cancel in-progress retry */
  abortRetry(): void;

  /** Toggle auto-retry */
  setAutoRetryEnabled(enabled: boolean): void;
}
```

### Bash Execution

```typescript
class AgentSession {
  /** Execute a bash command. Adds result to agent context and session. */
  async executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; operations?: BashOperations },
  ): Promise<BashResult>;

  /** Cancel running bash command */
  abortBash(): void;
}
```

---

## 4. AgentSessionEvent / AgentEvent

> Source:
> - Agent events: `packages/agent/src/types.ts`
> - Session events: `packages/coding-agent/src/core/agent-session.ts`

### AgentEvent (core)

```typescript
export type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }

  // Turn lifecycle - a turn is one assistant response + any tool calls/results
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }

  // Message lifecycle - emitted for user, assistant, and toolResult messages
  | { type: "message_start"; message: AgentMessage }
  // Only emitted for assistant messages during streaming
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }

  // Tool execution lifecycle
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

### AgentSessionEvent (extends AgentEvent)

```typescript
export type AgentSessionEvent =
  | AgentEvent
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
  | {
      type: "auto_compaction_end";
      result: CompactionResult | undefined;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

### Event Flow during a prompt

```
agent_start
  turn_start
    message_start (user message)
    message_end (user message)
    message_start (assistant message - streaming begins)
    message_update (text_delta / thinking_delta / toolcall events)
    message_update (text_delta / thinking_delta / toolcall events)
    ...
    message_end (assistant message - streaming complete)
    tool_execution_start
    tool_execution_update (optional, for streaming tool output)
    tool_execution_end
    message_start (toolResult message)
    message_end (toolResult message)
  turn_end
  turn_start (if agent continues with tool results)
    ...
  turn_end
agent_end
```

---

## 5. AssistantMessageEvent (streaming deltas)

> Source: `packages/ai/src/types.ts`

This is the key type for rendering streaming content. It appears in `message_update` events as the `assistantMessageEvent` field.

```typescript
export type AssistantMessageEvent =
  // Stream lifecycle
  | { type: "start"; partial: AssistantMessage }

  // Text content streaming
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }

  // Thinking/reasoning streaming
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }

  // Tool call streaming
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }

  // Completion
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

### How to handle streaming in canvas-cowork

```typescript
session.subscribe((event) => {
  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent;

    switch (ame.type) {
      case "text_delta":
        // Append delta text to current text block
        appendText(ame.delta);
        break;

      case "thinking_delta":
        // Append thinking/reasoning text
        appendThinking(ame.delta);
        break;

      case "toolcall_start":
        // New tool call beginning
        break;

      case "toolcall_end":
        // Tool call complete: ame.toolCall.name, ame.toolCall.arguments
        break;

      case "done":
        // Full message available: ame.message
        break;

      case "error":
        // Error: ame.error.errorMessage
        break;
    }
  }
});
```

---

## 6. Message Types

> Source: `packages/ai/src/types.ts`

### UserMessage

```typescript
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number; // Unix timestamp in milliseconds
}
```

### AssistantMessage

```typescript
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  usage: Usage;
  stopReason: StopReason; // "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string;
  timestamp: number;
}
```

### ToolResultMessage

```typescript
export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}
```

### Content Block Types

```typescript
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

export interface ImageContent {
  type: "image";
  data: string;       // base64 encoded image data
  mimeType: string;   // e.g., "image/jpeg", "image/png"
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
}
```

### Union Type

```typescript
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

### AgentMessage (extended)

In `@mariozechner/pi-agent-core`, `AgentMessage` is extended via declaration merging to include custom types:

```typescript
// Base definition
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// The coding agent extends this with:
// - BashExecutionMessage  (role: "bashExecution")
// - CustomMessage         (role: "custom")
// - BranchSummaryMessage  (role: "branchSummary")
// - CompactionSummaryMessage (role: "compactionSummary")
```

### Usage

```typescript
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### How to extract content from messages

```typescript
// User text content
function getUserText(msg: UserMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// Assistant text content (excluding thinking and tool calls)
function getAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// Assistant thinking/reasoning content
function getThinking(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is ThinkingContent => c.type === "thinking")
    .map((c) => c.thinking)
    .join("");
}

// Tool calls from assistant message
function getToolCalls(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((c): c is ToolCall => c.type === "toolCall");
}

// Tool result text
function getToolResultText(msg: ToolResultMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}
```

---

## 7. SessionManager

> Source: `packages/coding-agent/src/core/session-manager.ts`

Manages conversation sessions as append-only trees stored in JSONL files.

### Static Factory Methods

```typescript
class SessionManager {
  /** Create a new session with file persistence */
  static create(cwd: string, sessionDir?: string): SessionManager;

  /** Open a specific session file */
  static open(path: string, sessionDir?: string): SessionManager;

  /** Continue the most recent session, or create new if none */
  static continueRecent(cwd: string, sessionDir?: string): SessionManager;

  /** Create an in-memory session (no file persistence) */
  static inMemory(cwd?: string): SessionManager;

  /** Fork from another project directory */
  static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager;

  /** List all sessions for a directory (sorted by modified date, newest first) */
  static async list(
    cwd: string,
    sessionDir?: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<SessionInfo[]>;

  /** List all sessions across all project directories */
  static async listAll(
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<SessionInfo[]>;
}
```

### Instance Methods - State Access

```typescript
class SessionManager {
  isPersisted(): boolean;
  getCwd(): string;
  getSessionDir(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getChildren(parentId: string): SessionEntry[];
  getLabel(id: string): string | undefined;
  getHeader(): SessionHeader | null;

  /** Get all entries (excludes header), shallow copy */
  getEntries(): SessionEntry[];

  /** Walk from entry to root (or from leaf if no fromId) */
  getBranch(fromId?: string): SessionEntry[];

  /** Get the session as a tree structure */
  getTree(): SessionTreeNode[];

  /** Build the LLM context from the current branch path */
  buildSessionContext(): SessionContext;
}
```

### Instance Methods - Mutation

```typescript
class SessionManager {
  /** Switch to a different session file */
  setSessionFile(sessionFile: string): void;

  /** Start a new session */
  newSession(options?: NewSessionOptions): string | undefined;

  /** Append a message, returns entry id */
  appendMessage(message: Message | CustomMessage | BashExecutionMessage): string;

  /** Append a thinking level change */
  appendThinkingLevelChange(thinkingLevel: string): string;

  /** Append a model change */
  appendModelChange(provider: string, modelId: string): string;

  /** Append a compaction summary */
  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
  ): string;

  /** Append session info (display name) */
  appendSessionInfo(name: string): string;

  /** Append a custom entry (extension data, not sent to LLM) */
  appendCustomEntry(customType: string, data?: unknown): string;

  /** Append a custom message entry (sent to LLM as user message) */
  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: T,
  ): string;

  /** Set or clear a label on an entry */
  appendLabelChange(targetId: string, label: string | undefined): string;

  /** Start a new branch from an earlier entry (moves leaf) */
  branch(branchFromId: string): void;

  /** Reset leaf to null (before all entries) */
  resetLeaf(): void;

  /** Branch with a summary of the abandoned path */
  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string;

  /** Create a new session file with a single branch path */
  createBranchedSession(leafId: string): string | undefined;
}
```

### Session Entry Types

```typescript
export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: T;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;
```

### SessionInfo (for listing)

```typescript
export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}
```

### SessionContext (for LLM)

```typescript
export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}
```

### Session File Format

Sessions are stored as `.jsonl` files (one JSON object per line).

```
{"type":"session","version":3,"id":"uuid","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/path"}
{"type":"thinking_level_change","id":"abc12345","parentId":null,"timestamp":"...","thinkingLevel":"medium"}
{"type":"model_change","id":"def67890","parentId":"abc12345","timestamp":"...","provider":"anthropic","modelId":"claude-opus-4-5"}
{"type":"message","id":"ghi11111","parentId":"def67890","timestamp":"...","message":{"role":"user","content":"hello","timestamp":1234567890}}
{"type":"message","id":"jkl22222","parentId":"ghi11111","timestamp":"...","message":{"role":"assistant","content":[...],...}}
```

---

## 8. Model and ThinkingLevel

### Model

> Source: `packages/ai/src/types.ts`

```typescript
export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;        // "anthropic-messages" | "openai-completions" | "openai-responses" | ...
  provider: Provider; // "anthropic" | "openai" | "google" | ...
  baseUrl: string;
  reasoning: boolean;  // Whether model supports thinking/reasoning
  input: ("text" | "image")[];
  cost: {
    input: number;     // $/million tokens
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ...;
}
```

### getModel()

```typescript
import { getModel, getModels, getProviders } from "@mariozechner/pi-ai";

// Get a specific model
const model = getModel("anthropic", "claude-opus-4-5");

// Get all models for a provider
const models = getModels("anthropic");

// Get all provider names
const providers = getProviders();
```

### ThinkingLevel

> Source: `packages/agent/src/types.ts`

```typescript
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

Available thinking levels depend on the model:
- Models without `reasoning: true`: only `"off"`
- Standard reasoning models: `["off", "minimal", "low", "medium", "high"]`
- Models supporting xhigh (GPT-5.2+, Claude Opus 4.6): `["off", "minimal", "low", "medium", "high", "xhigh"]`

Default thinking level: `"medium"`

---

## 9. ToolDefinition

> Source: `packages/coding-agent/src/core/extensions/types.ts`

For defining custom tools (e.g., a Snapshot tool for canvas-cowork).

```typescript
import type { TSchema, Static } from "@sinclair/typebox";

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  /** Tool name (used in LLM tool calls) */
  name: string;
  /** Human-readable label for UI */
  label: string;
  /** Description for LLM */
  description: string;
  /** Parameter schema (TypeBox) */
  parameters: TParams;

  /** Execute the tool */
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;

  /** Custom rendering for tool call display (TUI only) */
  renderCall?: (args: Static<TParams>, theme: Theme) => Component;

  /** Custom rendering for tool result display (TUI only) */
  renderResult?: (
    result: AgentToolResult<TDetails>,
    options: ToolRenderResultOptions,
    theme: Theme,
  ) => Component;
}
```

### Example: Creating a custom tool

```typescript
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const snapshotParams = Type.Object({
  html: Type.String({ description: "The complete HTML content" }),
  title: Type.Optional(Type.String({ description: "Snapshot title" })),
});

const snapshotTool: ToolDefinition = {
  name: "snapshot",
  label: "Snapshot",
  description: "Create or update a visual snapshot preview",
  parameters: snapshotParams,
  async execute(toolCallId, params, signal, onUpdate) {
    // Process the snapshot
    return {
      content: [{ type: "text", text: "Snapshot created successfully" }],
      details: { title: params.title },
    };
  },
};

// Pass to createAgentSession
const { session } = await createAgentSession({
  customTools: [snapshotTool],
});
```

### AgentToolResult

```typescript
export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
}
```

---

## 10. AgentState

> Source: `packages/agent/src/types.ts`

```typescript
export interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];       // Full conversation history
  isStreaming: boolean;
  streamMessage: AgentMessage | null; // Current message being streamed
  pendingToolCalls: Set<string>;
  error?: string;
}
```

---

## 11. Agent (core)

> Source: `packages/agent/src/agent.ts`

The low-level agent loop. Typically you interact with `AgentSession` instead.

```typescript
export class Agent {
  constructor(opts?: AgentOptions);

  get state(): AgentState;
  get sessionId(): string | undefined;
  set sessionId(value: string | undefined);

  subscribe(fn: (e: AgentEvent) => void): () => void;

  // State mutators
  setSystemPrompt(v: string): void;
  setModel(m: Model<any>): void;
  setThinkingLevel(l: ThinkingLevel): void;
  setTools(t: AgentTool<any>[]): void;
  replaceMessages(ms: AgentMessage[]): void;
  appendMessage(m: AgentMessage): void;

  // Prompting
  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;

  // Steering
  steer(m: AgentMessage): void;
  followUp(m: AgentMessage): void;
  clearAllQueues(): void;

  // Control
  abort(): void;
  waitForIdle(): Promise<void>;
  reset(): void;
  async continue(): Promise<void>;

  // Modes
  setSteeringMode(mode: "all" | "one-at-a-time"): void;
  getSteeringMode(): "all" | "one-at-a-time";
  setFollowUpMode(mode: "all" | "one-at-a-time"): void;
  getFollowUpMode(): "all" | "one-at-a-time";
}
```

---

## 12. Custom Message Types (coding-agent)

> Source: `packages/coding-agent/src/core/messages.ts`

These are custom `AgentMessage` types added by the coding agent via declaration merging:

```typescript
/** Bash execution (!command in TUI) */
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

/** Extension-injected messages */
export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

/** Branch summary (from tree navigation) */
export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

/** Compaction summary */
export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

The `convertToLlm()` function converts these to LLM-compatible messages:
- `bashExecution` -> `user` message with formatted bash output
- `custom` -> `user` message with the content
- `branchSummary` -> `user` message with `<summary>` wrapper
- `compactionSummary` -> `user` message with `<summary>` wrapper

---

## 13. EventBus

> Source: `packages/coding-agent/src/core/event-bus.ts`

Simple event bus for extension communication.

```typescript
export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
  clear(): void;
}

export function createEventBus(): EventBusController;
```

---

## 14. Key RPC Types (reference for headless usage)

> Source: `packages/coding-agent/src/modes/rpc/rpc-types.ts`

The RPC mode demonstrates the full set of operations available headlessly:

```typescript
export type RpcCommand =
  // Prompting
  | { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: ImageContent[] }
  | { type: "follow_up"; message: string; images?: ImageContent[] }
  | { type: "abort" }
  | { type: "new_session"; parentSession?: string }

  // State
  | { type: "get_state" }

  // Model
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "cycle_model" }
  | { type: "get_available_models" }

  // Thinking
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "cycle_thinking_level" }

  // Compaction
  | { type: "compact"; customInstructions?: string }
  | { type: "set_auto_compaction"; enabled: boolean }

  // Session
  | { type: "get_session_stats" }
  | { type: "switch_session"; sessionPath: string }
  | { type: "get_messages" }
  | { type: "set_session_name"; name: string }
  ...
```

---

## 15. Practical Patterns for canvas-cowork AgentManager

### Pattern: Multiple concurrent sessions

```typescript
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

class AgentManager {
  private sessions = new Map<string, AgentSession>();

  async createSession(id: string, options?: { cwd?: string }): Promise<AgentSession> {
    const { session } = await createAgentSession({
      cwd: options?.cwd ?? process.cwd(),
      sessionManager: SessionManager.inMemory(options?.cwd),
      model: getModel("anthropic", "claude-sonnet-4-20250514"),
      thinkingLevel: "medium",
    });

    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  async destroySession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      await session.abort();
      session.dispose();
      this.sessions.delete(id);
    }
  }
}
```

### Pattern: Subscribing to streaming events

```typescript
function setupStreamingUI(session: AgentSession, onUpdate: (data: StreamData) => void) {
  return session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "agent_start":
        onUpdate({ type: "start" });
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          onUpdate({ type: "text", delta: ame.delta });
        } else if (ame.type === "thinking_delta") {
          onUpdate({ type: "thinking", delta: ame.delta });
        } else if (ame.type === "toolcall_end") {
          onUpdate({
            type: "toolCall",
            name: ame.toolCall.name,
            args: ame.toolCall.arguments,
            id: ame.toolCall.id,
          });
        }
        break;
      }

      case "tool_execution_start":
        onUpdate({ type: "toolExecStart", toolName: event.toolName, args: event.args });
        break;

      case "tool_execution_end":
        onUpdate({ type: "toolExecEnd", toolName: event.toolName, isError: event.isError });
        break;

      case "message_end":
        if (event.message.role === "assistant") {
          onUpdate({ type: "assistantDone", message: event.message });
        } else if (event.message.role === "toolResult") {
          onUpdate({ type: "toolResult", message: event.message });
        }
        break;

      case "agent_end":
        onUpdate({ type: "end" });
        break;
    }
  });
}
```

### Pattern: Switching model and thinking per session

```typescript
async function switchModelForSession(session: AgentSession) {
  const model = getModel("anthropic", "claude-opus-4-5");
  await session.setModel(model);
  session.setThinkingLevel("high");
}
```

### Pattern: Getting messages history

```typescript
function getHistory(session: AgentSession) {
  const messages = session.messages;

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        // User message
        break;
      case "assistant":
        // Assistant response with content blocks
        for (const block of msg.content) {
          if (block.type === "text") { /* text */ }
          if (block.type === "thinking") { /* reasoning */ }
          if (block.type === "toolCall") { /* tool call */ }
        }
        break;
      case "toolResult":
        // Tool execution result
        break;
      case "bashExecution":
        // User bash command result
        break;
      case "custom":
        // Extension message
        break;
    }
  }
}
```

### Pattern: Listing and loading sessions

```typescript
async function listAndLoadSession(session: AgentSession) {
  // List sessions for current cwd
  const sessions = await SessionManager.list(process.cwd());

  for (const info of sessions) {
    console.log(`${info.name || info.firstMessage} - ${info.modified}`);
  }

  // Switch to a specific session
  if (sessions.length > 0) {
    await session.switchSession(sessions[0].path);
  }

  // Or start a new session
  await session.newSession();
}
```

---

## 16. StopReason Reference

```typescript
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// "stop"     - Normal completion
// "length"   - Hit maxTokens limit
// "toolUse"  - Model wants to call tools, will continue
// "error"    - API error (check errorMessage)
// "aborted"  - User cancelled via abort()
```

---

## 17. Settings Types

```typescript
export interface CompactionSettings {
  enabled?: boolean;          // default: true
  reserveTokens?: number;     // default: 16384
  keepRecentTokens?: number;  // default: 20000
}

export interface RetrySettings {
  enabled?: boolean;          // default: true
  maxRetries?: number;        // default: 3
  baseDelayMs?: number;       // default: 2000 (exponential backoff)
  maxDelayMs?: number;        // default: 60000
}

export interface ImageSettings {
  autoResize?: boolean;       // default: true (resize to 2000x2000 max)
  blockImages?: boolean;      // default: false
}
```

---

## 18. Summary: Key APIs for AgentManager

| Need | API |
|------|-----|
| Create session | `createAgentSession(options)` |
| In-memory session | `SessionManager.inMemory(cwd)` |
| File-backed session | `SessionManager.create(cwd)` |
| Send prompt | `session.prompt(text, options)` |
| Steer (interrupt) | `session.steer(text)` |
| Follow-up (queue) | `session.followUp(text)` |
| Abort | `session.abort()` |
| Subscribe to events | `session.subscribe(listener)` -> unsubscribe fn |
| Text streaming | `event.type === "message_update"` -> `event.assistantMessageEvent.type === "text_delta"` |
| Thinking streaming | `event.assistantMessageEvent.type === "thinking_delta"` |
| Tool calls | `event.assistantMessageEvent.type === "toolcall_end"` |
| Tool execution | `event.type === "tool_execution_start/update/end"` |
| Get messages | `session.messages` |
| Set model | `session.setModel(model)` |
| Set thinking | `session.setThinkingLevel(level)` |
| Get/set state | `session.isStreaming`, `session.model`, `session.thinkingLevel` |
| List sessions | `SessionManager.list(cwd)` |
| Switch session | `session.switchSession(path)` |
| New session | `session.newSession()` |
| Session stats | `session.getSessionStats()` |
| Custom tools | `customTools` option in `createAgentSession` |
| Dispose | `session.dispose()` |
