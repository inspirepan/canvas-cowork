import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import {
  Activity,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  FolderOpen,
  ImageIcon,
  Loader2,
  Plus,
  Square,
  X,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Attachment, ModelInfo, ThinkingLevel } from "../../../shared/protocol.js";
import {
  buildMessageWithAttachments,
  type CanvasAttachment,
  deduplicateAttachments,
} from "../canvas/canvas-attachments.js";
import type {
  SessionState,
  UIAssistantMessage,
  UIImageAttachment,
  UIThinkingBlock,
  UIToolCallBlock,
} from "../hooks/use-agent.js";
import type { CanvasContext } from "./AgentPanel.js";
import { DiffView } from "./DiffView";

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
          // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines
          <div key={i} className={className}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

function ToolArgItem({ name, value }: { name: string; value: unknown }) {
  const valueStr = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lines = valueStr.split("\n");
  const isLong = lines.length > 20;
  const [expanded, setExpanded] = useState(!isLong);

  const previewText = isLong ? lines.slice(0, 20).join("\n") : valueStr;

  if (isLong) {
    return (
      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 group text-left"
        >
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          />
          <span className="font-normal text-green-700 dark:text-green-400">{name}</span>
          {!expanded && (
            <span className="text-muted-foreground/40 text-[10px] ml-1">{lines.length} lines</span>
          )}
        </button>
        <div className="ml-1 pl-3 border-l-2 border-border/80">
          <span className="whitespace-pre-wrap break-words block">
            {expanded ? valueStr : previewText}
          </span>
          {!expanded && (
            <span className="text-muted-foreground/50 text-[10px]">...</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-normal text-green-700 dark:text-green-400">{name}:</span>
      <span className="whitespace-pre-wrap break-words pl-3 border-l-2 border-border/80 ml-1">
        {valueStr}
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex tool call rendering with many tool types
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

  const isWrite = block.name === "write" && args && typeof args.content === "string";

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
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");

  const resultImages = block.result?.content?.filter((c) => c.type === "image" && c.data) as
    | Array<{ type: string; data: string; mimeType?: string }>
    | undefined;

  const filePath = args && typeof args.path === "string" ? args.path : undefined;

  const detailsDiff =
    block.result?.details && typeof block.result.details.diff === "string"
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
      return <DiffView oldText="" newText={String(args.content)} fileName={filePath} />;
    }
    return null;
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tool summary with multiple tool-specific branches
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
      return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
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
          <span className="font-mono truncate opacity-70">{filePath}</span>
        )}
        {toolSummary && <span className="font-mono truncate opacity-50">{toolSummary}</span>}
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
                ? `${resultText.slice(0, 2000)}\n... (truncated)`
                : resultText}
            </pre>
          )}
          {resultImages && resultImages.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {resultImages.map((img, i) => (
                <img
                  // biome-ignore lint/suspicious/noArrayIndexKey: result images have no stable ID
                  key={i}
                  src={`data:${img.mimeType || "image/png"};base64,${img.data}`}
                  alt="tool result"
                  className="rounded-md max-h-48 max-w-full object-contain"
                />
              ))}
            </div>
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
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 my-1 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
          {block.thinking}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Copy Button --

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors ${className ?? ""}`}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// -- Message Rendering --

export function stripSystemTags(content: string): string {
  return content.replace(/<system>[\s\S]*?<\/system>/g, "").trim();
}

interface AttachmentMeta {
  type: "text" | "image" | "frame";
  name: string;
  path: string;
}

function parseCanvasAttachmentMeta(content: string): AttachmentMeta[] {
  const match = content.match(/^<system>\n[\s\S]*?\n<\/system>/);
  if (!match) return [];
  const block = match[0];
  const results: AttachmentMeta[] = [];
  const folderPaths: string[] = [];

  for (const m of block.matchAll(/<folder path="canvas\/([^"]+)\/">/g)) {
    folderPaths.push(`${m[1]}/`);
    results.push({ type: "frame", name: m[1].split("/").pop() || m[1], path: m[1] });
  }
  for (const m of block.matchAll(/<image path="canvas\/([^"]+)">/g)) {
    const path = m[1];
    if (folderPaths.some((fp) => path.startsWith(fp))) continue;
    results.push({ type: "image", name: path.split("/").pop() || path, path });
  }
  for (const m of block.matchAll(/<doc path="canvas\/([^"]+)">/g)) {
    const path = m[1];
    if (folderPaths.some((fp) => path.startsWith(fp))) continue;
    results.push({ type: "text", name: path.split("/").pop() || path, path });
  }
  return results;
}

function UserMessageView({ content, images }: { content: string; images?: UIImageAttachment[] }) {
  const displayContent = stripSystemTags(content);
  const attachmentMeta = parseCanvasAttachmentMeta(content);
  const imagesByName = new Map(
    images?.filter((img) => img.name).map((img) => [img.name, img]) ?? [],
  );

  return (
    <div className="flex flex-col items-end px-4 py-2">
      <div className="bg-blue-50 dark:bg-blue-950/30 text-slate-600 dark:text-slate-300 rounded-2xl rounded-br-md px-3.5 py-2 max-w-[85%] space-y-2">
        {attachmentMeta.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {attachmentMeta.map((meta) => {
              if (meta.type === "image") {
                const img = imagesByName.get(meta.name);
                if (img) {
                  return (
                    <div
                      key={meta.path}
                      className="relative overflow-hidden rounded-md border border-blue-200 dark:border-blue-800"
                    >
                      <img
                        src={`data:${img.mimeType};base64,${img.data}`}
                        alt={meta.name}
                        className="h-14 max-w-[100px] object-cover"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 to-transparent px-1 pb-0.5 pt-2">
                        <span className="text-[10px] text-white truncate block leading-tight">
                          {meta.name}
                        </span>
                      </div>
                    </div>
                  );
                }
              }
              return (
                <div
                  key={meta.path}
                  className="flex items-center gap-1 border border-blue-200 dark:border-blue-800 rounded-md px-1.5 py-0.5 text-xs"
                >
                  <CanvasTypeIcon type={meta.type} />
                  <span className="truncate max-w-[100px]">{meta.name}</span>
                </div>
              );
            })}
          </div>
        ) : images && images.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              <img
                // biome-ignore lint/suspicious/noArrayIndexKey: images have no stable ID
                key={i}
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={img.name || "attachment"}
                className="rounded-md max-h-32 max-w-full object-cover"
              />
            ))}
          </div>
        ) : null}
        <p className="prose prose-sm whitespace-pre-wrap">{displayContent}</p>
      </div>
      <CopyButton text={displayContent} className="mt-1 mr-1" />
    </div>
  );
}

function AssistantMessageView({ message }: { message: UIAssistantMessage }) {
  const textContent = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return (
    <div className="px-4 py-2 flex flex-col gap-1">
      {message.content.map((block, i) => {
        const key = block.type === "toolCall" ? block.id : `${block.type}-${i}`;
        switch (block.type) {
          case "thinking":
            return <ThinkingView key={key} block={block} />;
          case "text":
            return (
              <Streamdown
                key={key}
                className="prose prose-sm prose-neutral max-w-none break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0"
                plugins={{ code, math, cjk }}
                isAnimating={!!message.isStreaming}
              >
                {block.text}
              </Streamdown>
            );
          case "toolCall":
            return <ToolCallView key={key} block={block} />;
          default:
            return null;
        }
      })}
      {message.isStreaming && message.content.length === 0 && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
      {message.errorMessage && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive overflow-hidden min-w-0">
          <X className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="break-all min-w-0">{message.errorMessage}</span>
        </div>
      )}
      {textContent && !message.isStreaming && <CopyButton text={textContent} className="mt-0.5" />}
    </div>
  );
}

// -- Input Box --

// Regex for whitespace detection (used in @ mention trigger)
const WHITESPACE_RE = /\s/;

// -- Canvas attachment chip icon --

function CanvasTypeIcon({ type }: { type: "text" | "image" | "frame" }) {
  if (type === "text") return <FileText className="h-3 w-3 text-muted-foreground shrink-0" />;
  if (type === "image") return <ImageIcon className="h-3 w-3 text-muted-foreground shrink-0" />;
  return <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />;
}

const chipStyles = {
  selection: "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800",
  mention: "bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800",
};

function CanvasChip({
  attachment,
  variant,
  onDismiss,
}: {
  attachment: CanvasAttachment;
  variant: "selection" | "mention";
  onDismiss: () => void;
}) {
  const isImage = attachment.type === "image" && attachment.imageSrc;

  if (isImage) {
    return (
      <div className={`relative group overflow-hidden rounded-md border ${chipStyles[variant]}`}>
        <img
          src={attachment.imageSrc}
          alt={attachment.name}
          className="h-14 max-w-[100px] object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 to-transparent px-1 pb-0.5 pt-2">
          <span className="text-[10px] text-white truncate block leading-tight">
            {attachment.name}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="absolute top-0.5 right-0.5 rounded-full bg-black/40 p-0.5 text-white opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1 border rounded-md px-1.5 py-0.5 text-xs ${chipStyles[variant]}`}
    >
      <CanvasTypeIcon type={attachment.type} />
      <span className="truncate max-w-[100px]">{attachment.name}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-muted-foreground hover:text-foreground ml-0.5"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

