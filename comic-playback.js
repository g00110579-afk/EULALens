// A sample has one timed audio track. An uploaded comic has one authenticated
// clip per scene; only the current clip and one look-ahead request are needed.
comicPlayback = (() => {
  const audio = document.getElementById("comic-audio");
  const playButton = document.getElementById("comic-playback");
  const voiceButton = document.getElementById("comic-narration");
  const status = document.getElementById("comic-play-status");
  const progress = document.getElementById("comic-progress");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const clips = new Map();
  let category, scenario, sample;
  let active = false;
  let narrated = false,
    soundOnPlay = true,
    finished = false,
    run = null;
  let timer, deadline, remaining, readingDuration, progressTimer, loadTimer;
  let loadedSample, loadedIndex, objectURL, pendingSeek;

  function message(text = "") {
    if (status.textContent !== text) status.textContent = text;
    status.hidden = !text;
  }

  function showProgress() {
    if (!progress) return;
    progress.hidden = !active || !category?.comicScenes?.length;
    if (progress.hidden) return;
    if (finished) progress.value = 1;
    else if (!narrated || !audio.hasAttribute("src")) {
      const left = timer === undefined
        ? remaining ?? readingDuration
        : Math.max(0, deadline - performance.now());
      progress.value = narrated || !readingDuration
        ? 0
        : Math.max(0, 1 - left / readingDuration);
    } else {
      const index = comicReader.index;
      const start = sample?.starts[index] || 0;
      const end = sample?.starts[index + 1] ?? audio.duration;
      const ready = pendingSeek === undefined && (sample || loadedIndex === index);
      progress.value = ready && Number.isFinite(end) && end > start
        ? Math.min(1, Math.max(0, (audio.currentTime - start) / (end - start)))
        : 0;
    }
  }

  function controls() {
    document.getElementById("comic-reader").classList.toggle("is-playing", Boolean(run));
    const label = run ? "Pause" : finished ? "Replay" : "Play";
    document.getElementById("comic-play-label").textContent = label;
    document.getElementById("comic-play-icon").dataset.icon = run
      ? "pause"
      : finished
        ? "replay"
        : "play_arrow";
    playButton.setAttribute("aria-label", label + " comic");
    playButton.title = label + " comic";
    playButton.disabled = !category?.comicScenes?.length;
    voiceButton.disabled =
      !(
        sample ||
        (activeDocument === "live" && category?.comicJobId && scenario)
      ) || playButton.disabled;
    const enabled = soundOnPlay && !voiceButton.disabled;
    voiceButton.setAttribute("aria-pressed", String(enabled));
    voiceButton.querySelector(".comic-narration-label").textContent = enabled ? "Read aloud on" : "Read aloud off";
    voiceButton.title = voiceButton.disabled ? "Narration unavailable" : enabled ? "Turn narration off" : "Turn narration on";
    voiceButton.querySelector(".ui-icon").dataset.icon = enabled ? "volume_up" : "volume_off";
    document
      .getElementById("comic-script")
      .setAttribute("aria-live", run ? "off" : "polite");
    document
      .getElementById("comic-position")
      .setAttribute("aria-live", run ? "off" : "polite");
    showProgress();
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
    clearTimeout(loadTimer);
    pendingSeek = undefined;
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
    run?.abort();
    run = null;
    clips.clear();
    clearInterval(progressTimer);
    clearTimeout(loadTimer);
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
    readingDuration = undefined;
    finished = false;
    controls();
  }

  function sync() {
    const next = comicReader.category;
    if (next !== category || scenario !== comicReader.scenario) {
      // Category navigation also happens while Comic stays selected.
      seek();
      narrated = false;
    }
    category = next;
    scenario = comicReader.scenario;
    sample =
      (activeDocument !== "live" || category?.precomputed) &&
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

  // The public GitHub preview redirects media to a second host. Use the
  // identical, commit-pinned recording on jsDelivr if that request fails.
  function sampleMirror() {
    if (!sample || !["raw.githack.com", "rawcdn.githack.com"].includes(location.hostname))
      return "";
    const path = new URL(sample.src, location.href).pathname;
    const match = path.match(/^\/([\w.-]+)\/([\w.-]+)\/([a-f0-9]{40})\/(.+)$/i);
    return match ? "https://cdn.jsdelivr.net/gh/" + match[1] + "/" + match[2] + "@" + match[3] + "/" + match[4] : "";
  }

  function setTrack(url, time) {
    // Seeking an unloaded file is unreliable across media engines. Playback
    // still starts directly from the gesture, and loadedmetadata applies the cue.
    pendingSeek = time > 0 ? time : undefined;
    audio.src = url;
  }

  function failed(error, current, source) {
    if (!current || run !== current || (source && source !== audio.src)) return;
    const mirror = sampleMirror();
    if (error?.name !== "NotAllowedError" && loadedSample && mirror && audio.src !== mirror) {
      setTrack(mirror, Math.max(audio.currentTime || 0, sample.starts[comicReader.index]));
      void playScene(current);
      return;
    }
    pause();
    if (error?.name === "NotAllowedError") {
      message("Select Play to start narration.");
    } else {
      releaseAudio();
      narrated = false;
      controls();
      message("Audio could not load. Select Play to retry.");
    }
  }

  async function playScene(current) {
    if (!narrated) {
      if (remaining === undefined) readingDuration = readingTime();
      const delay = remaining ?? readingDuration;
      deadline = performance.now() + delay;
      timer = setTimeout(() => {
        timer = undefined;
        remaining = undefined;
        if (run === current) advance();
      }, delay);
      showProgress();
      return;
    }
    const index = comicReader.index;
    let source;
    try {
      if (sample) {
        if (loadedSample !== sample) {
          releaseAudio();
          const url = EULALensRuntime.safeUrl(sample.src, window.location.href);
          if (!url) throw new Error("Missing sample audio");
          loadedSample = sample;
          setTrack(url, sample.starts[index]);
        }
      } else if (loadedIndex !== index) {
        message("Loading narration…");
        const blob = await requestClip(index, current.signal);
        if (run !== current) return;
        clips.delete(index);
        releaseAudio();
        objectURL = URL.createObjectURL(blob);
        loadedIndex = index;
        audio.src = objectURL;
      }
      source = audio.src;
      if (audio.readyState < 3) message("Loading narration…");
      watchAudio(current, source);
      await audio.play();
      if (run !== current || source !== audio.src) return;
      clearTimeout(loadTimer);
      message();
      if (!sample && index + 1 < category.comicScenes.length)
        requestClip(index + 1, current.signal);
    } catch (error) {
      failed(error, current, source);
    }
  }

  function watchAudio(current, source) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => failed(new Error("Audio load timed out"), current, source), 15000);
  }

  function start() {
    if (!visible() || !category?.comicScenes?.length || run) return;
    if (finished) {
      seek();
      selectComicScene(0);
    }
    narrated = soundOnPlay && !voiceButton.disabled;
    message();
    run = new AbortController();
    progressTimer = setInterval(showProgress, 200);
    controls();
    followZoomedComicPanel();
    void playScene(run);
  }

  playButton.onclick = () => {
    if (run) pause();
    else start();
  };
  voiceButton.onclick = () => {
    const playing = Boolean(run);
    soundOnPlay = !soundOnPlay;
    if (playing) {
      seek();
      start();
    } else controls();
  };
  audio.addEventListener("loadedmetadata", () => {
    if (pendingSeek !== undefined) {
      audio.currentTime = pendingSeek;
      pendingSeek = undefined;
    }
    showProgress();
  });
  audio.addEventListener("waiting", () => {
    if (!run || !narrated || !audio.hasAttribute("src")) return;
    message("Loading narration…");
    watchAudio(run, audio.src);
  });
  audio.addEventListener("playing", () => {
    if (!run || !narrated) return;
    clearTimeout(loadTimer);
    message();
  });
  audio.addEventListener("pause", () => {
    // A device's media controls can pause the element independently of our button.
    if (run && narrated && audio.paused && !audio.ended && audio.readyState >= 2) pause();
  });
  audio.addEventListener("timeupdate", () => {
    if (!run || !narrated || !sample || pendingSeek !== undefined || audio.paused || audio.seeking) return;
    if (!visible()) {
      pause();
      return;
    }
    const next = sample.starts.findIndex(startTime => startTime > audio.currentTime);
    const index = next < 0 ? sample.starts.length - 1 : next - 1;
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
    if (run && narrated && audio.error) failed(audio.error, run, audio.src);
  });
  document.getElementById("comic-summary-toggle").onclick = () => {
    const summary = document.getElementById("comic-summary");
    summary.hidden = !summary.hidden;
    document
      .getElementById("comic-summary-toggle")
      .setAttribute("aria-expanded", String(!summary.hidden));
    if (!summary.hidden) pause();
  };
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
      sync();
    },
    leave() {
      if (!active) return;
      active = false;
      pause();
      releaseAudio();
      narrated = false;
      controls();
    },
  };
})();
