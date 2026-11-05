// Each latitude holds a ring of real category buttons. On small screens a turn
// brings the next names around the edge instead of shrinking them to fit.
const openCategoryGlobe = (() => {
  const dialog = document.getElementById("category-globe");
  const surface = document.getElementById("globe-surface");
  const viewport = document.getElementById("globe-viewport");
  const search = document.getElementById("globe-search");
  const layout = document.getElementById("globe-layout");
  const rotation = document.getElementById("globe-rotation");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let nodes = [],
    listMode = false,
    offset = 0,
    lastSize = "";

  function ringSizes(total, rows) {
    const weights = Array.from({ length: rows }, (_, row) =>
      Math.sqrt(1 - ((2 * row + 1 - rows) / rows) ** 2),
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    const exact = weights.map((w) => (total * w) / sum);
    const sizes = exact.map((value) => Math.max(1, Math.floor(value)));
    for (
      let left = total - sizes.reduce((a, b) => a + b, 0);
      left > 0;
      left--
    ) {
      const gaps = sizes.map((size, i) => exact[i] - size);
      sizes[gaps.indexOf(Math.max(...gaps))]++;
    }
    return sizes;
  }

  function arrange(motion = "") {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = nodes.filter((button) =>
      button.textContent.toLocaleLowerCase().includes(query),
    );
    const flat = listMode || Boolean(query);
    const focused = surface.contains(document.activeElement)
      ? document.activeElement
      : null;
    const before = new Map();
    if (motion === "left" || motion === "right") {
      for (const button of surface.querySelectorAll("button"))
        before.set(button, button.getBoundingClientRect());
    }
    surface.classList.toggle("as-list", flat);
    rotation.hidden = flat || nodes.length < 3;
    layout.setAttribute("aria-pressed", String(listMode));
    layout.disabled = Boolean(query);
    document.getElementById("globe-count").textContent = query
      ? `${visible.length} of ${nodes.length} categories`
      : `${nodes.length} ${nodes.length === 1 ? "category" : "categories"}`;
    document.getElementById("globe-empty").hidden = visible.length !== 0;
    surface.hidden = visible.length === 0;
    const fragment = document.createDocumentFragment();
    if (flat) {
      fragment.append(...visible);
    } else {
      const diameter = Math.min(
        880,
        viewport.clientWidth - 18,
        Math.max(225, (viewport.clientHeight - 20) * 1.36),
      );
      const compact = diameter < 520;
      const rows = Math.min(
        nodes.length,
        Math.max(
          nodes.length < 5 ? 1 : 3,
          Math.min(
            Math.round(Math.sqrt(nodes.length) * 1.32),
            Math.floor(diameter / (compact ? 60 : 78)),
          ),
        ),
      );
      const sizes = ringSizes(nodes.length, rows);
      surface.style.setProperty("--diameter", diameter + "px");
      surface.style.setProperty(
        "--globe-height",
        Math.max(185, Math.min(diameter * 0.97, viewport.clientHeight - 28)) +
          "px",
      );
      let start = 0,
        onFace = 0;
      // On a return visit, turn the selected category toward the reader.
      const selected = nodes.findIndex((button) =>
        button.hasAttribute("aria-current"),
      );
      if (motion === "enter" && selected >= 0) {
        let ringStart = 0;
        for (const size of sizes) {
          if (selected < ringStart + size) {
            offset = selected - ringStart;
            break;
          }
          ringStart += size;
        }
      }
      sizes.forEach((size, row) => {
        const latitude = (2 * row + 1 - rows) / rows;
        const radius = Math.sqrt(1 - latitude ** 2);
        const capacity = Math.min(
          size,
          Math.max(1, Math.round((diameter * radius) / 119)),
        );
        const band = document.createElement("div");
        band.className = "globe-band";
        band.style.setProperty("--radius", radius);
        band.style.gridTemplateColumns = `repeat(${capacity}, minmax(0, 1fr))`;
        for (let col = 0; col < capacity; col++) {
          const index = (((col + offset) % size) + size) % size;
          const button = nodes[start + index];
          const longitude = (2 * col + 1 - capacity) / capacity;
          button.style.setProperty("--tilt", longitude * latitude * 16 + "deg");
          button.style.setProperty(
            "--curve",
            -latitude * (1 - longitude ** 2) * 12 + "px",
          );
          button.style.setProperty("--depth", 1 - Math.abs(longitude) * 0.13);
          band.append(button);
        }
        fragment.append(band);
        onFace += capacity;
        start += size;
      });
      document.getElementById("globe-turn-hint").textContent =
        onFace < nodes.length ? "Rotate to see more" : "Rotate";
    }
    surface.replaceChildren(fragment);
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    if (!motion || flat || reduced.matches) return;
    const source = document
      .getElementById("globe-document")
      .getBoundingClientRect();
    const globe = surface.getBoundingClientRect();
    surface.querySelectorAll("button").forEach((button, i) => {
      const box = button.getBoundingClientRect(),
        previous = before.get(button);
      const entering = motion === "enter";
      const distance = (motion === "left" ? 1 : -1) * globe.width * 0.13;
      const dx = entering
        ? source.left + Math.min(source.width / 2, 80) - box.left
        : previous
          ? previous.left - box.left
          : distance;
      const dy = entering
        ? source.bottom - box.top
        : previous
          ? previous.top - box.top
          : 0;
      const wraps = Math.abs(dx) > globe.width * 0.48;
      button.animate(
        [
          {
            opacity: entering || !previous || wraps ? 0 : 1,
            transform: `translate(${wraps && !entering ? distance : dx}px, ${dy}px) scale(${entering ? 0.18 : 0.96}) rotateY(${entering ? -65 : 12}deg)`,
          },
          { opacity: 1, transform: getComputedStyle(button).transform },
        ],
        {
          duration: entering ? 580 : 320,
          delay: entering ? Math.min(i * 10, 190) : 0,
          easing: "cubic-bezier(.2,.75,.26,1)",
          fill: "backwards",
        },
      );
    });
  }

  function turn(step) {
    offset += step;
    arrange(step < 0 ? "left" : "right");
  }
  document.getElementById("globe-left").onclick = () => turn(-1);
  document.getElementById("globe-right").onclick = () => turn(1);
  let drag = null,
    suppressedClick = false;
  surface.addEventListener("pointerdown", (event) => {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      surface.classList.contains("as-list")
    )
      return;
    drag = { x: event.clientX, y: event.clientY, id: event.pointerId };
    suppressedClick = false;
  });
  window.addEventListener("pointerup", (event) => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    drag = null;
    if (!dialog.open || Math.abs(dx) < 32 || Math.abs(dx) < Math.abs(dy))
      return;
    suppressedClick = true;
    turn(dx < 0 ? 1 : -1);
  });
  window.addEventListener("pointercancel", () => {
    drag = null;
  });
  search.addEventListener("input", () => {
    viewport.scrollTop = 0;
    arrange();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const options = surface.querySelectorAll("button");
    if (options.length === 1) options[0].click();
    else options[0]?.focus();
  });
  layout.addEventListener("click", () => {
    listMode = !listMode;
    viewport.scrollTop = 0;
    arrange();
  });
  surface.addEventListener("click", (event) => {
    if (event.detail && suppressedClick) {
      suppressedClick = false;
      return;
    }
    const choice = event.target.closest("button[data-category-id]");
    if (!choice) return;
    const from = choice.getBoundingClientRect();
    selectCategory(choice.dataset.categoryId);
    dialog.close();
    const title = document.getElementById("cat-title");
    title.focus({ preventScroll: true });
    if (!reduced.matches) {
      const to = title.getBoundingClientRect();
      title.animate(
        [
          {
            opacity: 0.45,
            transformOrigin: "top left",
            transform: `translate(${from.left - to.left}px,${from.top - to.top}px) scale(.54)`,
          },
          { opacity: 1, transformOrigin: "top left", transform: "none" },
        ],
        { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  });
  document.getElementById("close-globe").onclick = () => dialog.close();
  new ResizeObserver(() => {
    const size = viewport.clientWidth + "/" + viewport.clientHeight;
    if (dialog.open && size !== lastSize) {
      lastSize = size;
      arrange();
    }
  }).observe(viewport);
  const trigger = document.getElementById("view-globe");
  trigger.hidden = false;
  trigger.onclick = () => openCategoryGlobe();
  return function open() {
    const sorted = getSortedCategories();
    if (dialog.open || !sorted.length) return;
    const selected = document.getElementById("active-category").dataset.catId;
    nodes = sorted.map((category) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "globe-choice";
      button.dataset.categoryId = category.id;
      button.textContent = category.name;
      if (category.id === selected) button.setAttribute("aria-current", "true");
      return button;
    });
    document.getElementById("globe-document").textContent =
      document.getElementById("doc-analysis-title").textContent;
    document.getElementById("cat-video").pause();
    search.value = "";
    listMode = false;
    offset = 0;
    suppressedClick = false;
    rotation.hidden = nodes.length < 3;
    dialog.showModal();
    viewport.scrollTop = 0;
    lastSize = viewport.clientWidth + "/" + viewport.clientHeight;
    arrange("enter");
  };
})();
