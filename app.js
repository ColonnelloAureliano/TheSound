(() => {
  "use strict";

  // ========================
  // CONFIG
  // ========================
  const SESSION_MS = 10000;
  const CALIBRATION_MS = 3000;

  const DOT_MIN_MS = 200;
  const DOT_MAX_MS = 450;
  const DASH_MIN_MS = 500;

  const MIN_ON_MS = 45;   // evita falsi trigger brevissimi
  const MIN_OFF_MS = 90;  // aspetta fine suono reale

  // Filtro "tipo fischio"
  const BAND_LOW_HZ = 900;
  const BAND_HIGH_HZ = 4000;
  const PEAK_DOMINANCE_RATIO = 1.25;

  // Soglia dinamica
  const ABS_MIN_THRESHOLD = 10;
  const THRESHOLD_MULTIPLIER = 2.0;

  const MAX_SEQUENCE_LEN = 28;

  // ========================
  // DOM
  // ========================
  const app = document.getElementById("app");
  const startBtn = document.getElementById("startBtn");
  const progressBar = document.getElementById("progressBar");
  const timerText = document.getElementById("timerText");

  const statusText = document.getElementById("statusText");
  const subText = document.getElementById("subText");

  const sequenceText = document.getElementById("sequenceText");
  const lastSymbolText = document.getElementById("lastSymbolText");
  const durationText = document.getElementById("durationText");
  const levelText = document.getElementById("levelText");
  const thresholdText = document.getElementById("thresholdText");
  const freqText = document.getElementById("freqText");

  // ========================
  // AUDIO
  // ========================
  let audioContext = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let keepAliveGain = null;
  let keepAliveNode = null;
  let freqData = null;

  // ========================
  // STATO
  // ========================
  let sessionActive = false;
  let sessionStartTs = 0;
  let sessionEndTs = 0;

  let threshold = ABS_MIN_THRESHOLD;
  let calibrationSamples = [];
  let sequence = "";
  let rafId = 0;

  // State machine suono
  let soundState = "idle"; // idle | pendingOn | on | pendingOff
  let soundCandidateStart = 0;
  let soundStartTs = 0;
  let soundEndCandidateTs = 0;

  // ========================
  // HELPERS
  // ========================
  function now() {
    return performance.now();
  }

  function setStatus(main, sub = "") {
    statusText.textContent = main;
    subText.textContent = sub;
  }

  function updateProgress(ts) {
    const elapsed = Math.max(0, ts - sessionStartTs);
    const progress = Math.min(1, elapsed / SESSION_MS);
    progressBar.style.width = `${progress * 100}%`;

    const remaining = Math.max(0, sessionEndTs - ts);
    timerText.textContent = remaining > 0 ? `${(remaining / 1000).toFixed(1)} s` : "0.0 s";
  }

  function clearUiForNewSession() {
    progressBar.style.width = "0%";
    timerText.textContent = `${(SESSION_MS / 1000).toFixed(1)} s`;

    sequence = "";
    sequenceText.textContent = "—";
    lastSymbolText.textContent = "—";
    durationText.textContent = "0 ms";
    levelText.textContent = "0";
    thresholdText.textContent = "0";
    freqText.textContent = "0 Hz";
  }

  function showSymbol(symbol, durationMs) {
    lastSymbolText.textContent = symbol;
    durationText.textContent = `${Math.round(durationMs)} ms`;

    if (sequence.length >= MAX_SEQUENCE_LEN) {
      sequence = sequence.slice(-(MAX_SEQUENCE_LEN - 1));
    }
    sequence += symbol;
    sequenceText.textContent = sequence || "—";
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

  function classifyDuration(ms) {
    if (ms >= DOT_MIN_MS && ms <= DOT_MAX_MS) return ".";
    if (ms >= DASH_MIN_MS) return "-";
    return null;
  }

  function flashGood() {
    startBtn.classList.remove("bad-flash");
    startBtn.classList.add("good-flash");
    setTimeout(() => startBtn.classList.remove("good-flash"), 260);
  }

  function flashBad() {
    startBtn.classList.remove("good-flash");
    startBtn.classList.add("bad-flash");
    setTimeout(() => startBtn.classList.remove("bad-flash"), 260);
  }

  // ========================
  // AUDIO SETUP / STOP
  // ========================
  async function setupAudio() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("BROWSER_NOT_SUPPORTED");
    }

    // AudioContext creato nel click -> iPhone friendly
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive"
    });

    // richiesta microfono nel click
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    // fix Safari/iPhone: resume dopo prompt
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.18;

    source.connect(analyser);

    // piccolo keep alive per Safari (quasi muto)
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

  async function stopAudio() {
    cancelAnimationFrame(rafId);
    rafId = 0;

    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
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

  // ========================
  // SESSIONE
  // ========================
  async function startSession() {
    if (sessionActive) return;

    sessionActive = true;
    startBtn.disabled = true;
    startBtn.classList.add("active");
    app.classList.add("listening");

    calibrationSamples = [];
    threshold = ABS_MIN_THRESHOLD;
    soundState = "idle";
    soundCandidateStart = 0;
    soundStartTs = 0;
    soundEndCandidateTs = 0;

    clearUiForNewSession();
    setStatus("Richiesta microfono...", "Consenti l’accesso se il browser lo chiede");

    try {
      await setupAudio();

      sessionStartTs = now();
      sessionEndTs = sessionStartTs + SESSION_MS;

      rafId = requestAnimationFrame(loop);
    } catch (err) {
      console.error(err);

      let message = "Errore accesso microfono";
      if (err && err.name === "NotAllowedError") {
        message = "Permesso microfono negato o bloccato";
      } else if (err && err.name === "NotFoundError") {
        message = "Microfono non trovato";
      } else if (err && err.message === "BROWSER_NOT_SUPPORTED") {
        message = "Browser non compatibile";
      }

      setStatus(`❌ ${message}`, "Su iPhone usa HTTPS e abilita Microfono nelle impostazioni del sito");
      sessionActive = false;
      startBtn.disabled = false;
      startBtn.classList.remove("active", "calibrating", "sounding");
      app.classList.remove("listening");

      await stopAudio();
    }
  }

  async function endSession() {
    sessionActive = false;
    startBtn.disabled = false;
    startBtn.classList.remove("active", "calibrating", "sounding");
    app.classList.remove("listening");

    progressBar.style.width = "100%";
    timerText.textContent = "Fine";

    setStatus(
      "Fine ascolto",
      sequence ? `Sequenza finale: ${sequence}` : "Nessun simbolo rilevato"
    );

    await stopAudio();
  }

  // ========================
  // LOOP PRINCIPALE
  // ========================
  function loop(ts) {
    if (!sessionActive || !analyser || !freqData) return;

    analyser.getByteFrequencyData(freqData);

    const sampleRate = audioContext.sampleRate;
    const fftSize = analyser.fftSize;
    const band = bandMetrics(freqData, sampleRate, fftSize, BAND_LOW_HZ, BAND_HIGH_HZ);

    const level = band.avg;
    const peakHz = band.peakHz;
    const dominance = band.avg > 0 ? (band.peak / band.avg) : 0;

    levelText.textContent = `${Math.round(level)}`;
    freqText.textContent = `${Math.round(peakHz)} Hz`;

    const elapsed = ts - sessionStartTs;
    const calibrating = elapsed <= CALIBRATION_MS;

    // calibrazione 3 secondi
    if (calibrating) {
      startBtn.classList.add("calibrating");
      startBtn.classList.remove("sounding");

      calibrationSamples.push(level);
      const avgNoise = calibrationSamples.reduce((a, b) => a + b, 0) / Math.max(1, calibrationSamples.length);
      threshold = Math.max(ABS_MIN_THRESHOLD, avgNoise * THRESHOLD_MULTIPLIER);

      thresholdText.textContent = `${Math.round(threshold)}`;
      setStatus("Fai silenzio", "Misuro il rumore di fondo...");
    } else {
      startBtn.classList.remove("calibrating");
      thresholdText.textContent = `${Math.round(threshold)}`;
      if (soundState === "idle") {
        setStatus("Ascolto attivo", "Fai un fischio breve per punto, più lungo per linea");
      }
    }

    // filtro fischio
    const whistleLike =
      !calibrating &&
      level >= threshold &&
      peakHz >= BAND_LOW_HZ &&
      peakHz <= BAND_HIGH_HZ &&
      dominance >= PEAK_DOMINANCE_RATIO;

    if (whistleLike) {
      startBtn.classList.add("sounding");
    } else {
      startBtn.classList.remove("sounding");
    }

    // state machine del suono
    if (!calibrating) {
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
          soundStartTs = soundCandidateStart;
        }
      } else if (soundState === "on") {
        durationText.textContent = `${Math.round(ts - soundStartTs)} ms`;

        if (!whistleLike) {
          soundState = "pendingOff";
          soundEndCandidateTs = ts;
        }
      } else if (soundState === "pendingOff") {
        if (whistleLike) {
          // era ancora lo stesso suono
          soundState = "on";
        } else if ((ts - soundEndCandidateTs) >= MIN_OFF_MS) {
          const durationMs = soundEndCandidateTs - soundStartTs;
          durationText.textContent = `${Math.round(durationMs)} ms`;

          const symbol = classifyDuration(durationMs);

          if (symbol) {
            showSymbol(symbol, durationMs);
            setStatus(
              symbol === "." ? "Punto rilevato" : "Linea rilevata",
              `Durata rilevata: ${Math.round(durationMs)} ms`
            );
            flashGood();
          } else {
            lastSymbolText.textContent = "×";
            setStatus("Suono ignorato", `Durata non valida: ${Math.round(durationMs)} ms`);
            flashBad();
          }

          soundState = "idle";
        }
      }
    }

    updateProgress(ts);

    if (ts >= sessionEndTs) {
      endSession();
      return;
    }

    rafId = requestAnimationFrame(loop);
  }

  // ========================
  // EVENTI
  // ========================
  startBtn.addEventListener("click", async () => {
    if (sessionActive) return;
    await startSession();
  }, { passive: true });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden && sessionActive) {
      await endSession();
    }
  });

  window.addEventListener("pagehide", async () => {
    if (audioContext || sessionActive) {
      await stopAudio();
    }
  });
})();

