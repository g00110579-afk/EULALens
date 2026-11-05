/* Small UI-only behaviors. Generation and cancellation stay in the existing runtime. */
function openHelpDialog() {
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

// Native details expose cue-card answers to keyboard and assistive technology.
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
  document.getElementById("cat-video").pause();
  document
    .getElementById("dialog-notes")
    .appendChild(document.getElementById("category-notes"));
  detailDialog.showModal();
}

// Resizing the transcript also changes the image rectangle within the panel.
new ResizeObserver(positionComicOverlay).observe(
  document.querySelector(".comic-overlay-wrap"),
);

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
