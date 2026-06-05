(() => {
  "use strict";

  // =========================
  // CONFIG
  // =========================
  const SESSION_MS = 10000;

  // Codifica simboli
  const DOT_MIN_MS = 200;
  const DOT_MAX_MS = 450;
  const DASH_MIN_MS = 500;

  // Stabilizzazione stato suono
  const MIN_ON_MS = 45;      // evita trigger istantanei
  const MIN_OFF_MS = 90;     // aspetta fine suono prima di classificare
  const MAX_SEQUENCE_LEN = 24;

  // Filtro "tipo fischio"
  const BAND_LOW_HZ = 900;
  const BAND_HIGH_HZ = 4000;
  const PEAK_DOMINANCE_RATIO = 1.28; // picco più marcato della media banda

  // Auto-threshold
  const CALIBRATION_MS = 700;
  const THRESHOLD_MULTIPLIER = 2.0;
  const ABS_MIN_THRESHOLD = 12;

  // =========================
  // DOM
  // =========================
  const appEl = document.querySelector(".app");
  const mouthBtn = document.getElementById("mouthBtn");
  const statusText = document.getElementById("statusText");
  const countdownText = document.getElementById("countdownText");
  const sequenceText = document.getElementById("sequenceText");
  const symbolText = document.getElementById("symbolText");
  const levelText = document.getElementById("levelText");
  const thresholdText = document.getElementById("thresholdText");
  const freqText = document.getElementById("freqText");
  const durationText = document.getElementById("durationText");
  const hintText = document.getElementById("hintText");

  // =========================
  // AUDIO STATE
  // =========================
  let audioContext = null;
  let stream = null;
  let source = null;
  let analyser = null;
  let keepAliveGain = null;
  let zeroOsc = null;

  let freqData = null;
  let rafId = 0;

  // =========================
  // APP STATE
  // =========================
  let sessionActive = false;
  let sessionEndsAt = 0;
  let sessionStartAt = 0;

  let threshold = ABS_MIN_THRESHOLD;
  let noiseSamples = [];
  let calibrated = false;

  let soundState = "idle"; // idle | pendingOn | on | pendingOff
  let soundCandidateStart = 0;
  let soundStartTs = 0;
  let soundEndCandidateTs = 0;
  let liveDurationMs = 0;

  let sequence = "";

  // =========================
  // HELPERS
  // =========================
  function now() {
    return performance.now();
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function setCountdown(text) {
    countdownText.textContent = text;
  }

  function setHint(text) {
    hintText.textContent = text;
  }

  function resetUiForIdle() {
    appEl.classList.remove("is-listening");
    mouthBtn.classList.remove("is-active", "is-sounding", "flash-ok", "flash-bad");
    setStatus("Premi la bocca per iniziare");
    setCountdown("Pronto");
    symbolText.textContent = "—";
    durationText.textContent = "0 ms";
    levelText.textContent = "0";
    thresholdText.textContent = "0";
    freqText.textContent = "0 Hz";
    setHint("Fischia o emetti un suono acuto. Punto ≈ 200–450 ms • Linea ≥ 500 ms");
  }

  function resetDetectionState() {
    threshold = ABS_MIN_THRESHOLD;
    noiseSamples = [];
    calibrated = false;

    soundState = "idle";
    soundCandidateStart = 0;
    soundStartTs = 0;
    soundEndCandidateTs = 0;
    liveDurationMs = 0;

    sequence = "";
    sequenceText.textContent = "—";
    symbolText.textContent = "—";
  }

  function updateSequence(symbol) {
    sequence += symbol;
    if (sequence.length > MAX_SEQUENCE_LEN) {
      sequence = sequence.slice(-MAX_SEQUENCE_LEN);
    }
    sequenceText.textContent = sequence || "—";
    symbolText.textContent = symbol;
  }

  function flashOk() {
    mouthBtn.classList.remove("flash-bad");
    mouthBtn.classList.add("flash-ok");
    setTimeout(() => mouthBtn.classList.remove("flash-ok"), 240);
  }

  function flashBad() {
    mouthBtn.classList.remove("flash-ok");
    mouthBtn.classList.add("flash-bad");
    setTimeout(() => mouthBtn.classList.remove("flash-bad"), 240);
  }

  function formatMs(ms) {
    return `${Math.round(ms)} ms`;
  }

  function getPeakFrequencyHz(data, sampleRate, fftSize) {
    let maxVal = -1;
    let maxIndex = 0;

    for (let i = 0; i < data.length; i++) {
      if (data[i] > maxVal) {
        maxVal = data[i];
        maxIndex = i;
      }
    }

    const freq = maxIndex * sampleRate / fftSize;
    return { freq, value: maxVal };
  }

  function bandMetrics(data, sampleRate, fftSize, lowHz, highHz) {
    const binHz = sampleRate / fftSize;
    const start = Math.max(0, Math.floor(lowHz / binHz));
    const end = Math.min(data.length - 1, Math.ceil(highHz / binHz));

    let sum = 0;
    let count = 0;
    let peak = -1;
    let peakIndex = start;

    for (let i = start; i <= end; i++) {
      const v = data[i];
      sum += v;
      count++;
      if (v > peak) {
        peak = v;
        peakIndex = i;
      }
    }

    const avg = count > 0 ? sum / count : 0;
    const peakHz = peakIndex * sampleRate / fftSize;

    return {
      avg,
      peak,
      peakHz
    };
  }

  // =========================
  // AUDIO INIT / TEARDOWN
  // =========================
  async function initAudioForSession() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("BROWSER_NO_GUM");
    }

    // AudioContext creato dentro gesture utente
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive"
    });

    // Prompt microfono dentro il click
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    // Safari: dopo il prompt, riattiva il contesto
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    // Tieni "vivo" il grafo audio in Safari con gain quasi nullo
    keepAliveGain = audioContext.createGain();
    keepAliveGain.gain.value = 0.001;
    keepAliveGain.connect(audioContext.destination);

    // Piccolo trigger di sblocco Safari
    zeroOsc = audioContext.createOscillator();
    zeroOsc.frequency.value = 1;
    zeroOsc.connect(keepAliveGain);
    zeroOsc.start();
    zeroOsc.stop(audioContext.currentTime + 0.01);

    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.18;

    // In Safari conviene che la sorgente entri in un grafo attivo
    source.connect(analyser);
    analyser.connect(keepAliveGain);

    freqData = new Uint8Array(analyser.frequencyBinCount);
  }

  async function teardownAudio() {
    cancelAnimationFrame(rafId);
    rafId = 0;

    try {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
      }
    } catch (_) {}

    try {
      if (source) source.disconnect();
    } catch (_) {}

    try {
      if (analyser) analyser.disconnect();
    } catch (_) {}

    try {
      if (keepAliveGain) keepAliveGain.disconnect();
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
    zeroOsc = null;
    freqData = null;
  }

  // =========================
  // DETECTION
  // =========================
  function classifySymbol(durationMs) {
    if (durationMs >= DOT_MIN_MS && durationMs <= DOT_MAX_MS) return ".";
    if (durationMs >= DASH_MIN_MS) return "-";
    return null;
  }

  function processFrame(ts) {
    if (!sessionActive || !analyser || !freqData) return;

    analyser.getByteFrequencyData(freqData);

    const sr = audioContext.sampleRate;
    const fftSize = analyser.fftSize;

    const band = bandMetrics(freqData, sr, fftSize, BAND_LOW_HZ, BAND_HIGH_HZ);
    const fullPeak = getPeakFrequencyHz(freqData, sr, fftSize);

    const level = band.avg;
    const peakHz = band.peakHz;
    const dominance = band.avg > 0 ? (band.peak / band.avg) : 0;

    levelText.textContent = `${Math.round(level)}`;
    thresholdText.textContent = `${Math.round(threshold)}`;
    freqText.textContent = `${Math.round(peakHz || fullPeak.freq)} Hz`;

    // Auto-calibrazione iniziale
    const elapsedFromSessionStart = ts - sessionStartAt;
    if (elapsedFromSessionStart <= CALIBRATION_MS) {
      noiseSamples.push(level);
      const avgNoise = noiseSamples.reduce((a, b) => a + b, 0) / Math.max(1, noiseSamples.length);
      threshold = Math.max(ABS_MIN_THRESHOLD, avgNoise * THRESHOLD_MULTIPLIER);
      setStatus("Calibrazione rumore...");
      setHint("Aspetta un attimo: sto misurando il rumore di fondo");
      mouthBtn.classList.add("is-active");
      mouthBtn.classList.remove("is-sounding");
      rafId = requestAnimationFrame(processFrame);
      updateCountdown(ts);
      return;
    } else if (!calibrated) {
      calibrated = true;
      setStatus("Ascolto attivo");
      setHint("Fischia o emetti un suono acuto. Punto ≈ 200–450 ms • Linea ≥ 500 ms");
    }

    const isWhistleLike =
      level >= threshold &&
      peakHz >= BAND_LOW_HZ &&
      peakHz <= BAND_HIGH_HZ &&
      dominance >= PEAK_DOMINANCE_RATIO;

    // Stato visivo bocca/onde
    mouthBtn.classList.add("is-active");
    if (isWhistleLike) {
      mouthBtn.classList.add("is-sounding");
    } else {
      mouthBtn.classList.remove("is-sounding");
    }

    // Macchina a stati del suono
    if (soundState === "idle") {
      if (isWhistleLike) {
        soundState = "pendingOn";
        soundCandidateStart = ts;
      }
    }
    else if (soundState === "pendingOn") {
      if (!isWhistleLike) {
        soundState = "idle";
      } else if ((ts - soundCandidateStart) >= MIN_ON_MS) {
        soundState = "on";
        soundStartTs = soundCandidateStart;
      }
    }
    else if (soundState === "on") {
      liveDurationMs = ts - soundStartTs;
      durationText.textContent = formatMs(liveDurationMs);

      if (!isWhistleLike) {
        soundState = "pendingOff";
        soundEndCandidateTs = ts;
      }
    }
    else if (soundState === "pendingOff") {
      if (isWhistleLike) {
        // era ancora lo stesso suono, torna on
        soundState = "on";
      } else if ((ts - soundEndCandidateTs) >= MIN_OFF_MS) {
        const durationMs = soundEndCandidateTs - soundStartTs;
        durationText.textContent = formatMs(durationMs);

        const symbol = classifySymbol(durationMs);
        if (symbol) {
          updateSequence(symbol);
          setStatus(symbol === "." ? "Punto rilevato" : "Linea rilevata");
          flashOk();
        } else {
          setStatus("Suono ignorato");
          symbolText.textContent = "×";
          flashBad();
        }

        liveDurationMs = 0;
        soundState = "idle";
      }
    }

    updateCountdown(ts);

    // Fine sessione
    if (ts >= sessionEndsAt) {
      endSession();
      return;
    }

    rafId = requestAnimationFrame(processFrame);
  }

  function updateCountdown(ts) {
    const remaining = Math.max(0, sessionEndsAt - ts);
    const seconds = (remaining / 1000).toFixed(1);
    setCountdown(`Ascolto: ${seconds}s`);
  }

  // =========================
  // SESSION CONTROL
  // =========================
  async function startSession() {
    if (sessionActive) return;

    sessionActive = true;
    mouthBtn.disabled = true;
    appEl.classList.add("is-listening");
    mouthBtn.classList.add("is-active");

    resetDetectionState();
    setStatus("Richiesta microfono...");
    setCountdown("Avvio...");
    setHint("Se il browser lo chiede, consenti l’accesso al microfono");

    try {
      await initAudioForSession();

      sessionStartAt = now();
      sessionEndsAt = sessionStartAt + SESSION_MS;

      setStatus("Calibrazione rumore...");
      setCountdown(`Ascolto: ${(SESSION_MS / 1000).toFixed(1)}s`);

      rafId = requestAnimationFrame(processFrame);
    } catch (err) {
      console.error(err);

      let msg = "Errore accesso microfono";
      if (err && err.name === "NotAllowedError") {
        msg = "Permesso microfono negato o bloccato";
      } else if (err && err.name === "NotFoundError") {
        msg = "Microfono non trovato";
      } else if (err && err.message === "BROWSER_NO_GUM") {
        msg = "Browser non compatibile con il microfono";
      }

      setStatus(`❌ ${msg}`);
      setCountdown("Sessione non avviata");
      setHint("Su iPhone/Safari usa una pagina in HTTPS e consenti il microfono nelle impostazioni del sito");

      sessionActive = false;
      mouthBtn.disabled = false;
      mouthBtn.classList.remove("is-active", "is-sounding");
      appEl.classList.remove("is-listening");

      await teardownAudio();
    }
  }

  async function endSession() {
    sessionActive = false;
    mouthBtn.disabled = false;
    mouthBtn.classList.remove("is-active", "is-sounding");
    appEl.classList.remove("is-listening");

    const finalSequence = sequence || "—";
    setStatus("Fine ascolto");
    setCountdown("Pronto");
    setHint(`Sequenza finale: ${finalSequence}`);

    await teardownAudio();
  }

  // =========================
  // EVENTS
  // =========================
  mouthBtn.addEventListener("click", async () => {
    if (sessionActive) return;
    await startSession();
  }, { passive: true });

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden && sessionActive) {
      await endSession();
    }
  });

  window.addEventListener("pagehide", async () => {
    if (sessionActive || audioContext) {
      await teardownAudio();
    }
  });

  resetUiForIdle();
})();
