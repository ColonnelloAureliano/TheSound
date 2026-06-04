const mouth = document.getElementById("mouth");
const feedback = document.getElementById("feedback");

let analyser, audioCtx, source, stream;
let listening = false;

let pattern = [];
let signalOn = false;
let startTime = 0;

let firstSound = true;

const LONG_THRESHOLD = 400;

mouth.onclick = async () => {
  reset();

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  source = audioCtx.createMediaStreamSource(stream);

  source.connect(analyser);

  document.body.classList.add("open","show-dot","scan");

  // 3 secondi onde
  setTimeout(() => {
    document.body.classList.remove("scan");
    document.body.classList.add("red");

    startListening();

    setTimeout(checkResult, 10000);

  }, 3000);
};

function reset() {
  pattern = [];
  listening = false;
  firstSound = true;
  feedback.innerText = "";

  document.body.className = "";
}

function startListening() {
  listening = true;

  const data = new Uint8Array(analyser.fftSize);

  function loop() {
    if (!listening) return;

    analyser.getByteTimeDomainData(data);

    let rms = 0;
    for (let i = 0; i < data.length; i++) {
      let v = (data[i] - 128) / 128;
      rms += v * v;
    }
    rms = Math.sqrt(rms / data.length);

    let now = performance.now();
    let isSound = rms > 0.02;

    if (isSound && !signalOn) {
      signalOn = true;
      startTime = now;
    }

    if (!isSound && signalOn) {
      signalOn = false;

      let duration = now - startTime;

      let symbol;

      // ✅ LOGICA NUOVA
      if (firstSound) {
        symbol = '.';
        firstSound = false;
      } else {
        if (duration > LONG_THRESHOLD) symbol = '-';
        else symbol = '.';
      }

      pattern.push(symbol);

      // ✅ FEEDBACK VISIVO
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
  let target = ['.', '.', '-', '-'];
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
}

function checkResult() {
  if (pattern.join('') !== "..--") {
    fail();
  }
}
