/**
 * Real-layout and real-pixel assertions for canvas/WebGL/layout-heavy UI —
 * what jsdom cannot see. Found CMIS's "every map is a blank white canvas".
 *
 *   await serveRecordedFixtures(context, "https://tiles.example.org/**", FIXTURES);
 *   await expectCanvasRenders(page.getByTestId("map"));
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type BrowserContext, type Locator } from "@playwright/test";

/** Serve a third-party host from recorded files so the test is deterministic and offline. */
export async function serveRecordedFixtures(context: BrowserContext, pattern: string, dir: string, rename: Record<string, string> = {}): Promise<void> {
  await context.route(pattern, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = join(dir, rename[path] ?? path);
    if (!existsSync(file)) return route.fulfill({ status: 204 }); // outside the recorded area: empty, not an error
    await route.fulfill({
      status: 200, body: readFileSync(file),
      contentType: file.endsWith(".json") ? "application/json" : "application/octet-stream",
      headers: { "access-control-allow-origin": "*" },
    });
  });
}

/** The element fills its wrapper, its canvas backing store matches, and it draws more than one colour. */
export async function expectCanvasRenders(el: Locator, opts: { minColours?: number; timeout?: number } = {}): Promise<void> {
  await expect(el).toBeVisible();
  const box = await el.evaluate((node) => {
    const own = node.getBoundingClientRect(), wrap = node.parentElement!.getBoundingClientRect();
    const c = node.querySelector("canvas")!;
    return { h: own.height, w: own.width, wh: wrap.height, ww: wrap.width, cw: c.width, ch: c.height, dpr: devicePixelRatio, cs: getComputedStyle(node).position };
  });
  expect(box.h, `element height (computed position: ${box.cs})`).toBeGreaterThan(100);
  expect(Math.abs(box.h - box.wh)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.w - box.ww)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.cw - box.w * box.dpr)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.ch - box.h * box.dpr)).toBeLessThanOrEqual(1);

  // A blank render is a single colour. Needs preserveDrawingBuffer (or read inside the render loop).
  await expect.poll(() => el.evaluate(async (node) => {
    const src = node.querySelector("canvas")!;
    const img = new Image(); img.src = src.toDataURL("image/png"); await img.decode();
    const probe = document.createElement("canvas"); probe.width = 48; probe.height = 48;
    const ctx = probe.getContext("2d")!; ctx.drawImage(img, 0, 0, 48, 48);
    const { data } = ctx.getImageData(0, 0, 48, 48);
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4) colours.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    return colours.size;
  }), { timeout: opts.timeout ?? 45_000, message: "distinct colours on the canvas" }).toBeGreaterThan(opts.minColours ?? 8);
}

/**
 * Reproducing a reported layout bug before planning a fix: measure, then try the
 * candidate fix in-page and re-measure.
 *   const before = await el.evaluate((n) => ({ ...n.getBoundingClientRect().toJSON(), position: getComputedStyle(n).position }));
 *   await el.evaluate((n) => { (n as HTMLElement).style.position = "absolute"; (n as HTMLElement).style.inset = "0"; dispatchEvent(new Event("resize")); });
 */
