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
  mode: "scenes",
  zoomed: false,
  lettering: null,
};

const wholeComic = { x: 0, y: 0, width: 1, height: 1 };
const comicPositions = new Set([
  "top_left", "top_right", "middle_left", "middle_right", "bottom_left", "bottom_right", "center",
]);
const comicKinds = new Set(["speech", "thought", "caption", "note", "callout", "warning"]);

function comicCopy(scene = {}) {
  const text = (value) => typeof value === "string" ? value.trim() : "";
  const candidates = [scene.slots, scene.overlaySlots, scene.overlay_slots, scene.bubbles];
  const source = candidates.find((value) => Array.isArray(value) && value.length) || [];
  const slots = [];
  for (const slot of source) {
    const words = text(slot?.text) || text(slot?.caption);
    if (!words) continue;
    const position = text(slot.position).toLowerCase().replaceAll("-", "_");
    const kind = text(slot.kind).toLowerCase();
    slots.push({
      text: words,
      kind: comicKinds.has(kind) ? kind : "callout",
      position: comicPositions.has(position) ? position : slots.length ? "bottom_right" : "top_left",
    });
  }
  const caption = text(scene.caption) || text(scene.body) || text(scene.overlayCaption) || text(scene.overlay_caption);
  const dialogue = text(scene.dialogue);
  if (dialogue && !slots.some((slot) => slot.text !== caption) && dialogue !== caption)
    slots.push({ text: dialogue, kind: "speech", position: "top_right" });
  return {
    title: text(scene.overlayTitle) || text(scene.overlay_title) || text(scene.title) || text(scene.scene_title),
    caption, slots, narration: text(scene.narration),
  };
}

// Lettering is HTML over the actual visible bitmap. The same panel coordinates
// are used for the full sheet and for the cropped scene.
function makeComicOverlay(scene, index, bounds, selectable, mapped) {
  const { title, caption, slots, narration } = comicCopy(scene);
  const panel = document.createElement(selectable ? "button" : "div");
  panel.className = "comic-panel-overlay";
  if (!mapped) panel.classList.add("unmapped");
  Object.assign(panel.style, {
    left: bounds.x * 100 + "%", top: bounds.y * 100 + "%",
    width: bounds.width * 100 + "%", height: bounds.height * 100 + "%",
  });
  if (selectable) {
    panel.type = "button";
    panel.dataset.scene = String(index);
    panel.setAttribute("aria-label", "Read scene " + (index + 1) + (title ? ", " + title : ""));
  } else panel.setAttribute("aria-hidden", "true"); // The current scene also has a screen-reader transcript.

  const lettering = document.createElement("span");
  lettering.className = "comic-lettering";
  if (selectable) {
    lettering.id = "comic-panel-text-" + index;
    panel.setAttribute("aria-describedby", lettering.id);
  }
  const positions = document.createElement("span");
  positions.className = "comic-bubbles";
  for (const slot of slots) {
    let group = positions.querySelector('[data-slot="' + slot.position + '"]');
    if (!group) {
      group = document.createElement("span");
      group.className = "comic-slot";
      group.dataset.slot = slot.position;
      positions.appendChild(group);
    }
    const bubble = document.createElement("span");
    bubble.className = "comic-bubble";
    bubble.dataset.kind = slot.kind;
    bubble.textContent = slot.text;
    group.appendChild(bubble);
  }
  lettering.appendChild(positions);
  const captionText = caption || (!slots.length ? narration : "");
  if (captionText && !slots.some((slot) => slot.text === captionText)) {
    const band = document.createElement("span");
    band.className = "comic-panel-caption";
    band.textContent = captionText;
    lettering.appendChild(band);
  }
  panel.appendChild(lettering);
  return panel;
}

