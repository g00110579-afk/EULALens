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

  // Tile indices address the shared 6 × 4 illustration sheet. Specific topics
  // come first so a qualifier such as "account" can accompany "termination".
  const topics = [
    ["hourglass", 11, /\b(expir\w*|renew\w*|deadlines?|time limits?|statute of limitations|retention)\b/],
    ["wallet", 9, /\b(refunds?|wallets?|billing|purchases?|payments?|subscriptions?|marketplaces?)\b/],
    ["coins", 8, /\b(fees?|costs?|prices?|pricing|tax\w*|royalt\w*|compensation)\b/],
    ["links", 13, /\b(surviv\w*|binding|incorporation|integration|upstream|bundl\w*|transfers?|assignment)\b/],
    ["scissors", 3, /\b(terminat\w*|cancel\w*|discontinu\w*|remov\w*|delet\w*|withdraw\w*|severab\w*|revoc\w*|revok\w*)\b/],
    ["lock", 21, /\b(secur\w*|confidential\w*|passwords?|encryption|access control)\b/],
    ["headset", 22, /\b(support|record\w*|monitoring)\b/],
    ["fingerprint", 4, /\b(priva\w*|personal data|personal information|consent|biometric\w*|tracking|cookies?)\b/],
    ["disks", 18, /\b(data|backups?|copies|storage|telemetry|collection|processing)\b/],
    ["quill", 14, /\b(copyright\w*|proprietary|patents?|intellectual property|trademarks?|brand|fonts?|content|derivative|publication|publishing)\b/],
    ["pencil", 2, /\b(modif\w*|amend\w*|updat\w*|chang\w*|downgrad\w*|revis\w*)\b/],
    ["seal", 1, /\b(warrant\w*|guarantee\w*|certificat\w*|genuine\w*|authentic\w*|endorse\w*)\b/],
    ["parcel", 20, /\b(exports?|imports?|redistribut\w*|distribut\w*|resell\w*|deliver\w*)\b/],
    ["lens", 19, /\b(audit\w*|verif\w*|inspec\w*|accuracy|review|investigat\w*)\b/],
    ["gavel", 6, /\b(arbitrat\w*|disput\w*|class actions?|litigat\w*|courts?|cases|settlement)\b/],
    ["scales", 5, /\b(liabilit\w*|damages?|remed\w*|injunct\w*|relief|laws?|legal|compliance|enforcement)\b/],
    ["shield", 10, /\b(indemn\w*|protect\w*|malware|anti cheat|insurance|safety)\b/],
    ["globe", 7, /\b(venue|jurisdiction\w*|governing|region\w*|international|territor\w*|geographic\w*|language|export\w*|location)\b/],
    ["bubbles", 23, /\b(feedback|communicat\w*|notif\w*|notices?|conduct|disclos\w*|negotiat\w*)\b/],
    ["chip", 17, /\b(devices?|software|hardware|systems?|servers?|internet|engineering|automation|beta|activation|features?|installation)\b/],
    ["badge", 15, /\b(accounts?|eligib\w*|ages?|minors?|identif\w*|identit\w*|authorit\w*|parties|party|users?)\b/],
    ["key", 0, /\b(licen[cs]\w*|sublicen[cs]\w*|permi\w*|access|authoriz\w*|intended use|use rights|multi use)\b/],
    ["warning", 16, /\b(prohibit\w*|restrict\w*|disclaim\w*|waiv\w*|infring\w*|exclu\w*|limited|limitations?|limits?|risks?|for cause|disabled|no)\b/],
    ["book", 12, /\b(agreements?|contracts?|terms?|clauses?|provisions?|policies|policy|guidelines?|scope|obligations?|duties|responsibilit\w*|accept\w*|rules?|workshop)\b/],
  ].map(([key, tile, pattern]) => ({ key, tile, pattern }));
  const artwork = new Map();
  const sheet = new Image();
  sheet.onload = () => dialog.classList.add("art-ready");
  sheet.decoding = "async";
  sheet.fetchPriority = "low";
  sheet.src = "images/category-objects.webp";

  function prepareArtwork(categories) {
    artwork.clear();
    const counts = new Map();
    const leadUses = new Map();
    const uses = key => leadUses.get(key) || 0;
    for (const category of categories) {
      const words = category.name.normalize("NFKC").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || [];
      const name = words.join(" ").toLowerCase();
      const objects = topics.filter(topic => topic.pattern.test(name)).slice(0, 2);
      const initials = words.length > 1
        ? Array.from(words[0])[0] + Array.from(words.at(-1))[0]
        : Array.from(words[0] || "§").slice(0, 2).join("");
      const signature = objects.map(topic => topic.key).join(" ");
      artwork.set(category, { objects, initials: initials.toUpperCase(), signature });
      counts.set(signature, (counts.get(signature) || 0) + 1);
      if (objects.length === 1) {
        const key = objects[0].key;
        leadUses.set(key, uses(key) + 1);
      }
    }
    // Keep related clauses distinguishable. For paired subjects, feature the
    // less-used object. Work from the whole agreement so search never changes a tile.
    for (const art of artwork.values()) {
      art.shared = counts.get(art.signature) > 1;
      if (art.objects.length !== 2) continue;
      const [firstTopic, secondTopic] = art.objects;
      if (uses(secondTopic.key) < uses(firstTopic.key)) art.objects.reverse();
      const lead = art.objects[0].key;
      leadUses.set(lead, uses(lead) + 1);
    }
  }

  function paintArtwork(art, category) {
    const { objects, initials, signature, shared } = artwork.get(category);
    art.dataset.mark = initials;
    art.dataset.topics = signature;
    if (shared && signature) art.classList.add("shared-art");
    if (!objects.length) {
      // Engraving varies even for two unfamiliar titles with the same initials.
      let seed = 0;
      for (const char of category.name) seed = (Math.imul(seed, 31) + char.codePointAt(0)) >>> 0;
      art.style.setProperty("--mark-hue", String(seed % 360));
      art.style.setProperty("--mark-angle", (25 + (seed >>> 8) % 130) + "deg");
    }
    for (const { key, tile } of objects) {
      const object = document.createElement("span");
      object.className = "gallery-object";
      object.dataset.object = key;
      object.style.backgroundPosition = (tile % 6) * 20 + "% " + (Math.floor(tile / 6) * 100 / 3) + "%";
      art.appendChild(object);
    }
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
    dialog.querySelector(".gallery-footer").classList.toggle("all-visible", !query && matches.length <= capacity);
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

  grid.addEventListener("click", event => {
    const choice = event.target.closest("button[data-category-id]");
    if (!choice) return;
    selectCategory(choice.dataset.categoryId);
    dialog.close();
    const title = document.getElementById("cat-title");
    title.focus({ preventScroll: true });
    if (!reducedMotion.matches) title.animate([{ opacity: .4 }, { opacity: 1 }], { duration: 200 });
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
    prepareArtwork(ordered);
    dialog.classList.toggle("short-agreement", ordered.length <= 4);
    if (sheet.complete && !sheet.naturalWidth) sheet.src = "images/category-objects.webp";
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

  document.getElementById("close-gallery").onclick = () => dialog.close();
  const trigger = document.getElementById("view-gallery");
  trigger.hidden = false;
  trigger.onclick = open;
  return { open };
})();
