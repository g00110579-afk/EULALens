// A sample has one timed audio track. An uploaded comic has one authenticated
// clip per scene; only the current clip and one look-ahead request are needed.
comicPlayback = (() => {
  const audio = document.getElementById("comic-audio");
  const playButton = document.getElementById("comic-playback");
  const voiceButton = document.getElementById("comic-narration");
  const status = document.getElementById("comic-play-status");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const clips = new Map();
  let category, scenario, sample;
  let active = false,
    pendingStart = false,
    preferManual = false;
  let narrated = false,
    finished = false,
    run = null;
  let timer, deadline, remaining;
  let loadedSample, loadedIndex, objectURL;

  function message(text = "") {
    status.textContent = text;
    status.hidden = !text;
  }

  function controls() {
    const label = run ? "Pause" : finished ? "Replay" : "Play";
    document.getElementById("comic-play-label").textContent = label;
    document.getElementById("comic-play-icon").textContent = run
      ? "pause"
      : finished
        ? "replay"
        : "play_arrow";
    playButton.setAttribute("aria-label", label + " comic");
    playButton.title = label + " comic";
    playButton.disabled = !category?.comicScenes?.length;
    voiceButton.setAttribute("aria-pressed", String(narrated));
    voiceButton.disabled =
      !(
        sample ||
        (activeDocument === "live" && category?.comicJobId && scenario)
      ) || playButton.disabled;
    document
      .getElementById("comic-script")
      .setAttribute("aria-live", run ? "off" : "polite");
    document
      .getElementById("comic-position")
      .setAttribute("aria-live", run ? "off" : "polite");
  }

  function visible() {
    return (
      active &&
      !document.hidden &&
      !document.querySelector("dialog[open]") &&
      !document.getElementById("documents-tab").classList.contains("hidden")
    );
  }

  function releaseAudio() {
    loadedSample = undefined;
    loadedIndex = undefined;
    if (audio.hasAttribute("src")) {
      audio.removeAttribute("src");
      audio.load();
    }
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = undefined;
  }

  function pause() {
    pendingStart = false;
    run?.abort();
    run = null;
    clips.clear();
    if (timer !== undefined) {
      remaining = Math.max(0, deadline - performance.now());
      clearTimeout(timer);
      timer = undefined;
    }
    audio.pause();
    message();
    controls();
  }

  function seek() {
    pause();
    releaseAudio();
    remaining = undefined;
    finished = false;
    controls();
  }

  function sync() {
    const next = comicReader.category;
    if (next !== category || (scenario && scenario !== comicReader.scenario)) {
      // A different story must never inherit a pending request or playing audio.
      const opening = pendingStart && !category;
      seek();
      pendingStart = opening;
      narrated = false;
    }
    category = next;
    scenario = comicReader.scenario;
    sample =
      activeDocument !== "live" &&
      category &&
      typeof sampleNarration !== "undefined"
        ? sampleNarration[category.comic]
        : null;
    if (
      sample &&
      (!Array.isArray(sample.starts) ||
        sample.starts.length !== category.comicScenes.length)
    )
      sample = null;
    controls();
    if (
      pendingStart &&
      visible() &&
      category?.comicScenes?.length > 1 &&
      (activeDocument !== "live" || category.comicStatus === "ready") &&
      (!comicReader.url || !document.getElementById("comic-crop").hidden)
    )
      start();
  }

  function readingTime() {
    const elements = ["comic-scene-title", "comic-caption", "comic-dialogue"];
    if (
      comicReader.index === 0 &&
      !document.getElementById("comic-summary").hidden
    )
      elements.push("comic-summary");
    const text = elements
      .map((id) => document.getElementById(id).textContent)
      .join(" ");
    const words = text.trim().split(/\s+/).length;
    return Math.max(5500, 1600 + words * 330);
  }

  function finish() {
    pause();
    finished = true;
    remaining = undefined;
    controls();
  }

  function advance() {
    if (!visible()) {
      pause();
      return;
    }
    if (comicReader.index + 1 >= category.comicScenes.length) {
      finish();
      return;
    }
    selectComicScene(comicReader.index + 1);
    remaining = undefined;
    void playScene(run);
  }

  function requestClip(index, signal) {
    if (clips.has(index)) return clips.get(index);
    const path =
      jobPath("comic", category.comicJobId) +
      "/scenarios/" +
      encodeURIComponent(scenario) +
      "/narration/" +
      index;
    const promise = liveApi.audio(path, { signal });
    clips.set(index, promise);
    // A failed look-ahead can be requested again when the reader reaches it.
    promise.catch(() => {
      if (clips.get(index) === promise) clips.delete(index);
    });
    return promise;
  }

  function failed(error, current) {
    if (run !== current) return;
    pause();
    if (error?.name === "NotAllowedError") {
      message("Press Play to start narration.");
    } else {
      releaseAudio();
      narrated = false;
      controls();
      message(
        "Narration couldn’t play. Select Narration to retry or Play to continue without audio.",
      );
    }
  }

  async function playScene(current) {
    if (!narrated) {
      const delay = remaining ?? readingTime();
      deadline = performance.now() + delay;
      timer = setTimeout(() => {
        timer = undefined;
        remaining = undefined;
        if (run === current) advance();
      }, delay);
      return;
    }
    const index = comicReader.index;
    try {
      if (sample) {
        if (loadedSample !== sample) {
          releaseAudio();
          const url = EULALensRuntime.safeUrl(sample.src, window.location.href);
          if (!url) throw new Error("Missing sample audio");
          loadedSample = sample;
          audio.src = url;
          audio.currentTime = sample.starts[index];
        }
      } else if (loadedIndex !== index) {
        message("Preparing narration…");
        const blob = await requestClip(index, current.signal);
        if (run !== current) return;
        clips.delete(index);
        releaseAudio();
        objectURL = URL.createObjectURL(blob);
        loadedIndex = index;
        audio.src = objectURL;
      }
      await audio.play();
      if (run !== current) return;
      message();
      if (!sample && index + 1 < category.comicScenes.length)
        requestClip(index + 1, current.signal);
    } catch (error) {
      failed(error, current);
    }
  }

  function start() {
    if (!visible() || !category?.comicScenes?.length || run) return;
    pendingStart = false;
    if (finished) {
      seek();
      selectComicScene(0);
    }
    message();
    run = new AbortController();
    controls();
    void playScene(run);
  }

  playButton.onclick = () => {
    preferManual = Boolean(run);
    if (run) pause();
    else start();
  };
  voiceButton.onclick = () => {
    const wasPlaying = Boolean(run);
    const enable = !narrated;
    if (finished) selectComicScene(0);
    seek();
    narrated = enable;
    controls();
    if (enable || wasPlaying) start();
  };
  audio.addEventListener("timeupdate", () => {
    if (!run || !narrated || !sample || audio.paused || audio.seeking) return;
    if (!visible()) {
      pause();
      return;
    }
    const index = sample.starts.findLastIndex(
      (startTime) => startTime <= audio.currentTime,
    );
    if (index >= 0 && index !== comicReader.index) selectComicScene(index);
  });
  audio.addEventListener("ended", () => {
    if (!run || !narrated || !audio.ended) return;
    if (sample) {
      selectComicScene(category.comicScenes.length - 1);
      finish();
    } else advance();
  });
  audio.addEventListener("error", () => {
    if (run && narrated && audio.error) failed(audio.error, run);
  });
  document.getElementById("comic-summary-toggle").onclick = () => {
    const summary = document.getElementById("comic-summary");
    summary.hidden = !summary.hidden;
    document
      .getElementById("comic-summary-toggle")
      .setAttribute("aria-expanded", String(!summary.hidden));
    if (!summary.hidden) pause();
  };
  document.getElementById("comic-open-link").addEventListener("click", pause);
  document
    .getElementById("comic-script")
    .addEventListener("pointerdown", () => {
      if (run && !narrated) pause();
    });
  document.getElementById("comic-script").addEventListener(
    "wheel",
    () => {
      if (run && !narrated) pause();
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  window.addEventListener("pagehide", pause);
  motion.addEventListener("change", () => {
    if (motion.matches) pause();
  });

  return {
    pause,
    seek,
    sync,
    enter() {
      if (active) return;
      active = true;
      pendingStart = !motion.matches && !preferManual;
      sync();
    },
    leave() {
      if (!active) return;
      active = false;
      pause();
      releaseAudio();
      narrated = false;
    },
  };
})();
