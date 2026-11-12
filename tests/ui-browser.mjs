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
  const fits = async (screen, wholeViewport = false) => {
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      viewportHeight: innerHeight,
      height: document.documentElement.scrollHeight,
    }));
    assert(
      geometry.width <= geometry.viewport + 1,
      `${screen} overflows: ${JSON.stringify(geometry)}`,
    );
    if (wholeViewport)
      assert(
        geometry.height <= geometry.viewportHeight + 1,
        `${screen} needs page scrolling: ${JSON.stringify(geometry)}`,
      );
    layouts.push({ screen, ...geometry });
  };
  // A fast click can occur before the last script arrives on a cold preview.
  const cold = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await cold.route("https://fonts.gstatic.com/**", route => route.abort("failed"));
  let releaseGallery;
  const delayedGallery = new Promise((resolve) => {
    releaseGallery = resolve;
  });
  await cold.route("**/category-gallery.js*", async (route) => {
    await delayedGallery;
    await route.continue();
  });
  await cold.route("**/images/category-objects.webp", route => route.abort("failed"));
  try {
    await cold.goto(base, { waitUntil: "commit" });
    await cold.locator("#upload-dropzone").waitFor();
    for (const width of [390, 1440]) {
      await cold.setViewportSize({ width, height: 844 });
      const firstPaint = await cold.evaluate(() => {
        const icons = [...document.querySelectorAll(".site-header .ui-icon, #dashboard-tab .ui-icon")]
          .filter(icon => icon.getClientRects().length);
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          symbols: icons.map(icon => icon.dataset.icon),
          drawn: icons.every(icon => !icon.textContent.trim() && getComputedStyle(icon, "::before").maskImage.includes("data:image/svg+xml")),
        };
      });
      for (const name of ["document_scanner", "menu_book", "upload_file", "restart_alt", "music_note"]) {
        assert(firstPaint.symbols.includes(name), `Missing home icon: ${name}`);
      }
      assert(firstPaint.drawn, "Home icons must render while web fonts are unavailable");
      assert.equal(firstPaint.overflow, false, "Cold homepage must fit its viewport");
    }
    await cold.getByRole("button", { name: "Zoom", exact: true }).click();
    await cold.getByRole("button", { name: "Spotify", exact: true }).click();
    releaseGallery();
    await cold.locator("#category-gallery[open]").waitFor();
    assert.equal(
      await cold.locator("#gallery-document").textContent(),
      "Spotify TOU",
    );
    const coldArt = cold.locator(".gallery-art").first();
    assert(await coldArt.evaluate(el => Boolean(el.dataset.mark) && getComputedStyle(el, "::before").display !== "none"));
    await cold.locator(".gallery-choice").first().click();
    assert.equal(
      await cold.locator("#tabbtn-video").getAttribute("aria-selected"),
      "true",
    );
    // Titles alone must work, including unfamiliar terms with identical initials.
    await cold.evaluate(() => {
      activeDocument = "live";
      categories = ["Solar Horizon", "Silent Harbor", "個人契約", "Privacy consent"]
        .map((name, i) => ({ id: "title-" + i, name, risk: "low" }));
      categoryGallery.open();
    });
    const titleArt = cold.locator("#category-gallery .gallery-art");
    const marks = await titleArt.evaluateAll(els => els.map(el => ({
      mark: el.dataset.mark, topics: el.dataset.topics, engraving: el.style.cssText,
    })));
    assert.deepEqual(marks.map(m => m.mark), ["SH", "SH", "個人", "PC"]);
    assert.deepEqual(marks.map(m => m.topics), ["", "", "", "fingerprint"]);
    assert.notEqual(marks[0].engraving, marks[1].engraving);
    await cold.locator("#gallery-search").fill("Silent Harbor");
    assert.equal(await titleArt.evaluate(el => el.style.cssText), marks[1].engraving);
  } finally {
    releaseGallery();
    await cold.close();
  }
  // A commit-pinned review page must recover if its primary recording host fails.
  const publicPage = await browser.newPage({ reducedMotion: "reduce" });
  const revision = "a".repeat(40);
  const preview = "https://raw.githack.com/g00110579-afk/EULALens/" + revision + "/";
  const backup = "https://cdn.jsdelivr.net/gh/g00110579-afk/EULALens@" + revision + "/";
  const streamLocal = async (route, prefix) => {
    const response = await route.fetch({ url: base + "/" + route.request().url().slice(prefix.length) });
    await route.fulfill({ response });
  };
  let primaryFailed = false;
  try {
    await publicPage.route(preview + "**", route => {
      if (route.request().url().startsWith(preview + "sample-audio/")) {
        primaryFailed = true;
        return route.abort("failed");
      }
      return streamLocal(route, preview);
    });
    await publicPage.route(backup + "sample-audio/**", route => streamLocal(route, backup));
    await publicPage.goto(preview + "index.html", { waitUntil: "domcontentloaded" });
    assert.equal(await publicPage.getByRole("link", { name: "Upload a EULA" }).getAttribute("href"),
      "https://api.eulalens.stream/review/", "The shared static preview opens the first-party uploader");
    await publicPage.getByRole("button", { name: "Zoom", exact: true }).click();
    await publicPage.getByRole("dialog", { name: "Choose a category" })
      .getByRole("button", { name: "Authority Warranty", exact: true }).click();
    await publicPage.locator("#try-another-btn").click();
    assert.equal(await publicPage.getByRole("link", { name: "Upload a PDF" }).getAttribute("href"),
      "https://api.eulalens.stream/review/");
    await publicPage.keyboard.press("Escape");
    await publicPage.locator("#tabbtn-comic").click();
    await publicPage.locator("#comic-next").click();
    assert.equal(await publicPage.locator("#comic-narration").getAttribute("aria-pressed"), "true");
    await publicPage.locator("#comic-playback").click();
    await publicPage.waitForFunction(mirror => {
      const a = document.getElementById("comic-audio");
      return a.currentSrc.startsWith(mirror) && !a.paused && comicReader.index === 2;
    }, backup, { timeout: 30000 });
    assert(primaryFailed, "The backup must be exercised after a blocked primary recording");
  } finally {
    await publicPage.close();
  }
  const restricted = await browser.newPage();
  try {
    await restricted.goto(base, { waitUntil: "domcontentloaded" });
    await restricted.getByRole("button", { name: "Zoom", exact: true }).click();
    await restricted.locator(".gallery-choice").first().click();
    // Some browsers require a fresh click after the image or audio has loaded.
    await restricted.locator("#comic-audio").evaluate(audio => {
      audio.play = () => {
        delete audio.play;
        return Promise.reject(new DOMException("User activation required", "NotAllowedError"));
      };
    });
    await restricted.locator("#tabbtn-comic").click();
    await restricted.locator("#comic-crop:not([hidden])").waitFor();
    assert.equal(await restricted.locator("#comic-audio").evaluate(audio => audio.hasAttribute("src")), false);
    await restricted.getByRole("button", { name: "Play comic", exact: true }).click();
    await restricted.getByText("Select Play to start narration.", { exact: true }).waitFor();
    assert.equal(await restricted.locator("#comic-reader.is-playing").count(), 0);
    await restricted.getByRole("button", { name: "Play comic", exact: true }).click();
    await restricted.waitForFunction(() => {
      const audio = document.getElementById("comic-audio");
      return !audio.paused && audio.currentTime > 0;
    });
  } finally {
    await restricted.close();
  }
  const catalogue = await browser.newPage({ reducedMotion: "reduce" });
  try {
    await catalogue.goto(base, { waitUntil: "domcontentloaded" });
    await catalogue.getByRole("button", { name: "Zoom", exact: true }).click();
    await catalogue.locator(".gallery-choice").first().click();
    await catalogue.locator("#tabbtn-comic").click();
    const checked = await catalogue.evaluate(async () => {
      const books = [...zoomCategories, ...spotifyCategories, ...steamCategories,
        ...windows11Categories, ...adobeCategories, ...deepfakeCategories];
      const image = document.getElementById("cat-comic-img");
      const crop = document.getElementById("comic-crop");
      // Measure the part of the bitmap actually visible inside the viewport.
      function visibleEdges() {
        const view = crop.getBoundingClientRect(), art = image.getBoundingClientRect();
        return [(view.left - art.left) / art.width, (view.top - art.top) / art.height,
          (view.right - art.left) / art.width, (view.bottom - art.top) / art.height];
      }
      let scenes = 0;
      for (const book of books) {
        renderComicForCategory(book);
        await image.decode();
        positionComicArtwork();
        const frames = book.comicFrames;
        if (frames?.length !== book.comicScenes.length || new Set(frames.map(String)).size !== frames.length)
          throw Error("Missing or duplicate frames in " + book.comic);
        for (const [i, frame] of frames.entries()) {
          selectComicScene(i);
          const edges = visibleEdges();
          if (!edges.every((n, j) => Math.abs(n - frame[j]) < .003) ||
              (frame[2] - frame[0]) * (frame[3] - frame[1]) > .9 ||
              !crop.querySelector(".comic-bubble, .comic-panel-caption"))
            throw Error("Incorrect scene viewport or missing lettering in " + book.comic + ", scene " + (i + 1));
          scenes++;
        }
        setComicView("full");
        if (!visibleEdges().every((n, j) => Math.abs(n - [0, 0, 1, 1][j]) < .003) ||
            crop.querySelectorAll("button[data-scene]").length !== frames.length)
          throw Error("Incorrect full sheet in " + book.comic);
      }
      return { comics: books.length, scenes };
    });
    console.log("Verified sample comic viewports", checked);
  } finally {
    await catalogue.close();
  }
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
    positions.upload < positions.samples,
    "Upload must be above the samples",
  );
  await screenshot("home-desktop");
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#upload-dropzone").focus();
  await page.keyboard.press("Enter");
  assert.equal(
    (await chooser).isMultiple(),
    true,
    "Keyboard activation opens the multi-PDF picker",
  );
  const viewports = [
    [1440, 900],
    [1366, 768],
    [1024, 600],
    [768, 1024],
    [390, 844],
    [320, 568],
    [844, 390],
  ];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await fits("home", true);
    if (width === 390) await screenshot("home-mobile");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const close of ["button", "Escape"]) {
    const sample = page.getByRole("button", { name: "Zoom", exact: true });
    await sample.click();
    assert.equal(await page.locator("#gallery-choices [aria-current]").count(), 0);
    const search = page.getByRole("searchbox");
    await search.click();
    assert.equal(await search.evaluate(el => getComputedStyle(el).boxShadow), "none");
    assert.notEqual(await search.evaluate(el => getComputedStyle(el.parentElement).boxShadow), "none");
    if (close === "button") await page.locator("#close-gallery").click();
    else await page.keyboard.press("Escape");
    assert(await page.locator("#dashboard-tab").isVisible());
    assert(await sample.evaluate(el => document.activeElement === el));
  }
  for (const [name, count] of [
    ["Zoom", 35],
    ["Spotify", 28],
    ["Windows", 25],
    ["Steam", 35],
    ["Adobe", 31],
    ["Deepfake Challenge", 10],
  ]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name, exact: true }).click();
    const gallery = page.locator("#category-gallery");
    assert(await gallery.isVisible());
    assert.equal(await page.locator("#gallery-count").textContent(), count + " categories");
    const choices = gallery.locator(".gallery-choice");
    const expected = await page.locator("#category-select option").allTextContents();
    await page.locator("#category-gallery.art-ready").waitFor();
    if (name === "Zoom") {
      await screenshot("category-gallery-desktop");
      const bounds = await gallery.boundingBox();
      assert.equal(bounds.width, 1440);
      assert.equal(bounds.height, 900);
      assert(await choices.evaluateAll(nodes => {
        const view = document.getElementById("gallery-body").getBoundingClientRect();
        return nodes.filter(node => {
          const box = node.getBoundingClientRect();
          return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
        }).length > 8;
      }), "More than eight complete choices fit on a desktop screen");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById("gallery-choices")).getPropertyValue("--gallery-columns").trim() === "2");
      await screenshot("category-gallery-mobile");
    }
    const seen = await choices.locator(".gallery-caption").allTextContents();
    const designs = new Set();
    const art = await choices.locator(".gallery-art").evaluateAll(nodes => nodes.map(el => ({
      topics: el.dataset.topics, mark: el.dataset.mark, shared: el.classList.contains("shared-art"),
      visible: el.children.length ? getComputedStyle(el.firstElementChild).display !== "none"
        : getComputedStyle(el, "::before").display !== "none",
    })));
    for (const item of art) {
      assert(item.mark && item.visible);
      designs.add(item.topics + (item.shared || !item.topics ? "-" + item.mark : ""));
    }
    assert.deepEqual(seen, expected, "Every category is reachable in the same order as the workspace");
    assert(designs.size >= count * 0.9, name + " should have visually distinguishable category choices");
    if (name === "Zoom") {
      const heading = page.locator("#gallery-heading");
      const headerTop = (await heading.boundingBox()).y;
      const scroller = page.getByRole("region", { name: "Category list" });
      await scroller.hover();
      await page.mouse.wheel(0, 850);
      await page.waitForFunction(() => document.getElementById("gallery-body").scrollTop > 0);
      assert.equal((await heading.boundingBox()).y, headerTop);
      await scroller.focus();
      await page.keyboard.press("End");
      await page.waitForFunction(() => {
        const region = document.getElementById("gallery-body");
        return region.scrollTop + region.clientHeight >= region.scrollHeight - 2;
      });
      await choices.last().click();
      await page.locator("#view-gallery").click();
      assert.equal(await gallery.locator("[aria-current] .gallery-caption").textContent(), expected.at(-1));
      assert(await gallery.locator("[aria-current]").evaluate(node => {
        const view = document.getElementById("gallery-body").getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
      }));
      await gallery.getByRole("searchbox").fill("no matching clause 00000");
      assert(await page.locator("#gallery-empty").isVisible());
      assert.equal(await page.locator("#gallery-count").textContent(), "0 of 35 categories");
      await gallery.getByRole("searchbox").fill("");
      assert.equal(await choices.count(), count);
      assert.equal(await scroller.evaluate(node => node.scrollTop), 0);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    const pick = name === "Zoom" ? 0 : count - 1;
    const chosen = expected[pick];
    await gallery.getByRole("searchbox").fill(chosen);
    await gallery.getByRole("button", {name: chosen, exact: true}).click();
    assert.equal(await page.locator("#cat-title").textContent(), chosen);
    assert(
      await page
        .locator("#cat-title")
        .evaluate((el) => el === document.activeElement),
    );
    const current = page.locator("#category-list [aria-current]");
    assert.equal(await page.locator("#category-select option").count(), count);
    assert.equal(
      await page.locator("#category-list .category-item").count(),
      count,
    );
    assert.equal(
      await page.locator("#category-position").textContent(),
      "Category " + (pick + 1) + " of " + count,
    );
    assert.equal(
      await current.textContent(),
      await page.locator("#cat-title").textContent(),
    );
    const videoTab = page.getByRole("tab", { name: "Video", exact: true });
    assert.equal(await videoTab.getAttribute("aria-selected"), "true");
    if (name === "Zoom") {
      await page.locator("#category-list .category-item").nth(1).click();
      assert.equal(
        await page.locator("#category-position").textContent(),
        "Category 2 of 35",
      );
      assert.equal(
        await current.textContent(),
        await page.locator("#cat-title").textContent(),
      );
      await page
        .getByRole("button", { name: "Previous category", exact: true })
        .click();
      await page.waitForFunction(
        () => document.getElementById("cat-video").readyState >= 2,
      );
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height });
        await fits("video workspace", true);
        const box = await page.locator("#cat-video").boundingBox();
        assert(
          box && box.height >= 120 && box.y + box.height <= height + 1,
          "Player and controls must be in view",
        );
        if (width === 1440) await screenshot("zoom-desktop");
        if (width === 390) await screenshot("zoom-mobile");
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .locator("#video-notes #details-summary")
        .waitFor({ state: "visible" });
      const proportions = await page.locator("#cat-video").evaluate((v) => ({
        frame: v.clientWidth / v.clientHeight,
        video: v.videoWidth / v.videoHeight,
      }));
      assert(
        Math.abs(proportions.frame - proportions.video) < 0.05,
        "Portrait preview should fit the actual video aspect ratio",
      );
    }
    await page.getByRole("tab", { name: "Cue cards", exact: true }).click();
    const card = page.locator(".cue-card").first();
    const beforeFlip = await card.boundingBox();
    await card.focus();
    await page.keyboard.press("Space");
    assert.equal(await card.getAttribute("aria-pressed"), "true");
    assert.equal(
      await card.locator(".cue-back").getAttribute("aria-hidden"),
      "false",
    );
    assert.deepEqual(
      await card.boundingBox(),
      beforeFlip,
      "Flipping a card must keep its footprint",
    );
    await fits("cue cards", true);
    await page.evaluate(() => refreshActiveCategory());
    assert.equal(await card.getAttribute("aria-pressed"), "true");
    assert(await card.evaluate((node) => node === document.activeElement));
    if (name === "Zoom") {
      await page.waitForTimeout(500);
      await screenshot("cue-flipped-mobile");
    }
    await page.keyboard.press("Enter");
    assert.equal(await card.getAttribute("aria-pressed"), "false");
    await page
      .getByRole("button", { name: "Category details", exact: true })
      .click();
    assert(await page.getByRole("region", { name: "Impact", exact: true }).getByRole("list").isVisible());
    assert(await page.getByRole("region", { name: "Lookouts", exact: true }).getByRole("list").isVisible());
    await page.evaluate(() => refreshActiveCategory());
    assert(await page.locator("#cat-impact li").first().isVisible());
    await page.keyboard.press("Escape");
    if (name === "Zoom") {
      await page.getByRole("tab", { name: "Comic", exact: true }).click();
      await page.waitForFunction(
        () => document.getElementById("cat-comic-img").naturalWidth > 0,
      );
      const tabs = await page
        .getByRole("tablist")
        .getByRole("tab")
        .evaluateAll((nodes) => nodes.map((el) => el.id));
      assert.deepEqual(tabs, [
        "tabbtn-video",
        "tabbtn-comic",
        "tabbtn-cards",
        "tabbtn-eula",
      ]);
      const summary = page.locator("#comic-summary");
      assert(await summary.isVisible());
      assert.equal(
        await summary.textContent(),
        await page.evaluate(() => comicReader.category.comicSummary),
      );
      // Observe the decoded signal routed to the audio output. A playing media
      // clock alone also advances for silence.
      await page.evaluate(() => {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        context.createMediaElementSource(document.getElementById("comic-audio")).connect(analyser);
        analyser.connect(context.destination);
        window.narrationLevel = () => {
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          return samples.some(value => Math.abs(value) > 0.02);
        };
      });
      assert.equal(await page.locator("#comic-narration").getAttribute("aria-pressed"), "true");
      const audio = page.locator("#comic-audio");
      assert(await audio.evaluate(a => a.paused && !a.hasAttribute("src")));
      await page.getByRole("button", {name: "Play comic", exact: true}).click();
      await page.waitForFunction(() => window.narrationLevel());
      await page.waitForFunction(() => {
        const a = document.getElementById("comic-audio");
        return !a.paused && a.currentTime > 0 && Number.isFinite(a.duration);
      });
      const track = await page.evaluate(
        () => sampleNarration[comicReader.category.comic],
      );
      assert((await audio.evaluate((a) => a.currentSrc)).endsWith(track.src));
      await page.getByRole("button", {name: "Full comic", exact: true}).click();
      assert.equal(await audio.evaluate(a => a.paused), false);
      const lit = page.locator("#comic-reader.is-playing [aria-current=true]");
      const dim = page.locator("#comic-reader.is-playing [aria-current=false]").first();
      assert.equal(await lit.getAttribute("data-scene"), "0");
      assert.equal(await lit.evaluate(el => getComputedStyle(el, "::after").borderTopStyle), "solid");
      assert.notEqual(await dim.evaluate(el => getComputedStyle(el, "::after").backgroundColor),
        await lit.evaluate(el => getComputedStyle(el, "::after").backgroundColor));
      await audio.evaluate((a, t) => {
        a.currentTime = t - 0.15;
      }, track.starts[1]);
      await page.waitForFunction(() => comicReader.index === 1);
      assert.equal(await lit.getAttribute("data-scene"), "1");
      await page.locator("#comic-view-scenes").click();
      await page.evaluate(() => refreshActiveCategory());
      assert.equal(await audio.evaluate((a) => a.paused), false);
      await page.locator("#comic-playback").click();
      assert(await audio.evaluate((a) => a.paused));
      await page.locator("#comic-playback").click();
      await audio.evaluate((a) => {
        a.currentTime = a.duration - 0.2;
      });
      await page
        .getByRole("button", { name: "Replay comic", exact: true })
        .waitFor();
      await page.locator("#comic-playback").click();
      await page.waitForFunction(
        () =>
          comicReader.index === 0 &&
          !document.getElementById("comic-audio").paused,
      );
      await page.locator("#comic-summary-toggle").click();
      assert(await summary.isHidden());
      await page.locator("#comic-summary-toggle").click();
      await page.locator("#comic-next").click();
      assert(await audio.evaluate((a) => a.paused));
      await page.locator("#comic-prev").click();
      const scenes = await page.evaluate(
        () => comicReader.category.comicScenes,
      );
      assert.equal(
        await page.locator("#comic-position").textContent(),
        "Scene 1 of " + scenes.length,
      );
      assert(await page.locator("#comic-prev").isDisabled());
      const cropCount = await page.evaluate(() => comicReader.boxes.length);
      assert.equal(
        cropCount,
        scenes.length,
        "The Zoom artwork has six distinct bordered panels",
      );
      assert.equal(
        await page.locator("#cat-comic-img").getAttribute("crossorigin"),
        null,
        "Sample frames also work on image hosts that disallow canvas pixel access",
      );
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height });
        await fits("comic", true);
        const art = await page.locator("#comic-crop").boundingBox();
        const letter = await page.locator("#comic-crop .comic-bubble").first().boundingBox();
        const next = await page.locator("#comic-next").boundingBox();
        assert(art.width > 40 && art.height > 40 && letter.width > 5 && letter.height > 5);
        assert(letter.x >= art.x - 1 && letter.y >= art.y - 1 &&
          letter.x + letter.width <= art.x + art.width + 1 &&
          letter.y + letter.height <= art.y + art.height + 1,
          "The authored dialogue must be visible on the cropped artwork");
        assert(
          next.y + next.height <= height && next.x + next.width <= width,
          "Scene controls must fit",
        );
        if (width === 390 || width === 1366) await screenshot("comic-" + width);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", {name: "Full comic", exact: true}).click();
      assert.equal(await page.locator("#comic-open-link").getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("#comic-crop button[data-scene]").count(), scenes.length);
      await screenshot("full-comic-mobile");
      const label = await page.locator(".comic-scene-label").boundingBox();
      const play = await page.locator("#comic-playback").boundingBox();
      assert(label.y + label.height <= play.y + 1, "The mobile scene title has its own row");
      await page.locator("#comic-zoom").click();
      assert.equal(await page.locator("#comic-zoom").getAttribute("aria-pressed"), "true");
      await page.locator("#comic-crop button[data-scene='1']").click();
      assert.equal(await page.locator("#comic-view-scenes").getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("#comic-position").textContent(), "Scene 2 of " + scenes.length);
      await page.locator("#comic-prev").click();
      for (let i = 1; i < scenes.length; i++) {
        await page.locator("#comic-next").click();
        assert.equal(
          await page.locator("#comic-scene-title").textContent(),
          scenes[i].title,
        );
        assert.equal(
          await page.locator("#comic-caption").textContent(),
          scenes[i].caption,
        );
        assert.deepEqual(
          await page.locator("#comic-dialogue p").allTextContents(),
          scenes[i].slots.map((slot) => slot.text),
        );
        assert.deepEqual(
          (await page.locator("#comic-crop .comic-bubble").allTextContents()).sort(),
          scenes[i].slots.map(slot => slot.text).sort(),
        );
      }
      assert(await page.locator("#comic-next").isDisabled());
      await page.evaluate(() => refreshActiveCategory());
      assert.equal(
        await page.locator("#comic-position").textContent(),
        `Scene ${scenes.length} of ${scenes.length}`,
      );
      await page.locator("#comic-prev").click();
      await page
        .getByRole("button", { name: "Next category", exact: true })
        .click();
      assert.equal(
        await page.locator("#tabbtn-comic").getAttribute("aria-selected"),
        "true",
        "Category changes retain the chosen format",
      );
      assert.match(
        await page.locator("#comic-position").textContent(),
        /^Scene 1 of/,
      );
      await page.locator("#comic-crop:not([hidden])").waitFor();
      assert(await audio.evaluate(a => a.paused && !a.hasAttribute("src")));
      await page.getByRole("button", {name: "Play comic", exact: true}).click();
      await page.waitForFunction(() => document.getElementById("comic-progress").value > 0);
      await page
        .locator("#category-select")
        .selectOption({ label: "Arbitration Mandate" });
      await page.waitForFunction(() => comicReader.boxes.length === 5);
      assert(await audio.evaluate(a => a.paused && !a.hasAttribute("src")));
      for (let count = 0; count < 4; count++)
        await page.locator("#comic-next").click();
      assert.equal(
        await page.evaluate(() => comicReader.boxes[4].width),
        1,
        "This five-scene sheet has a full-width final panel",
      );
      await page
        .locator("#category-select")
        .selectOption({ label: "Prohibited High Risk Use" });
      await page.waitForFunction(() => comicReader.measuredCount === 4);
      const frame = () => page.locator("#cat-comic-img").evaluate(el =>
        [el.style.left, el.style.top, el.style.width, el.style.height]);
      const firstFrame = await frame();
      assert.equal(firstFrame[2], "200%", "The first two scenes share the top row");
      await page.locator("#comic-next").click();
      assert.notDeepEqual(await frame(), firstFrame);
      await page.getByRole("button", { name: "Full comic", exact: true }).click();
      assert.deepEqual((await frame()).slice(2), ["100%", "100%"]);
      assert.equal(await page.locator("#comic-letters button[data-scene]").count(), 4);
      const activePanel = page.locator("#comic-letters button[aria-current='true']");
      assert.equal(await activePanel.getAttribute("data-scene"), "1");
      await page.getByRole("button", {name:"Play comic",exact:true}).click();
      await page.waitForFunction(() => window.narrationLevel() && !document.getElementById("comic-audio").paused);
      await page.getByRole("button", {name:"Read aloud",pressed:true,exact:true}).click();
      assert.equal(await page.locator("#comic-narration").getAttribute("aria-pressed"), "false");
      assert(await audio.evaluate(a => a.paused));
      await page.locator("#comic-letters button[data-scene='3']").click();
      assert.equal((await frame())[2], "100%", "The last scene spans the sheet width");
      assert(parseFloat((await frame())[3]) > 200, "Only the last row should be visible");
      assert(await page.locator("#comic-crop .comic-panel-caption").isVisible());
      await page.locator("#comic-prev").click();
      await page.locator("#comic-prev").click();
      await page.locator("#comic-prev").click();
      // A failed asset must leave all dialogue and scene controls usable.
      let attempts = 0;
      await page.route("**/*comic*?test-art-retry", (route) =>
        ++attempts === 1 ? route.abort() : route.continue(),
      );
      await page.evaluate(() => {
        const cat = comicReader.category;
        cat.comic += "?test-art-retry";
        renderComicForCategory(cat);
      });
      await page.getByRole("button", { name: "Reload artwork" }).waitFor();
      await page.locator("#comic-next").click();
      assert.equal(
        await page.locator("#comic-position").textContent(),
        "Scene 2 of 4",
      );
      await page.getByRole("button", { name: "Reload artwork" }).click();
      await page.locator("#comic-crop").waitFor({ state: "visible" });
      assert.equal(attempts, 2);
      await page.evaluate(() => {
        comicReader.category.comic = comicReader.category.comic.split("?")[0];
      });
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
      await fits("original PDF", true);
      await page.locator("#tabbtn-video").focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.locator("#tabbtn-comic").getAttribute("aria-selected"),
        "true",
      );
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("#tabbtn-cards").getAttribute("aria-selected"), "true");
      await page.keyboard.press("End");
      assert.equal(await page.locator("#tabbtn-eula").getAttribute("aria-selected"), "true");
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
        .getByRole("button", { name: "Switch EULA", exact: true })
        .click();
      assert(
        await page
          .getByRole("dialog", { name: "Switch EULA", exact: true })
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
      .getByRole("button", { name: "EULALens home", exact: true })
      .click();
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Generation failure exposes retry without removing the available story.
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  await page.locator(".gallery-choice").first().click();
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
    .locator("#comic-status")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.retryObserved), true);
  await page.evaluate(() => {
    retryLiveMedia = window.originalRetry;
    activeDocument = "zoom";
  });
  await page
    .getByRole("button", { name: "EULALens home", exact: true })
    .click();
  // Dialog selection also exercises replacement of the active document.
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  await page.locator(".gallery-choice").first().click();
  await page
    .getByRole("button", { name: "Switch EULA", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Steam", exact: true })
    .click();
  await page.locator(".gallery-choice").first().click();
  assert.match(
    await page.locator("#doc-analysis-title").textContent(),
    /Steam/,
  );
  assert.equal(await page.locator("#try-another-modal").isVisible(), false);
  await page
    .getByRole("button", { name: "EULALens home", exact: true })
    .click();
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
  await page.locator(".gallery-choice").first().click();
  await page.getByRole("button", { name: "Help", exact: true }).click();
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
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  assert.equal(await page.locator("#category-gallery").isVisible(), true);
  assert.equal(
    await page
      .locator("#gallery-choices")
      .evaluate((el) => el.getAnimations({ subtree: true }).length),
    0,
  );
  await page.locator(".gallery-choice").first().click();
  assert.equal(
    await page.locator("#tabbtn-video").getAttribute("aria-selected"),
    "true",
  );
  await page
    .getByRole("button", { name: "Next category", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Browse categories", exact: true })
    .click();
  assert.equal(
    await page.locator("#gallery-count").textContent(),
    "35 categories",
  );
  assert.equal(
    await page.locator(".gallery-choice[aria-current]").textContent(),
    await page.locator("#cat-title").textContent(),
  );
  await page.keyboard.press("Escape");
  assert(
    await page
      .locator("#view-gallery")
      .evaluate((el) => el === document.activeElement),
  );
  await page.locator("#view-gallery").click();
  await page.getByRole("searchbox").fill("no such category");
  assert(await page.locator("#gallery-empty").isVisible());
  await page.getByRole("searchbox").fill("Recording Consent");
  await page.getByRole("searchbox").press("Enter");
  assert.equal(
    await page.locator("#cat-title").textContent(),
    "Recording Consent",
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
          "upload priority and compact samples",
          "topic illustrations, title marks, scrolling, selected category restoration, search and reduced motion",
          "video-first category context and sidebar",
          "primary controls fit the desktop and phone viewport",
          "unchanged sample content",
          "in-place cue-card flips, keyboard operation and refresh",
          "format retention",
          "category boundaries",
          "comic summaries, explicit playback after category changes, pause and replay",
          "audible default playback, highlighted scene cues and backup delivery after a blocked public recording",
          "full-sheet zoom, scene selection, original lettering and artwork retry",
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
