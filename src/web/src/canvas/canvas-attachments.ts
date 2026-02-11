import type { Attachment } from "../../../shared/protocol.js";

export interface CanvasAttachment {
  shapeId: string;
  path: string; // relative to canvas/
  type: "text" | "image" | "frame";
  name: string; // display name
  content?: string; // text content (for text shapes)
  imageData?: string; // base64 (for images)
  imageMimeType?: string;
  imageSrc?: string; // URL for preview (for images)
  children?: CanvasAttachment[]; // for frames
}

function formatAttachment(a: CanvasAttachment): string {
  const path = `canvas/${a.path}`;
  if (a.type === "frame") {
    const children = a.children?.map((c) => formatAttachment(c)).join("\n") ?? "";
    return `<folder path="${path}/">\n${children}\n</folder>`;
  }
  if (a.type === "image") {
    return `<image path="${path}">[image attached]</image>`;
  }
  return `<doc path="${path}">\n${a.content ?? ""}\n</doc>`;
}

// Build the message text with <doc> wrappers and extract image attachments
export function buildMessageWithAttachments(
  userMessage: string,
  canvasAttachments: CanvasAttachment[],
): { text: string; imageAttachments: Attachment[] } {
  const rawImages: { data: string; mimeType: string; name: string }[] = [];

  // Collect image attachments (including from frame children)
  function collectImages(attachments: CanvasAttachment[]) {
    for (const a of attachments) {
      if (a.type === "image" && a.imageData) {
        rawImages.push({
          data: a.imageData,
          mimeType: a.imageMimeType ?? "image/png",
          name: a.name,
        });
      }
      if (a.children) collectImages(a.children);
    }
  }
  collectImages(canvasAttachments);

  const imageAttachments: Attachment[] = rawImages.map((img) => ({
    type: "image" as const,
    data: img.data,
    mimeType: img.mimeType,
    name: img.name,
  }));

  if (canvasAttachments.length === 0) {
    return { text: userMessage, imageAttachments };
  }

  const header = `User attached ${canvasAttachments.length} item(s) from canvas:\n\n`;
  const docs = canvasAttachments.map((a) => formatAttachment(a)).join("\n\n");
  const text = `<system>\n${header}${docs}\n</system>\n\n${userMessage}`;
  return { text, imageAttachments };
}

// Deduplicate attachments by path, @ mention takes priority
export function deduplicateAttachments(
  selectionAttachments: CanvasAttachment[],
  mentionAttachments: CanvasAttachment[],
): CanvasAttachment[] {
  const seen = new Map<string, CanvasAttachment>();
  // Mention first (higher priority)
  for (const a of mentionAttachments) {
    seen.set(a.path, a);
  }
  for (const a of selectionAttachments) {
    if (!seen.has(a.path)) {
      seen.set(a.path, a);
    }
  }
  return [...seen.values()];
}
