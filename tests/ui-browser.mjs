// Real-browser UI regression checks. No model jobs or production API calls.
// Supply EULALENS_PLAYWRIGHT_MODULE when Playwright is installed separately.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
const { chromium } = await import(
  process.env.EULALENS_PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.EULALENS_PLAYWRIGHT_MODULE).href
    : "playwright"
);
const app = express();
app.use(express.static(path.resolve(".")));
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const screenshotDir = process.env.EULALENS_SCREENSHOT_DIR;
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    apiCalls = [],
    layouts = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://api.eulalens.stream/**", (route) => {
    apiCalls.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  const screenshot = async (name) => {
    if (screenshotDir)
      await page.screenshot({
        path: path.join(screenshotDir, name + ".png"),
        fullPage: true,
      });
  };
  const fits = async (screen) => {
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
    }));
    assert(
      geometry.width <= geometry.viewport + 1,
      `${screen} overflows: ${JSON.stringify(geometry)}`,
    );
    layouts.push({ screen, ...geometry });
  };
  await page.goto(base, { waitUntil: "networkidle" });
  assert.equal(await page.locator(".home-content .sample-button").count(), 6);
  assert.equal(
    await page.locator("#help-dialog").isVisible(),
    false,
    "Help must remain optional",
  );
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--glass-blur")
        .trim(),
    ),
    "13px",
  );
  const positions = await page.evaluate(() => ({
    samples: document.querySelector(".sample-section").getBoundingClientRect()
      .top,
    upload: document.querySelector(".upload-section").getBoundingClientRect()
      .top,
  }));
  assert(
    positions.samples < positions.upload,
    "Samples must be the primary starting point",
  );
  await screenshot("home-desktop");
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#upload-dropzone").focus();
  await page.keyboard.press("Enter");
  assert.equal(
    (await chooser).isMultiple(),
    false,
    "Keyboard activation opens the PDF picker",
  );
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await fits("home");
    if (width === 390) await screenshot("home-mobile");
  }
  for (const [name, count] of [
    ["Zoom", 35],
    ["Spotify", 28],
    ["Windows", 25],
    ["Steam", 35],
    ["Adobe", 31],
    ["Deepfake Challenge", 10],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    assert.equal(await page.locator("#category-select option").count(), count);
    assert.equal(
      await page
        .getByRole("tab", { name: "Cue cards", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    const card = page.locator(".cue-card").first();
    await card.locator("summary").click();
    assert(await card.locator(".cue-card-answer").isVisible());
    await card.locator("summary").focus();
    // An asynchronous media refresh must not collapse an answer the user is reading.
    await page.evaluate(() => refreshActiveCategory());
    assert(
      (await page.locator(".cue-card").first().getAttribute("open")) !== null,
    );
    assert.equal(
      await page
        .locator(".cue-card summary")
        .first()
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.getByRole("button", { name: "Impact", exact: true }).click();
    assert.equal(
      await page
        .locator("#insight-accbtn-impact")
        .getAttribute("aria-expanded"),
      "true",
    );
    await page.evaluate(() => refreshActiveCategory());
    assert.equal(
      await page
        .locator("#insight-accbtn-impact")
        .getAttribute("aria-expanded"),
      "true",
    );
    if (name === "Zoom") {
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await fits("cue cards");
        if (width === 1440) await screenshot("zoom-desktop");
        if (width === 390) await screenshot("zoom-mobile");
      }
      await page.getByRole("tab", { name: "Comic", exact: true }).click();
      await page.waitForFunction(
        () => document.getElementById("cat-comic-img").naturalWidth > 0,
      );
      await page.locator("#comic-transcript summary").click();
      assert((await page.locator("#comic-transcript-scenes li").count()) > 0);
      await fits("comic");
      await screenshot("comic-mobile");
      await page
        .getByRole("button", { name: "Next Category", exact: true })
        .click();
      assert.equal(
        await page.locator("#tabbtn-comic").getAttribute("aria-selected"),
        "true",
        "Category changes retain the chosen format",
      );
      await page.getByRole("tab", { name: "Video", exact: true }).click();
      await page.waitForFunction(
        () => document.getElementById("cat-video").readyState >= 1,
      );
      await page.locator("#cat-video").evaluate(async (video) => {
        video.muted = true;
        await video.play();
      });
      await page
        .getByRole("tab", { name: "Original EULA", exact: true })
        .click();
      assert.equal(
        await page.locator("#cat-video").evaluate((video) => video.paused),
        true,
      );
      assert.match(
        await page.locator("#cat-eula-frame").getAttribute("src"),
        /zoom\/eula_zoom\.pdf$/,
      );
      await fits("original PDF");
      await page.locator("#tabbtn-cards").focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.locator("#tabbtn-comic").getAttribute("aria-selected"),
        "true",
      );
      await page.getByRole("button", { name: "Help", exact: true }).click();
      assert(
        await page
          .getByRole("dialog", { name: "Help", exact: true })
          .isVisible(),
      );
      await fits("help");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#help-dialog").isVisible(), false);
      assert.equal(
        await page
          .locator("#help-btn")
          .evaluate((button) => button === document.activeElement),
        true,
      );
      await page
        .getByRole("button", { name: "Try another EULA", exact: true })
        .click();
      assert(
        await page
          .getByRole("dialog", { name: "Try another EULA", exact: true })
          .isVisible(),
      );
      await fits("sample dialog");
      await screenshot("samples-dialog-mobile");
      await page.keyboard.press("Escape");
      const last = await page
        .locator("#category-select option")
        .last()
        .getAttribute("value");
      await page.locator("#category-select").selectOption(last);
      assert(await page.locator("#next-category-btn").isDisabled());
      await page.locator("#category-select").selectOption({ index: 0 });
      assert(await page.locator("#previous-category-btn").isDisabled());
    }
    await page
      .getByRole("button", { name: "Sample EULAs", exact: true })
      .click();
  }
  // Error/retry UI remains clickable even though comic overlays ignore pointer events.
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  await page.getByRole("tab", { name: "Comic", exact: true }).click();
  await page.waitForFunction(
    () => document.getElementById("cat-comic-img").naturalWidth > 0,
  );
  await page.evaluate(() => {
    window.originalRetry = retryLiveMedia;
    window.retryObserved = false;
    retryLiveMedia = () => {
      window.retryObserved = true;
    };
    activeDocument = "live";
    const cat = categories.find(
      (item) =>
        item.id === document.getElementById("active-category").dataset.catId,
    );
    cat.comicStatus = "error";
    cat.comicError = "Fixture render failed";
    renderComicForCategory(cat);
  });
  await page
    .locator("#cat-comic-overlay-grid")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.retryObserved), true);
  await page.evaluate(() => {
    retryLiveMedia = window.originalRetry;
    activeDocument = "zoom";
  });
  await page.getByRole("button", { name: "Sample EULAs", exact: true }).click();
  // Dialog selection also exercises replacement of the active document.
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  await page
    .getByRole("button", { name: "Try another EULA", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Steam", exact: true })
    .click();
  assert.match(
    await page.locator("#doc-analysis-title").textContent(),
    /Steam/,
  );
  assert.equal(await page.locator("#try-another-modal").isVisible(), false);
  await page.getByRole("button", { name: "Sample EULAs", exact: true }).click();
  await page.locator("#learn-more-toggle").click();
  assert.equal(
    await page.locator("#learn-more-toggle").getAttribute("aria-expanded"),
    "true",
  );
  assert(
    await page
      .getByRole("heading", { name: "Abstract", exact: true })
      .isVisible(),
  );
  assert(
    await page
      .getByRole("heading", { name: "People", exact: true })
      .isVisible(),
  );
  assert(await page.getByRole("heading", { name: /Paper/ }).isVisible());
  await fits("research");
  await screenshot("research-mobile");
  await page.locator("#learn-more-toggle").click();
  assert.equal(await page.locator("#learn-more-panel").isVisible(), false);
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  await page.getByRole("button", { name: "Learn more", exact: true }).click();
  assert(await page.locator("#dashboard-tab").isVisible());
  assert(await page.locator("#learn-more-panel").isVisible());
  await page.locator("#learn-more-toggle").click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    ),
    "auto",
  );
  const ids = await page
    .locator("[id]")
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  assert.equal(ids.length, new Set(ids).size, "Element IDs must be unique");
  assert.deepEqual(
    apiCalls,
    [],
    "Sample browsing must not submit production inference requests",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        samples: 6,
        categories: 164,
        layouts,
        coverage: [
          "sample priority",
          "unchanged sample content",
          "cue-card expansion survives asynchronous refresh",
          "format retention",
          "category boundaries",
          "comic and transcript",
          "video playback/pause",
          "original PDF",
          "keyboard tabs",
          "native dialog Escape/focus restoration",
          "research section",
          "reduced motion",
          "no production API calls",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
