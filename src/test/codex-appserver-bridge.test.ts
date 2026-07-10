import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildImageGenerationPrompt,
  collectImageGenerationItems,
  resolveCodexAppServerTurnModel,
} from "../scripts/codex-appserver-bridge";

test("buildImageGenerationPrompt explicitly invokes Codex image workflow", () => {
  const prompt = buildImageGenerationPrompt({
    messages: [{ role: "user", content: "Create a crisp pixel-art lighthouse at sunset." }],
    requestKind: "images_generations",
    metadata: {
      n: 2,
      size: "1024x1024",
      quality: "high",
      style: "vivid",
      background: "transparent",
    },
  });

  assert.match(prompt, /\$imagegen/);
  assert.match(prompt, /built-in image generation or editing workflow/i);
  assert.match(prompt, /Image count: 2/);
  assert.match(prompt, /Size: 1024x1024/);
  assert.match(prompt, /Quality: high/);
  assert.match(prompt, /Style: vivid/);
  assert.match(prompt, /Background: transparent/);
  assert.match(prompt, /Respond with raw JSON only/i);
  assert.match(prompt, /actual generated image URL/i);
  assert.doesNotMatch(prompt, /example\.com/i);
});

test("resolveCodexAppServerTurnModel avoids codex-latest for image turns", () => {
  assert.equal(
    resolveCodexAppServerTurnModel("codex-latest", "images_generations", "gpt-5.5"),
    "gpt-5.5",
  );
  assert.equal(
    resolveCodexAppServerTurnModel("codex-latest", "chat_completions", "gpt-5.5"),
    "codex-latest",
  );
  assert.equal(
    resolveCodexAppServerTurnModel("gpt-5.5", "images_generations", "gpt-5.5"),
    "gpt-5.5",
  );
});

test("collectImageGenerationItems extracts app-server image call results", () => {
  const imageData = "a".repeat(120);
  const images = collectImageGenerationItems({
    type: "image_generation_call",
    status: "completed",
    result: imageData,
  });

  assert.deepEqual(images, [{ b64_json: imageData }]);
});

test("collectImageGenerationItems ignores placeholder example URLs", () => {
  const images = collectImageGenerationItems({
    data: [
      {
        url: "https://example.com/image.png",
      },
    ],
  });

  assert.deepEqual(images, []);
});

test("collectImageGenerationItems converts Codex local image file URLs to base64", () => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const tempRoot = mkdtempSync(join(tmpdir(), "codex-bridge-image-"));
  const imageDir = join(tempRoot, ".codex", "generated_images", "run");
  const imagePath = join(imageDir, "image.png");
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(imagePath, Buffer.from(pngBase64, "base64"));

  try {
    const images = collectImageGenerationItems({
      data: [
        {
          url: pathToFileURL(imagePath).href,
        },
      ],
    });

    assert.deepEqual(images, [{ b64_json: pngBase64 }]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("collectImageGenerationItems extracts nested inlineData image parts", () => {
  const imageData = "b".repeat(120);
  const images = collectImageGenerationItems({
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: imageData,
              },
            },
          ],
        },
      },
    ],
  });

  assert.deepEqual(images, [{ b64_json: imageData }]);
});
