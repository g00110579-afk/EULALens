// A generated sheet can have different panel boundaries from the story. Crop
// only when visible gutters divide it into exactly as many panels as scenes.
function findComicPanels(image, sceneCount) {
  if (sceneCount < 2 || image.naturalWidth < 32 || image.naturalHeight < 32)
    return [];
  const canvas = document.createElement("canvas");
  const scale = Math.min(
    1,
    512 / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const w = (canvas.width = Math.round(image.naturalWidth * scale));
  const h = (canvas.height = Math.round(image.naturalHeight * scale));
  let pixels;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, w, h);
    pixels = ctx.getImageData(0, 0, w, h).data;
  } catch {
    // An external artwork URL can be displayed even when pixel access is unavailable.
    return [];
  }

  function gutters(vertical, start, end) {
    const length = vertical ? w : h;
    const cuts = [0];
    let first = -1;
    for (let i = 1; i < length; i++) {
      let white = 0;
      for (let j = start; j < end; j++) {
        const p = 4 * (vertical ? j * w + i : i * w + j);
        if (Math.min(pixels[p], pixels[p + 1], pixels[p + 2]) > 211) white++;
      }
      const solid = white >= (end - start) * 0.985;
      if (solid && first < 0) first = i;
      if (!solid && first >= 0) {
        const middle = Math.round((first + i - 1) / 2);
        if (
          middle > length * 0.09 &&
          middle < length * 0.91 &&
          i - first <= length * 0.035
        )
          cuts.push(middle);
        first = -1;
      }
    }
    cuts.push(length);
    return cuts;
  }

  const rows = gutters(false, 0, w);
  const boxes = [];
  for (let i = 1; i < rows.length; i++) {
    const top = rows[i - 1],
      bottom = rows[i];
    if (bottom - top < h * 0.12) return [];
    const columns = gutters(true, top + 2, bottom - 2);
    for (let j = 1; j < columns.length; j++) {
      const left = columns[j - 1],
        right = columns[j];
      if (right - left < w * 0.16) return [];
      boxes.push({
        x: left / w,
        y: top / h,
        width: (right - left) / w,
        height: (bottom - top) / h,
      });
    }
  }
  return boxes.length === sceneCount ? boxes : [];
}

const comicReader = {
  category: null,
  scenario: null,
  index: 0,
  url: "",
  boxes: [],
  measuredCount: -1,
};

function showComicScene() {
  const cat = comicReader.category;
  const scenes = Array.isArray(cat?.comicScenes) ? cat.comicScenes : [];
  const i = comicReader.index;
  const scene = scenes[i] || {};
  const position = document.getElementById("comic-position");
  const label = `Scene ${i + 1} of ${scenes.length}`;
  if (position.textContent !== label && scenes.length)
    position.textContent = label;
  document.getElementById("comic-story").hidden = !scenes.length;
  document.getElementById("comic-prev").disabled = i === 0;
  document.getElementById("comic-next").disabled = i + 1 >= scenes.length;
  document.getElementById("comic-scene-title").textContent = scene.title || "";
  document.getElementById("comic-caption").textContent =
    scene.caption || scene.body || "";
  const dialogue = document.getElementById("comic-dialogue");
  dialogue.replaceChildren();
  const slots =
    scene.slots || scene.overlaySlots || scene.overlay_slots || scene.bubbles;
  for (const slot of Array.isArray(slots) ? slots : []) {
    if (!slot?.text) continue;
    const line = document.createElement("p");
    line.className = ["speech", "thought"].includes(slot.kind)
      ? "comic-line " + slot.kind
      : "comic-line";
    line.textContent = slot.text;
    dialogue.appendChild(line);
  }
  positionComicArtwork();
}

function positionComicArtwork() {
  const image = document.getElementById("cat-comic-img");
  if (
    !image.complete ||
    !image.naturalWidth ||
    image.currentSrc !== comicReader.url
  )
    return;
  const count = comicReader.category?.comicScenes?.length || 0;
  if (comicReader.measuredCount !== count) {
    comicReader.boxes = findComicPanels(image, count);
    comicReader.measuredCount = count;
  }
  const box = comicReader.boxes[comicReader.index] || {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };
  const crop = document.getElementById("comic-crop");
  crop.style.setProperty(
    "--ratio",
    (image.naturalWidth * box.width) / (image.naturalHeight * box.height),
  );
  Object.assign(image.style, {
    width: 100 / box.width + "%",
    height: 100 / box.height + "%",
    left: (-100 * box.x) / box.width + "%",
    top: (-100 * box.y) / box.height + "%",
  });
  image.alt = comicReader.boxes.length
    ? `${comicReader.category.comicTitle || "Comic"}, scene ${comicReader.index + 1}`
    : `${comicReader.category.comicTitle || "Comic"} — full artwork`;
  crop.hidden = false;
  const status = document.getElementById("comic-art-status");
  status.hidden = true;
}

