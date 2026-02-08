import { useState, useRef, useEffect, Fragment } from "react";
import { DiffView } from "./DiffView";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Square,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  Check,
  X,
  Activity,
  Plus,
  ImageIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { cjk } from "@streamdown/cjk";
import type {
  SessionState,
  UIAssistantMessage,
  UIUserMessage,
  UIToolCallBlock,
  UIThinkingBlock,
  UIImageAttachment,
} from "../hooks/use-agent.js";
import type {
  ModelInfo,
  ThinkingLevel,
  Attachment,
} from "../../../shared/protocol.js";

// -- Tool Call Block --

function PiDiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="text-[10px] font-mono rounded-md overflow-x-auto p-2 bg-muted leading-4">
      {lines.map((line, i) => {
        let className = "";
        if (line.startsWith("+")) {
          className = "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30";
        } else if (line.startsWith("-")) {
          className = "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30";
        } else {
          className = "text-muted-foreground";
        }
        return (
          <div key={i} className={className}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

function ToolArgItem({ name, value }: { name: string; value: unknown }) {
  const valueStr =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isLong = valueStr.length > 200;
  const [expanded, setExpanded] = useState(!isLong);

  const displayValue =
    isLong && !expanded ? valueStr.slice(0, 200) + "..." : valueStr;

  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-normal text-green-700 dark:text-green-400">
        {name}:
      </span>
      <span className="whitespace-pre-wrap break-words pl-3 border-l-2 border-border/80 ml-1">
        {displayValue}
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-1 text-muted-foreground hover:text-foreground"
          >
            [{expanded ? "collapse" : "expand"}]
          </button>
        )}
      </span>
    </div>
  );
}

function ToolArgsDisplay({ args }: { args: Record<string, unknown> }) {
  return (
    <div className="flex flex-col gap-2">
      {Object.entries(args).map(([key, value]) => (
        <ToolArgItem key={key} name={key} value={value} />
      ))}
    </div>
  );
}

function ToolCallView({ block }: { block: UIToolCallBlock }) {
  const args =
    block.arguments && typeof block.arguments === "object"
      ? (block.arguments as Record<string, unknown>)
      : null;

  const isEdit =
    block.name === "edit" &&
    args &&
    typeof args.oldText === "string" &&
    typeof args.newText === "string";

  const isWrite =
    block.name === "write" &&
    args &&
    typeof args.content === "string";

  const isDiffTool = !!(isEdit || isWrite);

  const [open, setOpen] = useState(isDiffTool);

  const statusIcon = block.isExecuting ? (
    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
  ) : block.result?.isError ? (
    <X className="h-3.5 w-3.5 shrink-0 text-destructive" />
  ) : block.result ? (
    <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
  ) : null;

  const resultText = block.result?.content
    ?.filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");

  const filePath =
    args && typeof args.path === "string" ? args.path : undefined;

  const detailsDiff =
    block.result?.details &&
    typeof block.result.details.diff === "string"
      ? block.result.details.diff
      : null;

  const renderDiffContent = () => {
    if (isEdit && detailsDiff) {
      return <PiDiffView diff={detailsDiff} />;
    }
    if (isEdit) {
      return (
        <DiffView
          oldText={String(args.oldText)}
          newText={String(args.newText)}
          fileName={filePath}
        />
      );
    }
    if (isWrite) {
      return (
        <DiffView
          oldText=""
          newText={String(args.content)}
          fileName={filePath}
        />
      );
    }
    return null;
  };

  const toolSummary = (() => {
    if (!args) return null;
    if (block.name === "read" && typeof args.path === "string") {
      const fileName = (args.path as string).split("/").pop() || (args.path as string);
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      if (offset != null && limit != null) {
        return `${fileName} ${offset}:${offset + limit}`;
      }
      if (offset != null) return `${fileName} ${offset}:`;
      if (limit != null) return `${fileName} 1:${limit}`;
      return fileName;
    }
    if (block.name === "bash" && typeof args.command === "string") {
      const firstLine = args.command.split("\n")[0].trim();
      return firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine;
    }
    return null;
  })();

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full py-1.5 min-w-0">
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="font-mono shrink-0">{block.name}</span>
        {isDiffTool && filePath && (
          <span className="font-mono truncate opacity-70">
            {filePath}
          </span>
        )}
        {toolSummary && (
          <span className="font-mono truncate opacity-50">
            {toolSummary}
          </span>
        )}
        <span className="flex-1" />
        {statusIcon}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 mt-1 space-y-2">
          {isDiffTool ? (
            renderDiffContent()
          ) : args ? (
            <div className="text-[10px] font-mono bg-muted p-2 rounded-md overflow-x-auto text-muted-foreground">
              <ToolArgsDisplay args={args} />
            </div>
          ) : (
            <pre className="text-[10px] bg-muted p-2 rounded-md overflow-x-auto font-mono text-muted-foreground">
              {JSON.stringify(block.arguments, null, 2)}
            </pre>
          )}
          {resultText && (
            <pre
              className={`text-[10px] p-2 rounded-md overflow-x-auto font-mono max-h-48 overflow-y-auto ${
                block.result?.isError
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {resultText.length > 2000
                ? resultText.slice(0, 2000) + "\n... (truncated)"
                : resultText}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Thinking Block --

function ThinkingView({ block }: { block: UIThinkingBlock }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1">
        {block.isStreaming ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Activity className="h-3 w-3" />
        )}
        <span>{block.isStreaming ? "Thinking..." : "Thought"}</span>
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 my-1 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
          {block.thinking}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Message Rendering --

function UserMessageView({
  content,
  images,
}: {
  content: string;
  images?: UIImageAttachment[];
}) {
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="bg-muted rounded-2xl rounded-br-md px-3.5 py-2 max-w-[85%] space-y-2">
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={img.name || "attachment"}
                className="rounded-md max-h-32 max-w-full object-cover"
              />
            ))}
          </div>
        )}
        <p className="text-sm whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  );
}

function AssistantMessageView({ message }: { message: UIAssistantMessage }) {
  return (
    <div className="px-4 py-2 flex flex-col gap-1">
      {message.content.map((block, i) => {
        switch (block.type) {
          case "thinking":
            return <ThinkingView key={i} block={block} />;
          case "text":
            return (
              <Streamdown
                key={i}
                className="prose prose-sm prose-neutral max-w-none break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0"
                plugins={{ code, math, cjk }}
                isAnimating={!!message.isStreaming}
              >
                {block.text}
              </Streamdown>
            );
          case "toolCall":
            return <ToolCallView key={i} block={block} />;
          default:
            return null;
        }
      })}
      {message.isStreaming && message.content.length === 0 && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}

// -- Input Box --

// -- Attachment chip in input --

interface AttachmentChip {
  id: string;
  name: string;
  data: string;
  mimeType: string;
}

function fileToAttachment(file: File): Promise<AttachmentChip> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        data: base64,
        mimeType: file.type || "image/png",
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export interface InputBoxProps {
  autoFocus?: boolean;
  onSubmit: (text: string, attachments?: Attachment[]) => void;
  onAbort?: () => void;
  isStreaming?: boolean;
  model?: ModelInfo | null;
  thinkingLevel?: ThinkingLevel;
  availableThinkingLevels?: ThinkingLevel[];
  models?: ModelInfo[];
  onModelChange?: (provider: string, modelId: string) => void;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
}

export function InputBox({
  autoFocus,
  onSubmit,
  onAbort,
  isStreaming,
  model,
  thinkingLevel,
  availableThinkingLevels,
  models,
  onModelChange,
  onThinkingLevelChange,
}: InputBoxProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const addFiles = async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) =>
      f.type.startsWith("image/"),
    );
    const chips = await Promise.all(imageFiles.map(fileToAttachment));
    setAttachments((prev) => [...prev, ...chips]);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const atts: Attachment[] | undefined = attachments.length
      ? attachments.map((a) => ({
          type: "image" as const,
          data: a.data,
          mimeType: a.mimeType,
          name: a.name,
        }))
      : undefined;
    onSubmit(trimmed || "(image)", atts);
    setText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Paste handler for images
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
    }
  }, [text]);

  const thinkingLabels: Record<string, string> = {
    off: "Off",
    minimal: "Min",
    low: "Low",
    medium: "Med",
    high: "High",
    xhigh: "Max",
  };

  const hasContent = text.trim() || attachments.length > 0;

  return (
    <div className="shrink-0 bg-muted/40 p-3 space-y-2">
      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-1.5 bg-background border rounded-lg px-2 py-1 text-xs"
            >
              <ImageIcon className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate max-w-[120px]">{a.name}</span>
              <button
                onClick={() => removeAttachment(a.id)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="Ask a question..."
        rows={1}
        className="w-full resize-none rounded-xl border border-border/40 bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:border-foreground/15 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/60"
      />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* + button, model & thinking level selectors, send button */}
      <div className="flex items-center gap-1 text-xs">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => fileInputRef.current?.click()}
        >
          <Plus className="h-4 w-4" />
        </Button>
        {models && models.length > 0 && onModelChange && (
          <Popover open={modelOpen} onOpenChange={setModelOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs font-normal text-muted-foreground">
                {model ? `${model.name}` : "No model"}
                <ChevronDown className="h-3 w-3 ml-1" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start" side="top">
              <Command>
                <CommandInput placeholder="Search models..." className="h-8 text-xs" />
                <CommandList>
                  <CommandEmpty className="py-2 text-center text-xs">No model found.</CommandEmpty>
                  <CommandGroup>
                    {models.map((m) => (
                      <CommandItem
                        key={`${m.provider}/${m.id}`}
                        value={`${m.provider} ${m.name} ${m.id}`}
                        onSelect={() => {
                          onModelChange(m.provider, m.id);
                          setModelOpen(false);
                        }}
                        className="text-xs"
                      >
                        {m.name}
                        {model?.id === m.id && model?.provider === m.provider && (
                          <Check className="h-3 w-3 ml-auto" />
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}

        {availableThinkingLevels && availableThinkingLevels.length > 0 && thinkingLevel && onThinkingLevelChange && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs font-normal text-muted-foreground">
                {thinkingLabels[thinkingLevel] || thinkingLevel}
                <ChevronDown className="h-3 w-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {availableThinkingLevels.map((level) => (
                <DropdownMenuItem
                  key={level}
                  onSelect={() => onThinkingLevelChange(level)}
                  className="text-xs"
                >
                  {thinkingLabels[level] || level}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="flex-1" />
        <Button
          size="icon"
          variant={isStreaming ? "destructive" : "default"}
          className="h-8 w-8 shrink-0 rounded-full"
          onClick={isStreaming ? onAbort : handleSubmit}
          disabled={!isStreaming && !hasContent}
        >
          {isStreaming ? (
            <Square className="h-3 w-3" />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

// -- Main SessionChat Component --

interface SessionChatProps {
  state: SessionState;
  models: ModelInfo[];
  onBack: () => void;
  onSendPrompt: (text: string, attachments?: Attachment[]) => void;
  onAbort: () => void;
  onModelChange: (provider: string, modelId: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
}

export function SessionChat({
  state,
  models,
  onBack,
  onSendPrompt,
  onAbort,
  onModelChange,
  onThinkingLevelChange,
}: SessionChatProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const checkIfNearBottom = () => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const handleScroll = () => {
    isNearBottomRef.current = checkIfNearBottom();
  };

  // Auto-scroll only when user is near bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [state.messages]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header - fixed */}
      <div className="shrink-0 flex items-center gap-2 px-3 pt-3 pb-2 border-b min-h-[44px]">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium truncate flex-1">
          {state.info.title}
        </span>
        {state.info.isStreaming && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Messages - scrollable */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto min-h-0">
        <div className="py-4">
          {state.messages.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                Start a conversation
              </p>
            </div>
          ) : (
            state.messages.map((msg, i) => {
              if (msg.role === "user") {
                return <UserMessageView key={i} content={msg.content} images={msg.images} />;
              }
              const textBlocks = msg.content.filter(b => b.type !== "toolCall");
              const toolBlocks = msg.content.filter(b => b.type === "toolCall") as UIToolCallBlock[];
              return (
                <Fragment key={i}>
                  {(textBlocks.length > 0 || msg.isStreaming) && (
                    <AssistantMessageView message={{ ...msg, content: textBlocks }} />
                  )}
                  {toolBlocks.map((block, j) => (
                    <div key={`tool-${j}`} className="px-4">
                      <ToolCallView block={block} />
                    </div>
                  ))}
                </Fragment>
              );
            })
          )}
        </div>
      </div>

      {/* Input - fixed at bottom */}
      <InputBox
        autoFocus
        onSubmit={(text, attachments) => {
          isNearBottomRef.current = true;
          onSendPrompt(text, attachments);
        }}
        onAbort={onAbort}
        isStreaming={state.info.isStreaming}
        model={state.model}
        thinkingLevel={state.thinkingLevel}
        availableThinkingLevels={state.availableThinkingLevels}
        models={models}
        onModelChange={onModelChange}
        onThinkingLevelChange={onThinkingLevelChange}
      />
    </div>
  );
}
