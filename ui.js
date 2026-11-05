/* Small UI-only behaviors. Generation and cancellation stay in the existing runtime. */
function openHelpDialog() {
  comicPlayback?.pause();
  document.getElementById("cat-video")?.pause();
  document.getElementById("help-dialog").showModal();
}
function closeHelpDialog() {
  document.getElementById("help-dialog").close();
}

for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
}

document.querySelector(".format-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next].focus();
  tabs[next].click();
});

document.getElementById("cat-cards").addEventListener("click", (event) => {
  const card = event.target.closest(".cue-card");
  if (!card) return;
  const answer = card.getAttribute("aria-pressed") !== "true";
  card.setAttribute("aria-pressed", String(answer));
  card.querySelector(".cue-front").setAttribute("aria-hidden", String(answer));
  card.querySelector(".cue-back").setAttribute("aria-hidden", String(!answer));
  card.setAttribute(
    "aria-describedby",
    answer ? card.querySelector(".cue-back").id : "cue-flip-help",
  );
});

// Pause playback when the browser puts the page in the background.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) document.getElementById("cat-video")?.pause();
});

// On portrait screens the space under a landscape video can show the notes
// directly. Move the original nodes so disclosure state and source excerpts
// survive resizing and opening the details dialog from another format.
const portraitReview = matchMedia(
  "(max-width: 800px) and (orientation: portrait)",
);
const detailDialog = document.getElementById("category-details");
function placeCategoryNotes() {
  const slot =
    portraitReview.matches && !detailDialog.open
      ? "video-notes"
      : "dialog-notes";
  document
    .getElementById(slot)
    .appendChild(document.getElementById("category-notes"));
}
portraitReview.addEventListener("change", placeCategoryNotes);
detailDialog.addEventListener("close", placeCategoryNotes);
placeCategoryNotes();

function openCategoryDetails() {
  comicPlayback?.pause();
  document.getElementById("cat-video").pause();
  document
    .getElementById("dialog-notes")
    .appendChild(document.getElementById("category-notes"));
  detailDialog.showModal();
}

const categoryVideo = document.getElementById("cat-video");
categoryVideo.addEventListener("loadedmetadata", () => {
  if (categoryVideo.videoWidth && categoryVideo.videoHeight) {
    categoryVideo.parentElement.style.aspectRatio =
      categoryVideo.videoWidth + " / " + categoryVideo.videoHeight;
  }
});

const categoryList = document.getElementById("category-list");
new ResizeObserver(() => {
  revealCategoryInList(
    categoryList,
    categoryList.querySelector("[aria-current]"),
  );
}).observe(categoryList);
