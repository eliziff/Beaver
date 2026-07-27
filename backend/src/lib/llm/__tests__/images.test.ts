import { describe, expect, it } from "vitest";
import {
  imageValidationError,
  MAX_IMAGE_BYTES,
  toLlmImage,
} from "../images";
import { modelSupportsImageInput } from "../models";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("image attachments", () => {
  it("accepts real image signatures and rejects spoofed or oversized files", () => {
    expect(toLlmImage("scan.png", PNG)).toMatchObject({
      filename: "scan.png",
      mimeType: "image/png",
    });
    expect(imageValidationError("scan.png", Buffer.from("not an image")))
      .toContain("does not match");
    expect(
      imageValidationError(
        "large.png",
        Buffer.alloc(MAX_IMAGE_BYTES + 1),
      ),
    ).toContain("5 MB");
    expect(modelSupportsImageInput("gpt-5.5")).toBe(true);
    expect(modelSupportsImageInput("deepseek-v4-pro")).toBe(false);
    expect(modelSupportsImageInput("meta/muse-spark-1.1")).toBe(true);
    expect(modelSupportsImageInput("future-text-only-model")).toBe(false);
  });
});
