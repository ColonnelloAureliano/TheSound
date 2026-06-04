const mouth = document.getElementById("mouth");
const feedback = document.getElementById("feedback");
const bar = document.getElementById("bar");

let analyser, audioCtx, source, stream;

let listening = false;
let pattern = [];

let signalOn = false;
let startTime = 0;

let firstSound = true;

/* ✅ Soglia adattiva */
let noiseFloor = 0;
let threshold = 0;

/* timing */
const LONG_THRESHOLD = 400;

mouth.onclick = async () => {
  reset();

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  source = audioCtx.createMediaStreamSource(stream);

  source.connect(analyser);

  document.body.classList.add("open","show-dot","scan");

  /* 3 secondi onde */
  setTimeout(() => {

    document.body.classList.remove("scan");
    document.body.classList.add("red");

    startListening();
    startTimer();

    setTimeout(checkResult, 10000);

  }, 3000);
};

function reset() {
  pattern = [];
  listening = false;
  firstSound = true;
  feedback.innerText = "";
  bar.style.width = "0%";
  document.body.className = "";
}

/* ✅ TIMER 10s REALI */
function startTimer() {
  let start = Date.now();

  function update() {
    let elapsed = Date.now() - start;
    let percent = (elapsed / 10000) * 100;
    bar.style.width = percent + "%";

    if (elapsed < 10000) requestAnimationFrame(update);
  }

  update();
}

/* ✅ LISTENING MIGLIORATO */
function startListening() {
  listening = true;

  const data = new Uint8Array(analyser.fftSize);

  function loop() {
    if (!listening) return;

    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      let v = (data[i] - 128) / 128;
      sum += v * v;
    }

    let rms = Math.sqrt(sum / data.length);

    /* ✅ auto-calibrazione rumore */
    if (noiseFloor === 0) {
      noiseFloor = rms;
    } else {
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
    }

    threshold = noiseFloor * 3 + 0.02;

    let isSound = rms > threshold;

    let now = performance.now();

    if (isSound && !signalOn) {
      signalOn = true;
      startTime = now;
    }

    if (!isSound && signalOn) {
      signalOn = false;

      let duration = now - startTime;

      let symbol;

      /* ✅ primo sempre punto */
      if (firstSound) {
        symbol = '.';
        firstSound = false;
      } else {
        if (duration > LONG_THRESHOLD) symbol = '-';
        else symbol = '.';
      }

      pattern.push(symbol);

      /* ✅ feedback */
      feedback.innerText = pattern.join(" ");

      if (!checkPrefix()) {
        fail();
        return;
      }

      if (pattern.length === 4) {
        success();
        return;
      }
    }

    requestAnimationFrame(loop);
  }

  loop();
}

function checkPrefix() {
  const target = ['.', '.', '-', '-'];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== target[i]) return false;
  }
  return true;
}

function success() {
  listening = false;
  document.body.classList.add("success");
}

function fail() {
  listening = false;
  document.body.className = "";
  feedback.innerText = "";
  bar.style.width = "0%";
}

function checkResult() {
  if (pattern.join('') !== "..--") {
    fail();
  }
}
