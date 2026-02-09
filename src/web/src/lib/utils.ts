import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MAX_DIMENSION = 2048;
const MAX_BASE64_BYTES = 4 * 1024 * 1024; // 4MB (API limit is 5MB)
const JPEG_QUALITY = 0.85;

// Resize a base64 image to fit within MAX_DIMENSION and MAX_BASE64_BYTES.
// Returns { data, mimeType } with the (possibly resized) result.
export function resizeImageBase64(
  base64: string,
  mimeType: string,
): Promise<{ data: string; mimeType: string }> {
  if (base64.length <= MAX_BASE64_BYTES) {
    return Promise.resolve({ data: base64, mimeType });
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);

      const outMime = "image/jpeg";
      let quality = JPEG_QUALITY;
      let result = canvas.toDataURL(outMime, quality).split(",")[1];

      // Reduce quality further if still too large
      while (result.length > MAX_BASE64_BYTES && quality > 0.3) {
        quality -= 0.1;
        result = canvas.toDataURL(outMime, quality).split(",")[1];
      }

      resolve({ data: result, mimeType: outMime });
    };
    img.onerror = () => resolve({ data: base64, mimeType });
    img.src = `data:${mimeType};base64,${base64}`;
  });
}