// -- @ mention state --

interface MentionQuery {
  startIdx: number;
  filter: string;
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
  canvasContext?: CanvasContext;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: InputBox with canvas integration
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
  canvasContext,
}: InputBoxProps) {
  const [text, setText] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Canvas selection chips state
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const prevSelectionRef = useRef<string>("");

  // @ mention state
  const [mentionAttachments, setMentionAttachments] = useState<CanvasAttachment[]>([]);
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  // Reset dismissed IDs when selection changes significantly
  const selectionAttachments = canvasContext?.selectionAttachments ?? [];
  const selectionKey = selectionAttachments
    .map((a) => a.shapeId)
    .sort()
    .join(",");
  if (selectionKey !== prevSelectionRef.current) {
    prevSelectionRef.current = selectionKey;
    setDismissedIds(new Set());
  }

  // Effective selection chips (excluding dismissed)
  const effectiveSelectionChips = selectionAttachments.filter((a) => !dismissedIds.has(a.shapeId));

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const addFiles = async (files: FileList | File[]) => {
    if (!canvasContext) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    for (const file of imageFiles) {
      const raw = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const base64 = raw.split(",")[1];
      const mimeType = file.type || "image/png";
      const attachment = await canvasContext.addImageToCanvas(base64, mimeType);
      if (attachment && !mentionAttachments.some((a) => a.path === attachment.path)) {
        setMentionAttachments((prev) => [...prev, attachment]);
      }
    }
  };

  const dismissSelectionChip = (shapeId: string) => {
    setDismissedIds((prev) => new Set([...prev, shapeId]));
  };

  const removeMentionChip = (shapeId: string) => {
    setMentionAttachments((prev) => prev.filter((a) => a.shapeId !== shapeId));
  };

  // @ mention: get filtered items
  const mentionItems = (() => {
    if (!(mentionQuery && canvasContext)) return [];
    const allItems = canvasContext.getCanvasItems();
    const filter = mentionQuery.filter.toLowerCase();
    if (!filter) return allItems;
    return allItems.filter(
      (item) =>
        item.name.toLowerCase().includes(filter) || item.path.toLowerCase().includes(filter),
    );
  })();

  // @ mention: select item from menu
  const selectMention = (item: { shapeId: string; path: string; type: string; name: string }) => {
    if (!(canvasContext && mentionQuery)) return;
    const resolved = canvasContext.resolveCanvasItem(item.shapeId, item.path);
    if (!resolved) return;

    // Avoid duplicate mentions
    if (!mentionAttachments.some((a) => a.path === resolved.path)) {
      setMentionAttachments((prev) => [...prev, resolved]);
    }

    // Remove the @filter text from input
    const before = text.slice(0, mentionQuery.startIdx);
    const after = text.slice(mentionQuery.startIdx + 1 + mentionQuery.filter.length);
    setText(before + after);

    setMentionQuery(null);
    setMentionIdx(0);
    textareaRef.current?.focus();
  };

  const handleSubmit = () => {
    const trimmed = text.trim();

    // Collect canvas attachments (selection + mentions, deduplicated)
    const canvasAtts = deduplicateAttachments(effectiveSelectionChips, mentionAttachments);

    if (!trimmed && canvasAtts.length === 0) return;

    // Build enriched message with canvas context
    let finalText = trimmed || "(attachment)";
    let allAtts: Attachment[] = [];

    if (canvasAtts.length > 0) {
      const { text: enrichedText, imageAttachments } = buildMessageWithAttachments(
        finalText,
        canvasAtts,
      );
      finalText = enrichedText;
      allAtts = imageAttachments;
    }

    onSubmit(finalText, allAtts.length > 0 ? allAtts : undefined);
    setText("");
    setMentionAttachments([]);
    setMentionQuery(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: @ mention state machine
  const handleTextChange = (newText: string) => {
    setText(newText);

    // @ mention detection
    const cursorPos = textareaRef.current?.selectionStart ?? newText.length;
    if (mentionQuery) {
      // Update or close existing mention query
      if (newText[mentionQuery.startIdx] !== "@" || cursorPos <= mentionQuery.startIdx) {
        setMentionQuery(null);
        setMentionIdx(0);
      } else {
        const filterText = newText.slice(mentionQuery.startIdx + 1, cursorPos);
        if (filterText.includes(" ") || filterText.includes("\n")) {
          setMentionQuery(null);
          setMentionIdx(0);
        } else {
          setMentionQuery({ startIdx: mentionQuery.startIdx, filter: filterText });
          setMentionIdx(0);
        }
      }
    } else if (cursorPos > 0 && newText[cursorPos - 1] === "@") {
      // Trigger @ mention if preceded by whitespace or at start
      if (cursorPos === 1 || WHITESPACE_RE.test(newText[cursorPos - 2])) {
        setMentionQuery({ startIdx: cursorPos - 1, filter: "" });
        setMentionIdx(0);
      }
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyboard navigation with @ mention
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // @ mention keyboard navigation
    if (mentionQuery && mentionItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((prev) => (prev + 1) % mentionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((prev) => (prev - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(mentionItems[mentionIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        setMentionIdx(0);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Paste handler for images (only intercept when clipboard has no text, e.g. screenshots)
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const hasText = Array.from(items).some((item) => item.type === "text/plain");
    if (hasText) return;
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
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
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

  const hasCanvasChips = effectiveSelectionChips.length > 0 || mentionAttachments.length > 0;
  const hasContent = text.trim() || hasCanvasChips;

  return (
    <form
      autoComplete="off"
      onSubmit={(e) => e.preventDefault()}
      className="shrink-0 bg-muted/40 p-3 space-y-2"
    >
      {/* Canvas attachment chips (from selection + @ mentions) */}
      {hasCanvasChips && (
        <div className="flex flex-wrap gap-1.5">
          {effectiveSelectionChips.map((a) => (
            <CanvasChip
              key={`sel-${a.shapeId}`}
              attachment={a}
              variant="selection"
              onDismiss={() => dismissSelectionChip(a.shapeId)}
            />
          ))}
          {mentionAttachments.map((a) => (
            <CanvasChip
              key={`mention-${a.shapeId}`}
              attachment={a}
              variant="mention"
              onDismiss={() => removeMentionChip(a.shapeId)}
            />
          ))}
        </div>
      )}

      {/* Textarea with @ mention popup */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            hasCanvasChips
              ? "Ask about selected items..."
              : "Ask a question... (type @ to reference canvas)"
          }
          rows={1}
          className="w-full resize-none rounded-xl border border-border/40 bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:border-foreground/15 focus:shadow-[0_0_0_3px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/60"
        />

        {/* @ mention autocomplete popup */}
        {mentionQuery && mentionItems.length > 0 && (
          <div className="absolute bottom-full left-0 w-full mb-1 bg-popover border rounded-md shadow-md max-h-48 overflow-y-auto z-50">
            {mentionItems.map((item, i) => (
              <button
                key={item.shapeId}
                type="button"
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                  i === mentionIdx ? "bg-accent" : "hover:bg-accent/50"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectMention(item);
                }}
                onMouseEnter={() => setMentionIdx(i)}
              >
                <CanvasTypeIcon type={item.type} />
                <span className="truncate">{item.name}</span>
                <span className="text-muted-foreground ml-auto truncate text-[10px]">
                  {item.path}
                </span>
              </button>
            ))}
          </div>
        )}
        {mentionQuery && mentionItems.length === 0 && mentionQuery.filter && (
          <div className="absolute bottom-full left-0 w-full mb-1 bg-popover border rounded-md shadow-md z-50 px-3 py-2 text-xs text-muted-foreground">
            No matching canvas items
          </div>
        )}
      </div>

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
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs font-normal text-muted-foreground"
              >
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

        {availableThinkingLevels &&
          availableThinkingLevels.length > 0 &&
          thinkingLevel &&
          onThinkingLevelChange && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs font-normal text-muted-foreground"
                >
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
          disabled={!(isStreaming || hasContent)}
        >
          {isStreaming ? <Square className="h-3 w-3" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </form>
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
  canvasContext?: CanvasContext;
}

export function SessionChat({
  state,
  models,
  onBack,
  onSendPrompt,
  onAbort,
  onModelChange,
  onThinkingLevelChange,
  canvasContext,
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

  // Auto-scroll when user is near bottom and messages change
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
        <span className="text-sm font-medium truncate flex-1">{stripSystemTags(state.info.title)}</span>
        {state.info.isStreaming && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Messages - scrollable */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto min-h-0"
      >
        <div className="py-4">
          {state.messages.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-muted-foreground">Start a conversation</p>
            </div>
          ) : (
            state.messages.map((msg) => {
              const msgKey = `${msg.role}-${msg.timestamp}`;
              if (msg.role === "user") {
                return <UserMessageView key={msgKey} content={msg.content} images={msg.images} />;
              }
              const textBlocks = msg.content.filter((b) => b.type !== "toolCall");
              const toolBlocks = msg.content.filter(
                (b) => b.type === "toolCall",
              ) as UIToolCallBlock[];
              return (
                <Fragment key={msgKey}>
                  {(textBlocks.length > 0 || msg.isStreaming || msg.errorMessage) && (
                    <AssistantMessageView message={{ ...msg, content: textBlocks }} />
                  )}
                  {toolBlocks.map((block) => (
                    <div key={block.id} className="px-4">
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
        canvasContext={canvasContext}
      />
    </div>
  );
}