function renderComicLettering(scenes) {
  const { mode, index, boxes, lettering } = comicReader;
  if (lettering?.scenes === scenes && lettering.mode === mode && lettering.index === index && lettering.boxes === boxes) return;
  comicReader.lettering = { scenes, mode, index, boxes };
  const layer = document.getElementById("comic-letters");
  const notes = document.getElementById("comic-sheet-text");
  const focused = layer.contains(document.activeElement) || notes.contains(document.activeElement) ? document.activeElement.dataset.scene : undefined;
  const mapped = scenes.length === 1 || boxes.length > 0;
  notes.hidden = mode !== "full" || mapped || !scenes.length;
  if (notes.hidden) notes.open = false;
  if (mode === "full") {
    if (mapped) {
      layer.replaceChildren(...scenes.map((scene, i) => makeComicOverlay(scene, i, boxes[i] || wholeComic, true, true)));
    } else {
      // Some sheets have more or fewer illustrations than their authored scenes.
      // Preserve the original layout and keep all of its script available in reading order.
      layer.replaceChildren();
      const list = notes.querySelector("ol");
      list.replaceChildren(...scenes.map((scene, i) => {
        const { title, caption, slots, narration } = comicCopy(scene);
        const row = document.createElement("li");
        const name = document.createElement("button");
        name.type = "button";
        name.dataset.scene = String(i);
        name.textContent = "Scene " + (i + 1) + (title ? " · " + title : "");
        const copy = document.createElement("p");
        copy.textContent = [...new Set([caption, ...slots.map(slot => slot.text)].filter(Boolean))].join(" ") || narration;
        row.append(name, copy);
        return row;
      }));
    }
  } else {
    layer.replaceChildren(...(scenes[index] ? [makeComicOverlay(scenes[index], index, wholeComic, false, mapped)] : []));
  }
  if (focused !== undefined && mode === "full") {
    const target = Array.from((mapped ? layer : notes).querySelectorAll("button[data-scene]")).find(button => button.dataset.scene === focused);
    target?.focus({ preventScroll: true });
  }
}

