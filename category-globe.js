// The globe is a transition over categories that have already been extracted.
// Opening or replaying it never submits work to the analysis or media queues.
const openCategoryGlobe = (() => {
  const dialog = document.getElementById("category-globe");
  const canvas = document.getElementById("globe-canvas");
  const count = document.getElementById("globe-count");
  const caption = document.getElementById("globe-category");
  const skip = document.getElementById("skip-globe");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const turn = 2 * Math.PI;
  const duration = 3100;
  let frame = 0;

  const mix = (a, b, t) => a + (b - a) * t;
  function progress(t, start, end) {
    const p = Math.max(0, Math.min(1, (t - start) / (end - start)));
    return p * p * (3 - 2 * p);
  }

  function spherical(latitude, longitude) {
    const ring = Math.cos(latitude);
    return {
      x: ring * Math.sin(longitude),
      y: Math.sin(latitude),
      z: ring * Math.cos(longitude),
    };
  }

  // Sample each meridian and parallel in 3D so both the grid and its labels
  // follow the same rotation into the selected category.
  const grid = [];
  for (let i = 0; i < 12; i++) {
    grid.push(
      Array.from({ length: 25 }, (_, j) =>
        spherical(Math.PI * (j / 24 - 0.5), (turn * i) / 12),
      ),
    );
  }
  for (let i = 1; i < 8; i++) {
    grid.push(
      Array.from({ length: 49 }, (_, j) =>
        spherical(Math.PI * (i / 8 - 0.5), (turn * j) / 48),
      ),
    );
  }

  function drawDocument(ctx, cx, cy, scale, opacity) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "#a3a4b1";
    ctx.fillStyle = "#202127";
    ctx.beginPath();
    ctx.moveTo(-29, -39);
    ctx.lineTo(12, -39);
    ctx.lineTo(29, -22);
    ctx.lineTo(29, 39);
    ctx.lineTo(-29, 39);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(12, -39);
    ctx.lineTo(12, -22);
    ctx.lineTo(29, -22);
    for (let row = 0; row < 5; row++) {
      const y = -13 + row * 9;
      ctx.moveTo(-18, y);
      ctx.lineTo(row === 4 ? 2 : 16, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawLabel(ctx, dot, text, width, height, occupied, alpha) {
    const maxText = Math.min(180, width * 0.38);
    let label = text;
    if (ctx.measureText(label).width > maxText) {
      while (label.length && ctx.measureText(label + "…").width > maxText)
        label = label.slice(0, -1);
      label += "…";
    }
    const w = ctx.measureText(label).width + 14;
    const x = Math.max(
      3,
      Math.min(width - w - 3, dot.x < width / 2 ? dot.x - w - 7 : dot.x + 7),
    );
    const y = dot.y - 12;
    if (
      y < 4 ||
      y + 24 > height - 4 ||
      occupied.some(
        (box) =>
          x < box.x + box.w + 5 &&
          x + w + 5 > box.x &&
          Math.abs(y - box.y) < 27,
      )
    )
      return;
    occupied.push({ x, y, w });
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#16171e";
    ctx.strokeStyle = "#5d5e6b";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, 24, 6);
    else ctx.rect(x, y, w, 24);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#dddde6";
    ctx.fillText(label, x + 7, y + 16);
    ctx.globalAlpha = 1;
  }

  function paint(ctx, nodes, selected, t, still = false) {
    const width = canvas.clientWidth,
      height = canvas.clientHeight;
    if (!width || !height) return;
    const dpi = Math.min(devicePixelRatio || 1, 2);
    const pixelsWide = Math.round(width * dpi),
      pixelsHigh = Math.round(height * dpi);
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
      canvas.width = pixelsWide;
      canvas.height = pixelsHigh;
    }
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const form = progress(t, 0.1, 0.47);
    const focus = still ? 1 : progress(t, 0.65, 0.95);
    const target = nodes[selected].point;
    const yaw =
      Math.atan2(-target.x, target.z) - 2.7 * (1 - progress(t, 0.12, 0.89));
    const pitch = mix(
      -0.24,
      Math.atan2(target.y, Math.hypot(target.x, target.z)),
      focus,
    );
    const sy = Math.sin(yaw),
      cy = Math.cos(yaw),
      sp = Math.sin(pitch),
      cp = Math.cos(pitch);
    const cx = width / 2,
      centerY = height / 2;
    const radius = Math.min(height * 0.39, width * 0.27);
    const zoom = still ? 1 : 1 + 1.6 * focus * focus;
    const paperX = cx - radius * 0.68,
      paperY = centerY + radius * 0.05;
    const project = (p) => {
      const z = -p.x * sy + p.z * cy;
      const depth = p.y * sp + z * cp;
      const scale = (radius * zoom) / (1 - depth * 0.13);
      return {
        x: cx + (p.x * cy + p.z * sy) * scale,
        y: centerY - (p.y * cp - z * sp) * scale,
        z: depth,
      };
    };

    const r = radius * zoom;
    const glow = ctx.createRadialGradient(
      cx - r * 0.35,
      centerY - r * 0.53,
      0,
      cx,
      centerY,
      r,
    );
    glow.addColorStop(0, "rgba(202,207,232,.19)");
    glow.addColorStop(0.75, "rgba(100,105,135,.06)");
    glow.addColorStop(1, "rgba(153,159,187,.14)");
    ctx.globalAlpha = still ? 1 : form * (1 - 0.75 * focus);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, centerY, r, 0, turn);
    ctx.fill();
    for (const line of grid) {
      const projected = line.map(project);
      // Draw the far side faintly, without joins across the silhouettes.
      for (const front of [false, true]) {
        ctx.beginPath();
        for (let j = 1; j < projected.length; j++) {
          const a = projected[j - 1],
            b = projected[j];
          if (a.z + b.z >= 0 !== front) continue;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.strokeStyle = front ? "#8b8f9f" : "#484b5b";
        ctx.lineWidth = front ? 0.75 : 0.45;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    drawDocument(ctx, paperX, paperY, 1 - 0.12 * form, 1 - form);

    const dots = nodes
      .map(({ point, category }, i) => {
        const dot = project(point);
        const travel = progress(
          t,
          0.06 + (i % 6) * 0.025,
          0.4 + (i % 6) * 0.025,
        );
        dot.x = mix(paperX - 15 + (i % 5) * 7, dot.x, travel);
        dot.y =
          mix(paperY - 13 + (i % 5) * 9, dot.y, travel) -
          Math.sin(travel * Math.PI) * radius * 0.26;
        return { ...dot, category, selected: i === selected };
      })
      .sort((a, b) => a.z - b.z);
    const colors = { high: "#e8ada7", medium: "#e1c79b", low: "#b0cfc2" };
    for (const dot of dots) {
      ctx.globalAlpha = dot.selected
        ? 1
        : (0.3 + (dot.z + 1) * 0.33) * (still ? 1 : 1 - 0.85 * focus);
      ctx.fillStyle = dot.selected
        ? "#fafaff"
        : colors[dot.category.risk] || "#d2d3de";
      ctx.beginPath();
      ctx.arc(
        dot.x,
        dot.y,
        dot.selected ? 3.5 + focus * 2.5 : 1.8 + (dot.z + 1) * 0.7,
        0,
        turn,
      );
      ctx.fill();
      if (dot.selected && focus > 0) {
        ctx.strokeStyle = "rgba(237,238,255,.75)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, 6 + 11 * focus, 0, turn);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.font = "12px Inter, system-ui, sans-serif";
    const boxes = [];
    const labelAlpha = still ? 1 : progress(t, 0.14, 0.4) * (1 - focus);
    for (let j = dots.length - 1; j >= 0 && labelAlpha > 0.02; j--) {
      const dot = dots[j];
      if (dot.z > 0.1 && boxes.length < (width < 480 ? 4 : 7)) {
        drawLabel(
          ctx,
          dot,
          dot.category.name,
          width,
          height,
          boxes,
          labelAlpha,
        );
      }
    }
  }

  skip.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    cancelAnimationFrame(frame);
    dialog.style.removeProperty("opacity");
    const panel = document.getElementById("active-category");
    panel.classList.add("category-arrival");
  });
  document
    .getElementById("active-category")
    .addEventListener("animationend", () =>
      document
        .getElementById("active-category")
        .classList.remove("category-arrival"),
    );
  reducedMotion.addEventListener("change", () => {
    if (dialog.open) dialog.close();
  });
  document.addEventListener("visibilitychange", () => {
    if (dialog.open && document.hidden) dialog.close();
  });
  window.addEventListener("pagehide", () => {
    if (dialog.open) dialog.close();
  });

  return function open(replay = false) {
    if (dialog.open || (reducedMotion.matches && !replay)) return;
    const sorted = getSortedCategories();
    const selected = sorted.findIndex(
      (cat) =>
        cat.id === document.getElementById("active-category").dataset.catId,
    );
    const ctx = canvas.getContext("2d");
    if (selected < 0 || !ctx) return;
    const nodes = sorted.map((category, i) => ({
      category,
      point: spherical(
        Math.asin(1 - (2 * (i + 0.5)) / sorted.length),
        i * Math.PI * (3 - Math.sqrt(5)),
      ),
    }));
    const position = `Category ${selected + 1} of ${sorted.length}`;
    count.textContent =
      sorted.length === 1 ? "1 category" : `${sorted.length} categories`;
    caption.textContent = "";
    document.getElementById("globe-document").textContent =
      document.getElementById("doc-analysis-title").textContent;
    document.getElementById("cat-video").pause();
    skip.firstChild.textContent = reducedMotion.matches ? "Close" : "Skip";
    dialog.showModal();
    if (reducedMotion.matches) {
      count.textContent = position;
      caption.textContent = sorted[selected].name;
      paint(ctx, nodes, selected, 1, true);
      return;
    }
    const start = performance.now();
    function draw(now) {
      if (!dialog.open) return;
      const t = Math.min(1, (now - start) / duration);
      paint(ctx, nodes, selected, t);
      if (t >= 0.7 && !caption.textContent) {
        count.textContent = position;
        caption.textContent = sorted[selected].name;
      }
      if (t > 0.94) dialog.style.opacity = String(1 - progress(t, 0.94, 1));
      if (t < 1) frame = requestAnimationFrame(draw);
      else dialog.close();
    }
    draw(start);
  };
})();

const globeButton = document.getElementById("view-globe");
globeButton.hidden = false;
globeButton.addEventListener("click", () => openCategoryGlobe(true));
