import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MAX_DIMENSION = 512;
const JPEG_QUALITY = 0.85;

// Always resize/compress a base64 image before sending to the model.
// Scales down to fit within MAX_DIMENSION and converts to JPEG.
export function resizeImageBase64(
  base64: string,
  mimeType: string,
): Promise<{ data: string; mimeType: string }> {
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
      const result = canvas.toDataURL(outMime, JPEG_QUALITY).split(",")[1];
      resolve({ data: result, mimeType: outMime });
    };
    img.onerror = () => resolve({ data: base64, mimeType });
    img.src = `data:${mimeType};base64,${base64}`;
  });
}
