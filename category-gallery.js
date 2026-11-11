const categoryGallery = (() => {
  const dialog = document.getElementById("category-gallery");
  const body = document.getElementById("gallery-body");
  const grid = document.getElementById("gallery-choices");
  const search = document.getElementById("gallery-search");
  const prev = document.getElementById("gallery-prev");
  const next = document.getElementById("gallery-next");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let ordered = [], matches = [];
  let first = 0, capacity = 1;
  let layoutSize = "", selected = "";

  function fallback(art, category) {
    const segment = category.sourceSegments?.[0];
    const quote = typeof segment === "string" ? segment : segment?.text || segment?.excerpt || segment?.source_text;
    const content = document.createElement("span");
    content.className = quote ? "gallery-excerpt" : "material-symbols-outlined gallery-file";
    content.textContent = quote || "description";
    art.replaceChildren(content);
  }

  function paintArtwork(art, category) {
    const sheet = typeof categoryPosterSheets !== "undefined" && categoryPosterSheets[activeDocument];
    const tile = sheet?.tiles?.[category.id];
    const hasStill = Number.isInteger(tile);
    const src = hasStill ? sheet.src : activeDocument === "live" ? safeMediaUrl(category.comic) : category.comic;
    if (art.dataset.source === (src || "")) return;
    art.dataset.source = src || "";
    if (!src) {
      fallback(art, category);
      return;
    }
    const image = document.createElement("img");
    image.alt = "";
    image.draggable = false;
    image.decoding = "async";
    if (hasStill) {
      image.className = "gallery-still";
      Object.assign(image.style, {
        width: sheet.columns * 100 + "%",
        height: sheet.rows * 100 + "%",
        left: -(tile % sheet.columns) * 100 + "%",
        top: -Math.floor(tile / sheet.columns) * 100 + "%",
      });
    } else {
      image.className = "gallery-cover";
    }
    image.addEventListener("error", () => {
      if (art.firstChild === image) fallback(art, category);
    }, { once: true });
    art.replaceChildren(image);
    image.src = src;
  }

  function makeChoice(category) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gallery-choice";
    button.dataset.categoryId = category.id;
    button.setAttribute("aria-label", category.name);
    button.title = category.name;
    if (category.id === selected) button.setAttribute("aria-current", "true");
    const art = document.createElement("span");
    art.className = "gallery-art";
    art.setAttribute("aria-hidden", "true");
    paintArtwork(art, category);
    const label = document.createElement("span");
    label.className = "gallery-caption";
    const name = document.createElement("span");
    name.textContent = category.name;
    label.append(name);
    button.append(art, label);
    return button;
  }

  function render({ anchor, animate = false } = {}) {
    const query = search.value.trim().toLocaleLowerCase();
    matches = ordered.filter(category => category.name.toLocaleLowerCase().includes(query));
    const focused = grid.contains(document.activeElement) ? document.activeElement.dataset.categoryId : null;
    const style = getComputedStyle(grid);
    const columns = Number(style.getPropertyValue("--gallery-columns"));
    const gap = parseFloat(style.rowGap);
    const width = (body.clientWidth - gap * (columns - 1)) / columns;
    const height = width * 9 / 16 + parseFloat(style.getPropertyValue("--gallery-caption-height"));
    const rows = Math.max(1, Math.floor((body.clientHeight + gap) / (height + gap)));
    capacity = columns * rows;
    const wanted = anchor === undefined ? first : matches.findIndex(category => category.id === anchor);
    const index = Math.min(Math.max(0, wanted), Math.max(0, matches.length - 1));
    first = Math.floor(index / capacity) * capacity;
    const choices = matches.slice(first, first + capacity).map(makeChoice);
    grid.replaceChildren(...choices);
    grid.hidden = !choices.length;
    document.getElementById("gallery-empty").hidden = Boolean(choices.length);
    prev.disabled = first === 0;
    next.disabled = first + capacity >= matches.length;
    document.getElementById("gallery-pages").hidden = matches.length <= capacity;
    const range = matches.length > capacity ? (first + 1) + "–" + (first + choices.length) + " of " : "";
    document.getElementById("gallery-position").textContent = range + matches.length + (matches.length === 1 ? " category" : " categories");
    body.scrollTop = 0;
    if (focused) choices.find(button => button.dataset.categoryId === focused)?.focus({ preventScroll: true });
    if (animate && !reducedMotion.matches) {
      choices.forEach((button, i) => button.animate(
        [{ opacity: 0.4, transform: "scale(.975)" }, { opacity: 1, transform: "none" }],
        { duration: 230, delay: Math.min(i * 15, 90), easing: "ease-out", fill: "backwards" },
      ));
    }
  }

  function turn(direction) {
    const offset = first + direction * capacity;
    if (offset < 0 || offset >= matches.length) return;
    first = offset;
    render({ animate: true });
    if ((direction > 0 && next.disabled) || (direction < 0 && prev.disabled)) {
      grid.firstElementChild?.focus({ preventScroll: true });
    }
  }
  prev.onclick = () => turn(-1);
  next.onclick = () => turn(1);
  search.addEventListener("input", () => { first = 0; render(); });
  search.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (matches.length === 1) grid.firstElementChild.click();
    else grid.firstElementChild?.focus();
  });

  function transitionToVideo(art, from) {
    const video = document.getElementById("cat-video");
    if (reducedMotion.matches || currentFormat !== "video" || !art.querySelector("img") || !video.clientWidth || !video.clientHeight) return;
    const to = video.getBoundingClientRect();
    const still = art.cloneNode(true);
    still.classList.add("gallery-transition");
    Object.assign(still.style, { left: to.left + "px", top: to.top + "px", width: to.width + "px", height: to.height + "px" });
    document.body.append(still);
    const animation = still.animate([
      { opacity: 1, transform: "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) scale(" + from.width / to.width + "," + from.height / to.height + ")" },
      { opacity: 0, transform: "none" },
    ], { duration: 280, easing: "cubic-bezier(.2,.78,.2,1)" });
    animation.onfinish = animation.oncancel = () => still.remove();
  }

  grid.addEventListener("click", event => {
    const choice = event.target.closest("button[data-category-id]");
    if (!choice) return;
    const art = choice.querySelector(".gallery-art");
    const from = art.getBoundingClientRect();
    selectCategory(choice.dataset.categoryId);
    dialog.close();
    document.getElementById("cat-title").focus({ preventScroll: true });
    transitionToVideo(art, from);
  });

  new ResizeObserver(() => {
    const size = body.clientWidth + "/" + body.clientHeight;
    if (!dialog.open || size === layoutSize) return;
    layoutSize = size;
    render({ anchor: document.activeElement?.dataset.categoryId || matches[first]?.id });
  }).observe(body);

  function open() {
    if (dialog.open) return;
    ordered = getSortedCategories();
    if (!ordered.length) return;
    selected = document.getElementById("active-category").dataset.catId;
    document.getElementById("gallery-document").textContent = document.getElementById("doc-analysis-title").textContent;
    document.getElementById("gallery-count").textContent = ordered.length + (ordered.length === 1 ? " category" : " categories");
    document.getElementById("cat-video").pause();
    comicPlayback?.pause();
    search.value = "";
    dialog.showModal();
    layoutSize = body.clientWidth + "/" + body.clientHeight;
    render({ anchor: selected, animate: true });
  }

  // A selected upload scenario can finish rendering while its gallery is open.
  function updateArtwork(category) {
    if (!dialog.open || activeDocument !== "live") return;
    const choice = [...grid.children].find(button => button.dataset.categoryId === category.id);
    if (choice) paintArtwork(choice.querySelector(".gallery-art"), category);
  }
  document.getElementById("close-gallery").onclick = () => dialog.close();
  const trigger = document.getElementById("view-gallery");
  trigger.hidden = false;
  trigger.onclick = open;
  return { open, updateArtwork };
})();
