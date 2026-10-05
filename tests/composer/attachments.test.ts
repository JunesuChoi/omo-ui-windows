import { describe, expect, it } from "vitest";
import { capImages, isImageFile, messageInput, type ImageInput } from "../../src/ui/composer/attachments";

describe("attachments", () => {
  it("accepts supported image extensions and clipboard MIME types only", () => {
    for (const name of ["a.PNG", "a.jpg", "a.jpeg", "a.gif", "a.webp"]) expect(isImageFile(name)).toBe(true);
    expect(isImageFile("clipboard", "image/png")).toBe(true);
    expect(isImageFile("a.pdf", "application/pdf")).toBe(false);
    expect(isImageFile("a.svg", "image/svg+xml")).toBe(false);
  });
  it("caps the combined draft at ten", () => {
    const image: ImageInput = { type: "image", url: "data:image/png;base64,AA==" };
    expect(capImages(Array(9).fill(image), [image, image])).toHaveLength(10);
  });
  it("omits blank text but preserves text alongside local and pasted images", () => {
    const images: ImageInput[] = [{ type: "localImage", path: "/tmp/a.png" }, { type: "image", url: "data:image/png;base64,AA==" }];
    expect(messageInput(" \n", images)).toEqual(images);
    expect(messageInput("describe", images)).toEqual([{ type: "text", text: "describe", text_elements: [] }, ...images]);
  });
});
