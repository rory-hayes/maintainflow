import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = l - chroma / 2;
  const channels =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return channels.map((channel) => (channel + offset) * 255);
}

function relativeLuminance(channels: number[]) {
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: number[], background: number[]) {
  const light = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const dark = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (light + 0.05) / (dark + 0.05);
}

describe("light theme status contrast", () => {
  it("keeps destructive text legible on white and its subtle status tint", () => {
    const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
    const root = css.match(/:root\s*{([\s\S]*?)}/)?.[1] ?? "";
    const destructive = root.match(
      /--destructive:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/,
    );
    expect(destructive).not.toBeNull();

    const foreground = hslToRgb(
      Number(destructive?.[1]),
      Number(destructive?.[2]),
      Number(destructive?.[3]),
    );
    const white = [255, 255, 255];
    const tintedBackground = foreground.map(
      (channel, index) => channel * 0.1 + white[index] * 0.9,
    );

    expect(contrastRatio(foreground, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(foreground, tintedBackground)).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
