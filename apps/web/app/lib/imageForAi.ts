/**
 * Downscales an image file to a JPEG small enough to send with an AI job
 * (long side <= 1024px, well under the 1.4 MB base64 API limit).
 */
export async function prepareImageForAi(
  file: File,
  maxSide = 1024,
): Promise<{ mimeType: "image/jpeg"; data: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser");

  // Flatten transparency onto white so diagrams stay legible as JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  for (const quality of [0.85, 0.7, 0.55]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (data.length <= 1_300_000) return { mimeType: "image/jpeg", data };
  }
  throw new Error("Image is too detailed to send — try a smaller image.");
}