function showComicScene() {
  const cat = comicReader.category;
  const scenes = Array.isArray(cat?.comicScenes) ? cat.comicScenes : [];
  const i = comicReader.index;
  const { title, caption, slots, narration } = comicCopy(scenes[i]);
  const position = document.getElementById("comic-position");
  const label = `Scene ${i + 1} of ${scenes.length}`;
  if (position.textContent !== label && scenes.length)
    position.textContent = label;
  const full = comicReader.mode === "full";
  document.getElementById("comic-reader").dataset.view = comicReader.mode;
  document.getElementById("comic-views").hidden = !comicReader.url || !scenes.length;
  document.getElementById("comic-view-scenes").setAttribute("aria-pressed", String(!full));
  document.getElementById("comic-open-link").setAttribute("aria-pressed", String(full));
  document.getElementById("comic-story").hidden = full || !scenes.length;
  document.getElementById("comic-full-tools").hidden = !full || !comicReader.url;
  document.getElementById("comic-sheet-count").textContent = scenes.length ? scenes.length + (scenes.length === 1 ? " scene" : " scenes") : "";
  document.getElementById("comic-prev").disabled = i === 0;
  document.getElementById("comic-next").disabled = i + 1 >= scenes.length;
  document.getElementById("comic-scene-title").textContent = title;
  document.getElementById("comic-caption").textContent = caption || narration;
  const dialogue = document.getElementById("comic-dialogue");
  dialogue.replaceChildren();
  for (const slot of slots) {
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
  const scenes = comicReader.category?.comicScenes || [];
  const count = scenes.length;
  if (comicReader.measuredCount !== count) {
    comicReader.boxes = findComicPanels(image, count);
    comicReader.measuredCount = count;
  }
  const sceneView = comicReader.mode === "scenes";
  const box = (sceneView && comicReader.boxes[comicReader.index]) || wholeComic;
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
  image.alt = sceneView && (comicReader.boxes.length || count === 1)
    ? `${comicReader.category.comicTitle || "Comic"}, scene ${comicReader.index + 1}`
    : `${comicReader.category.comicTitle || "Comic"} — full artwork`;
  crop.hidden = false;
  renderComicLettering(scenes);
  document.getElementById("comic-zoom").disabled = false;
  const status = document.getElementById("comic-art-status");
  status.hidden = true;
  comicPlayback?.sync();
}

function selectComicScene(index) {
  comicReader.index = index;
  showComicScene();
  document.getElementById("comic-script").scrollTop = 0;
}

function moveComicScene(step) {
  const next = comicReader.index + step;
  if (next < 0 || next >= (comicReader.category?.comicScenes?.length || 0))
    return;
  comicPlayback?.seek();
  selectComicScene(next);
}

function setComicZoom(zoomed) {
  comicReader.zoomed = zoomed;
  const art = document.querySelector("#comic-reader .comic-art");
  art.classList.toggle("is-zoomed", zoomed);
  if (zoomed) {
    art.tabIndex = 0;
    art.setAttribute("role", "region");
    art.setAttribute("aria-label", "Zoomed full comic");
    art.focus({ preventScroll: true });
  } else {
    art.removeAttribute("tabindex");
    art.removeAttribute("role");
    art.removeAttribute("aria-label");
  }
  art.scrollTo(0, 0);
  const zoom = document.getElementById("comic-zoom");
  zoom.setAttribute("aria-pressed", String(zoomed));
  zoom.firstElementChild.textContent = zoomed ? "fit_screen" : "zoom_in";
  zoom.lastElementChild.textContent = zoomed ? "Fit page" : "Zoom in";
}

function setComicView(mode, index = comicReader.index) {
  if (comicReader.mode === mode) return;
  comicPlayback?.pause();
  if (index !== comicReader.index) comicPlayback?.seek();
  comicReader.mode = mode;
  setComicZoom(false);
  selectComicScene(index);
}

document.getElementById("comic-view-scenes").onclick = () => setComicView("scenes");
document.getElementById("comic-open-link").onclick = () => setComicView("full");
document.getElementById("comic-zoom").onclick = () => setComicZoom(!comicReader.zoomed);
document.getElementById("comic-reader").addEventListener("click", (event) => {
  const panel = event.target.closest("button[data-scene]");
  if (!panel || comicReader.mode !== "full") return;
  setComicView("scenes", Number(panel.dataset.scene));
  document.getElementById("comic-view-scenes").focus({ preventScroll: true });
});

function renderComicForCategory(cat) {
  if (!cat) return;
  renderComicScenarios(cat);
  const title = document.getElementById("cat-comic-title");
  const image = document.getElementById("cat-comic-img");
  const status = document.getElementById("comic-status");
  const reader = document.getElementById("comic-reader");
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
    setComicZoom(false);
    document.getElementById("comic-sheet-text").open = false;
    document.getElementById("comic-script").scrollTop = 0;
  }
  comicReader.category = cat;
  if (!url) comicReader.mode = "scenes";
  else if (!scenes.length) comicReader.mode = "full";
  comicReader.scenario = cat.selectedComicId;
  comicReader.index = Math.min(
    comicReader.index,
    Math.max(0, scenes.length - 1),
  );
  title.textContent = cat.comicTitle || "Comic";
  const selected = cat.comics?.find(
    (comic) => comic.id === cat.selectedComicId,
  );
  const summary =
    activeDocument === "live"
      ? selected?.storySummary ||
        selected?.visualReadThrough ||
        selected?.storyArc ||
        ""
      : cat.comicSummary || "";
  const description = document.getElementById("comic-summary");
  const toggle = document.getElementById("comic-summary-toggle");
  if (description.textContent !== summary || changed) {
    description.textContent = summary;
    description.hidden = !summary;
  }
  toggle.disabled = !summary;
  toggle.setAttribute("aria-expanded", String(!description.hidden));
  reader.hidden = !scenes.length && !url;
  status.hidden = !pending && !reader.hidden;
  status.replaceChildren();
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
    comicReader.lettering = null;
    document.getElementById("comic-letters").replaceChildren();
    document.getElementById("comic-sheet-text").hidden = true;
    reader.classList.remove("art-failed");
    document.getElementById("comic-zoom").disabled = true;
    document.getElementById("comic-crop").hidden = true;
    artworkStatus.hidden = false;
    artworkStatus.textContent = url
      ? "Loading artwork…"
      : pending
        ? ""
        : "Artwork unavailable.";
    // Even a same-origin sample path can redirect to a separate asset host.
    // Read its pixels when allowed, then fall back to displaying the full sheet.
    if (url) image.crossOrigin = "anonymous";
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
      reader.classList.add("art-failed");
      artworkStatus.hidden = false;
      artworkStatus.textContent = "Artwork could not load.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "quiet-button";
      retry.textContent = "Reload artwork";
      retry.onclick = () => {
        reader.classList.remove("art-failed");
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
  comicPlayback?.sync();
}
