const PASSWORD = ['.', '.', '-', '-']; // IM in Morse
const SCAN_MS = 3000;
const INPUT_WINDOW_MS = 10000;
const SHORT_MIN = 70;
const SHORT_MAX = 280;
const LONG_MIN = 300;
const LONG_MAX = 1300;
const GAP_SYMBOL_MIN = 60;
const MIN_PATTERN_LENGTH = 4;
const PITCH_FREQ = 1500; // safe high-pitch tone, not ultrasound

const body = document.body;
const mouthBtn = document.getElementById('mouthBtn');
const srStatus = document.getElementById('srStatus');

let audioCtx = null;
let analyser = null;
let mediaStream = null;
let mediaSource = null;
let rafId = null;
let scanTimer = null;
let inputTimer = null;
let resolvingSuccess = false;

const listenState = {
  listening: false,
  isSounding: false,
  soundStart: 0,
  silenceStart: 0,
  pattern: [],
  recentRms: [],
  noiseFloor: 0.012
};

function setPhase(phase) {
  body.classList.remove('state-idle', 'state-scanning', 'state-input', 'state-success');
  body.classList.add(`state-${phase}`);
}

function setOpen(isOpen) {
  body.classList.toggle('open', !!isOpen);
}

function setOrbVisible(isVisible) {
  body.classList.toggle('show-orb', !!isVisible);
}

function setSr(text) {
  srStatus.textContent = text;
}

function clearTimers() {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  if (inputTimer) {
    clearTimeout(inputTimer);
    inputTimer = null;
  }
}

function stopListening() {
  listenState.listening = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function stopAudioInput() {
  try {
    if (mediaSource) {
      mediaSource.disconnect();
      mediaSource = null;
    }
  } catch (_) {}

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

function hardReset() {
  resolvingSuccess = false;
  clearTimers();
  stopListening();
  stopAudioInput();

  listenState.isSounding = false;
  listenState.soundStart = 0;
  listenState.silenceStart = 0;
  listenState.pattern = [];
  listenState.recentRms = [];
  listenState.noiseFloor = 0.012;

  setPhase('idle');
  setOpen(false);
  setOrbVisible(false);
  mouthBtn.disabled = false;
  setSr('');
}

function failAndClose() {
  clearTimers();
  stopListening();
  stopAudioInput();
  listenState.pattern = [];
  setPhase('idle');
  setOrbVisible(false);
  setOpen(false);
  mouthBtn.disabled = false;
  setSr('Tentativo non riuscito');
}

function succeed() {
  if (resolvingSuccess) return;
  resolvingSuccess = true;
  clearTimers();
  stopListening();
  stopAudioInput();
  setPhase('success');
  setOpen(true);
  setOrbVisible(true);
  mouthBtn.disabled = false;
  setSr('Codice corretto');
}

async function ensureAudioContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  return audioCtx;
}

async function requestMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return null;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    return mediaStream;
  } catch (_) {
    return null;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function playTone(durationMs, frequency = PITCH_FREQ, volume = 0.028) {
  const ctx = await ensureAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;

  const start = ctx.currentTime;
  const end = start + durationMs / 1000;

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.setValueAtTime(volume, Math.max(start + 0.02, end - 0.03));
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.02);

  await wait(durationMs + 30);
}

async function playReferencePattern() {
  // Pattern: point point line line (safe high-pitch audio, not ultrasound)
  await playTone(140);
  await wait(120);
  await playTone(140);
  await wait(160);
  await playTone(420);
  await wait(120);
  await playTone(420);
}

function classifyPulse(duration) {
  if (duration >= SHORT_MIN && duration <= SHORT_MAX) return '.';
  if (duration >= LONG_MIN && duration <= LONG_MAX) return '-';
  return null;
}

async function startListening(stream) {
  const ctx = await ensureAudioContext();

  if (!analyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
  }

  if (mediaSource) {
    try { mediaSource.disconnect(); } catch (_) {}
  }

  mediaSource = ctx.createMediaStreamSource(stream);
  mediaSource.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  listenState.listening = true;
  listenState.isSounding = false;
  listenState.soundStart = 0;
  listenState.silenceStart = performance.now();
  listenState.pattern = [];
  listenState.recentRms = [];
  listenState.noiseFloor = 0.012;
  setSr('Ascolto attivo');

  const loop = () => {
    if (!listenState.listening) return;

    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const x = (data[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / data.length);

    listenState.recentRms.push(rms);
    if (listenState.recentRms.length > 60) listenState.recentRms.shift();

    const sorted = [...listenState.recentRms].sort((a, b) => a - b);
    const base = sorted[Math.floor(sorted.length * 0.25)] || 0.012;
    listenState.noiseFloor = Math.max(0.012, Math.min(base * 2.25, 0.08));
    const threshold = listenState.noiseFloor;

    const now = performance.now();
    const sounding = rms > threshold;

    if (sounding && !listenState.isSounding) {
      if (now - listenState.silenceStart >= GAP_SYMBOL_MIN) {
        listenState.isSounding = true;
        listenState.soundStart = now;
      }
    }

    if (!sounding && listenState.isSounding) {
      listenState.isSounding = false;
      const duration = now - listenState.soundStart;
      const symbol = classifyPulse(duration);

      if (symbol && listenState.pattern.length < MIN_PATTERN_LENGTH) {
        listenState.pattern = [...listenState.pattern, symbol];
        const prefixOk = listenState.pattern.every((v, i) => v === PASSWORD[i]);

        if (!prefixOk) {
          failAndClose();
          return;
        }

        if (listenState.pattern.length === MIN_PATTERN_LENGTH) {
          succeed();
          return;
        }
      }

      listenState.silenceStart = now;
    }

    if (!sounding && !listenState.isSounding && listenState.silenceStart === 0) {
      listenState.silenceStart = now;
    }

    rafId = requestAnimationFrame(loop);
  };

  loop();
}

async function startSequence() {
  hardReset();
  mouthBtn.disabled = true;

  const stream = await requestMic();
  await ensureAudioContext();

  setOpen(true);
  setOrbVisible(true);
  setPhase('scanning');
  setSr(stream ? 'Microfono attivo' : 'Microfono non disponibile');

  scanTimer = setTimeout(async () => {
    setPhase('input');

    if (stream) {
      startListening(stream);
    }

    playReferencePattern().catch(() => {});

    inputTimer = setTimeout(() => {
      if (listenState.pattern.join('') !== PASSWORD.join('')) {
        failAndClose();
      }
    }, INPUT_WINDOW_MS);

    mouthBtn.disabled = false;
  }, SCAN_MS);
}

mouthBtn.addEventListener('click', () => {
  startSequence().catch(() => {
    failAndClose();
  });
});

window.addEventListener('pagehide', () => {
  stopListening();
  stopAudioInput();
  clearTimers();
});
