(() => {
  "use strict";

  // -----------------------------
  // Config
  // -----------------------------
  const CALIBRATION_MS = 3000;
  const SESSION_MS = 10000;

  const DOT_MIN_MS = 200;
  const DOT_MAX_MS = 450;
  const DASH_MIN_MS = 500;

  const MIN_ON_MS = 45;
  const MIN_OFF_MS = 90;

  const BAND_LOW_HZ = 900;
  const BAND_HIGH_HZ = 4000;
  const PEAK_DOMINANCE_RATIO = 1.20;

  const ABS_MIN_THRESHOLD = 10;
  const THRESHOLD_MULTIPLIER = 2.0;
  const MAX_SEQUENCE_LEN = 28;

  // -----------------------------
  // DOM
  // -----------------------------
  const app = document.getElementById("app");
  const startBtn = document.getElementById("startBtn");

  const topLabel = document.getElementById("topLabel");
  const progressBar = document.getElementById("progressBar");
  const timeText = document.getElementById("timeText");

  const statusText = document.getElementById("statusText");
  const subText = document.getElementById("subText");

  const seqText = document.getElementById("seqText");
  const lastText = document.getElementById("lastText");
  const durText = document.getElementById("durText");
  const lvlText = document.getElementById("lvlText");
  const thrText = document.getElementById("thrText");
  const freqText = document.getElementById("freqText");

  // -----------------------------
  // Audio state
  // -----------------------------
  let audioContext = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let keepAliveGain = null;
  let keepAliveNode = null;
  let freqData = null;

  // -----------------------------
  // App state
  // -----------------------------
  let active = false;
  let phase = "idle"; // idle | calibrating | session
  let calibrationStart = 0;
  let sessionStart = 0;
  let sessionEnd = 0;

  let threshold = ABS_MIN_THRESHOLD;
  let calibrationSamples = [];
  let sequence = "";
  let rafId = 0;

  // sound state machine
  let soundState = "idle"; // idle | pendingOn | on | pendingOff
  let soundCandidateStart = 0;
  let soundStart = 0;
  let soundEndCandidate = 0;

  // -----------------------------
  // Helpers
  // -----------------------------
  function now() {
    return performance.now();
  }

  function setStatus(main, sub) {
    statusText.textContent = main;
    subText.textContent = sub || "";
  }

  function resetUi() {
    topLabel.textContent = "Tempo sessione";
    progressBar.style.width = "0%";
    timeText.textContent = "Pronto";

    seqText.textContent = "—";
    lastText.textContent = "—";
    durText.textContent = "0 ms";
    lvlText.textContent = "0";
    thrText.textContent = "0";
    freqText.textContent = "0 Hz";

    sequence = "";
  }

  function flashGood() {
    startBtn.classList.remove("bad-flash");
    startBtn.classList.add("good-flash");
    setTimeout(() => startBtn.classList.remove("good-flash"), 240);
  }

  function flashBad() {
    startBtn.classList.remove("good-flash");
    startBtn.classList.add("bad-flash");
    setTimeout(() => startBtn.classList.remove("bad-flash"), 240);
  }

  function classifyDuration(ms) {
    if (ms >= DOT_MIN_MS && ms <= DOT_MAX_MS) return ".";
    if (ms >= DASH_MIN_MS) return "-";
    return null;
  }

  function appendSymbol(symbol, ms) {
    if (sequence.length >= MAX_SEQUENCE_LEN) {
      sequence = sequence.slice(-(MAX_SEQUENCE_LEN - 1));
    }
    sequence += symbol;
    seqText.textContent = sequence;
    lastText.textContent = symbol;
    durText.textContent = `${Math.round(ms)} ms`;
  }

  function bandMetrics(data, sampleRate, fftSize, lowHz, highHz) {
    const binHz = sampleRate / fftSize;
    const start = Math.max(0, Math.floor(lowHz / binHz));
    const end = Math.min(data.length - 1, Math.ceil(highHz / binHz));

    let sum = 0;
    let count = 0;
    let peak = -1;
    let peakIdx = start;

    for (let i = start; i <= end; i++) {
      const v = data[i];
      sum += v;
      count++;
      if (v > peak) {
        peak = v;
        peakIdx = i;
      }
    }

    return {
      avg: count ? sum / count : 0,
      peak,
      peakHz: peakIdx * sampleRate / fftSize
    };
  }

  // -----------------------------
  // Audio setup / teardown
  // -----------------------------
  async function setupAudio() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("BROWSER_NOT_SUPPORTED");
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive"
    });

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.18;

    source.connect(analyser);

    // keep alive leggerissimo per Safari
    keepAliveGain = audioContext.createGain();
    keepAliveGain.gain.value = 0.00001;
    keepAliveGain.connect(audioContext.destination);

    if (typeof audioContext.createConstantSource === "function") {
      keepAliveNode = audioContext.createConstantSource();
      keepAliveNode.offset.value = 1;
      keepAliveNode.connect(keepAliveGain);
      keepAliveNode.start();
    } else {
      keepAliveNode = audioContext.createOscillator();
      keepAliveNode.frequency.value = 1;
      keepAliveNode.connect(keepAliveGain);
      keepAliveNode.start();
    }

    freqData = new Uint8Array(analyser.frequencyBinCount);
  }

  async function teardownAudio() {
    cancelAnimationFrame(rafId);
    rafId = 0;

    try {
      if (stream) stream.getTracks().forEach(t => t.stop());
    } catch (_) {}

    try { if (source) source.disconnect(); } catch (_) {}
    try { if (analyser) analyser.disconnect(); } catch (_) {}
    try { if (keepAliveNode) keepAliveNode.disconnect(); } catch (_) {}
    try { if (keepAliveGain) keepAliveGain.disconnect(); } catch (_) {}

    try {
      if (keepAliveNode && typeof keepAliveNode.stop === "function") {
        keepAliveNode.stop();
      }
    } catch (_) {}

    try {
      if (audioContext && audioContext.state !== "closed") {
        await audioContext.close();
      }
    } catch (_) {}

    audioContext = null;
    stream = null;
    source = null;
    analyser = null;
    keepAliveGain = null;
    keepAliveNode = null;
    freqData = null;
  }

  // -----------------------------
  // Phases
  // -----------------------------
  function beginCalibration() {
    phase = "calibrating";
    calibrationStart = now();
    calibrationSamples = [];
    threshold = ABS_MIN_THRESHOLD;

    topLabel.textContent = "Calibrazione";
    progressBar.style.width = "0%";
    timeText.textContent = "3.0 s";

    setStatus("Fai silenzio", "Misuro il rumore di fondo...");
    startBtn.classList.add("calibrating");
  }

  function beginSession() {
    phase = "session";
    sessionStart = now();
    sessionEnd = sessionStart + SESSION_MS;

    topLabel.textContent = "Tempo sessione";
    progressBar.style.width = "0%";
    timeText.textContent = "10.0 s";

    setStatus("Ascolto attivo", "Fischio breve = punto • fischio lungo = linea");
    startBtn.classList.remove("calibrating");

    soundState = "idle";
    soundCandidateStart = 0;
    soundStart = 0;
    soundEndCandidate = 0;
  }

  async function startApp() {
    if (active) return;

    active = true;
    app.classList.add("listening");
    startBtn.classList.add("active");
    startBtn.disabled = true;

    resetUi();
    setStatus("Richiesta microfono...", "Consenti l’accesso se il browser lo chiede");

    try {
      await setupAudio();
      beginCalibration();
      rafId = requestAnimationFrame(loop);
    } catch (err) {
      console.error(err);

      let msg = "Errore accesso microfono";
      if (err && err.name === "NotAllowedError") msg = "Permesso microfono negato o bloccato";
      else if (err && err.name === "NotFoundError") msg = "Microfono non trovato";
      else if (err && err.message === "BROWSER_NOT_SUPPORTED") msg = "Browser non compatibile";

      setStatus(`❌ ${msg}`, "Apri la pagina in HTTPS e abilita il microfono");
      active = false;
      phase = "idle";
      startBtn.disabled = false;
      startBtn.classList.remove("active", "calibrating", "sounding");
      app.classList.remove("listening");
      await teardownAudio();
    }
  }

  async function endApp(finalText) {
    active = false;
    phase = "idle";

    startBtn.disabled = false;
    startBtn.classList.remove("active", "calibrating", "sounding");
    app.classList.remove("listening");

    progressBar.style.width = "100%";
    timeText.textContent = "Fine";
    setStatus("Fine ascolto", finalText || (sequence ? `Sequenza finale: ${sequence}` : "Nessun simbolo rilevato"));

    await teardownAudio();
  }

  // -----------------------------
  // Main loop
  // -----------------------------
  function loop(ts) {
    if (!active || !analyser || !freqData) return;

    analyser.getByteFrequencyData(freqData);

    const sampleRate = audioContext.sampleRate;
    const fftSize = analyser.fftSize;
    const band = bandMetrics(freqData, sampleRate, fftSize, BAND_LOW_HZ, BAND_HIGH_HZ);

    const level = band.avg;
    const peakHz = band.peakHz;
    const dominance = band.avg > 0 ? (band.peak / band.avg) : 0;

    lvlText.textContent = `${Math.round(level)}`;
    freqText.textContent = `${Math.round(peakHz)} Hz`;

    if (phase === "calibrating") {
      const elapsed = ts - calibrationStart;
      const remaining = Math.max(0, CALIBRATION_MS - elapsed);

      calibrationSamples.push(level);
      const avgNoise = calibrationSamples.reduce((a, b) => a + b, 0) / Math.max(1, calibrationSamples.length);
      threshold = Math.max(ABS_MIN_THRESHOLD, avgNoise * THRESHOLD_MULTIPLIER);
      thrText.textContent = `${Math.round(threshold)}`;

      timeText.textContent = `${(remaining / 1000).toFixed(1)} s`;

      if (elapsed >= CALIBRATION_MS) {
        beginSession();
      }

      rafId = requestAnimationFrame(loop);
      return;
    }

    if (phase === "session") {
      const elapsed = ts - sessionStart;
      const remaining = Math.max(0, sessionEnd - ts);
      const progress = Math.min(1, elapsed / SESSION_MS);

      progressBar.style.width = `${progress * 100}%`;
      timeText.textContent = `${(remaining / 1000).toFixed(1)} s`;
      thrText.textContent = `${Math.round(threshold)}`;

      const whistleLike =
        level >= threshold &&
        peakHz >= BAND_LOW_HZ &&
        peakHz <= BAND_HIGH_HZ &&
        dominance >= PEAK_DOMINANCE_RATIO;

      if (whistleLike) startBtn.classList.add("sounding");
      else startBtn.classList.remove("sounding");

      // state machine detection
      if (soundState === "idle") {
        if (whistleLike) {
          soundState = "pendingOn";
          soundCandidateStart = ts;
        }
      } else if (soundState === "pendingOn") {
        if (!whistleLike) {
          soundState = "idle";
        } else if ((ts - soundCandidateStart) >= MIN_ON_MS) {
          soundState = "on";
          soundStart = soundCandidateStart;
        }
      } else if (soundState === "on") {
        durText.textContent = `${Math.round(ts - soundStart)} ms`;

        if (!whistleLike) {
          soundState = "pendingOff";
          soundEndCandidate = ts;
        }
      } else if (soundState === "pendingOff") {
        if (whistleLike) {
          soundState = "on";
        } else if ((ts - soundEndCandidate) >= MIN_OFF_MS) {
          const durationMs = soundEndCandidate - soundStart;
          durText.textContent = `${Math.round(durationMs)} ms`;

          const symbol = classifyDuration(durationMs);

          if (symbol) {
            appendSymbol(symbol, durationMs);
            setStatus(
              symbol === "." ? "Punto rilevato" : "Linea rilevata",
              `Durata rilevata: ${Math.round(durationMs)} ms`
            );
            flashGood();
          } else {
            lastText.textContent = "×";
            setStatus("Suono ignorato", `Durata non valida: ${Math.round(durationMs)} ms`);
            flashBad();
          }

          soundState = "idle";
          startBtn.classList.remove("sounding");
        }
      }

      if (ts >= sessionEnd) {
        endApp();
        return;
      }
    }

    rafId = requestAnimationFrame(loop);
  }

  // -----------------------------
  // Events
  // -----------------------------
  startBtn.addEventListener("click", async () => {
    if (active) return;
    await startApp();
  }, { passive: true });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden && active) {
      await endApp("Sessione interrotta");
    }
  });

  window.addEventListener("pagehide", async () => {
    if (active || audioContext) {
      await teardownAudio();
    }
  });

  resetUi();
})();