function moveComicScene(step) {
  const next = comicReader.index + step;
  if (next < 0 || next >= (comicReader.category?.comicScenes?.length || 0))
    return;
  comicReader.index = next;
  showComicScene();
  document.getElementById("comic-script").scrollTop = 0;
}

function renderComicForCategory(cat) {
  if (!cat) return;
  renderComicScenarios(cat);
  const title = document.getElementById("cat-comic-title");
  const image = document.getElementById("cat-comic-img");
  const status = document.getElementById("comic-status");
  const reader = document.getElementById("comic-reader");
  const link = document.getElementById("comic-open-link");
  const scenes = Array.isArray(cat.comicScenes) ? cat.comicScenes : [];
  const pending = activeDocument === "live" && cat.comicStatus !== "ready";
  const url = pending
    ? ""
    : EULALensRuntime.safeUrl(cat.comic, window.location.href);
  const changed =
    comicReader.category !== cat ||
    comicReader.scenario !== cat.selectedComicId;
  if (changed) {
    comicReader.index = 0;
    document.getElementById("comic-script").scrollTop = 0;
  }
  comicReader.category = cat;
  comicReader.scenario = cat.selectedComicId;
  comicReader.index = Math.min(
    comicReader.index,
    Math.max(0, scenes.length - 1),
  );
  title.textContent = cat.comicTitle || "Comic";
  reader.hidden = !scenes.length && !url;
  status.hidden = !pending && !reader.hidden;
  status.replaceChildren();
  link.classList.toggle("hidden", !url);
  if (url) link.href = url;
  else link.removeAttribute("href");
  if (!status.hidden) {
    const labels = {
      idle: "Comic queued for generation.",
      queued: "Comic queued…",
      running: "Preparing comic…",
      processing: "Preparing comic…",
      canceling: "Canceling comic…",
      "generating-story": "Generating comic story…",
      "rendering-image": "Rendering comic artwork…",
      reconnecting: "Reconnecting to the existing comic job…",
      canceled: "Comic generation canceled.",
      error: cat.comicError || "Comic generation failed.",
    };
    const message = document.createElement("p");
    message.textContent = pending
      ? labels[cat.comicStatus] || "Preparing comic…"
      : "No comic is available for this category.";
    status.appendChild(message);
    if (pending && ["error", "canceled"].includes(cat.comicStatus)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "pill-button";
      retry.textContent = "Retry";
      retry.onclick = () => retryLiveMedia("comic");
      status.appendChild(retry);
    }
  }
  const artworkStatus = document.getElementById("comic-art-status");
  if (changed || url !== comicReader.url) {
    comicReader.url = url;
    comicReader.measuredCount = -1;
    comicReader.boxes = [];
    document.getElementById("comic-crop").hidden = true;
    artworkStatus.hidden = false;
    artworkStatus.textContent = url
      ? "Loading artwork…"
      : pending
        ? ""
        : "Artwork unavailable.";
    // The API signs this URL and allows the site origin to read the image.
    // Ask for pixel access so uploaded comics can use the same scene framing.
    if (
      url &&
      activeDocument === "live" &&
      new URL(url).origin ===
        new URL(LIVE_API_BASE, window.location.href).origin
    )
      image.crossOrigin = "anonymous";
    else image.removeAttribute("crossorigin");
    image.onload = positionComicArtwork;
    image.onerror = () => {
      if (!url || comicReader.url !== url) return;
      if (image.crossOrigin === "anonymous") {
        image.removeAttribute("crossorigin");
        image.src = url;
        return;
      }
      document.getElementById("comic-crop").hidden = true;
      artworkStatus.hidden = false;
      artworkStatus.textContent = "Artwork could not load.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "quiet-button";
      retry.textContent = "Reload artwork";
      retry.onclick = () => {
        artworkStatus.textContent = "Loading artwork…";
        image.src = url;
      };
      artworkStatus.appendChild(retry);
    };
    if (url) image.src = url;
    else image.removeAttribute("src");
  }
  reader.classList.toggle("text-only", !url && scenes.length > 0);
  showComicScene();
}
