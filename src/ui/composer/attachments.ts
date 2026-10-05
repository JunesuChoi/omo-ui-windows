import type { UserInput } from "../../../shared/protocol";

export type ImageInput = Extract<UserInput, { type: "image" | "localImage" }>;
export const IMAGE_LIMIT = 10;
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
export function isImageFile(name: string, mime = ""): boolean {
  return /^image\/(png|jpeg|gif|webp)$/i.test(mime) || IMAGE_EXTENSIONS.includes(name.split(".").at(-1)?.toLowerCase() ?? "");
}
export function capImages(current: readonly ImageInput[], added: readonly ImageInput[]): ImageInput[] {
  return [...current, ...added].slice(0, IMAGE_LIMIT);
}
export function messageInput(text: string, images: readonly ImageInput[]): UserInput[] {
  return [...(text.trim() === "" ? [] : [{ type: "text" as const, text, text_elements: [] }]), ...images];
}
export function readImage(file: File): Promise<ImageInput> {
  const path = window.omo.imageFilePath(file);
  if (path !== "") return Promise.resolve({ type: "localImage", path });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.onload = () => resolve({ type: "image", url: String(reader.result) });
    reader.readAsDataURL(file);
  });
}
