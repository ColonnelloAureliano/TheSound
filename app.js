const mouth = document.getElementById("mouth");
const feedback = document.getElementById("feedback");
const bar = document.getElementById("bar");

let analyser, audioCtx, source, stream;
let listening = false;

let pattern = [];
let signalOn = false;
let startTime = 0;

let firstSound = true;

/* ✅ AUTO CALIBRAZIONE */
let dotDurations = [];
let avgDot = 0;

/* ✅ RUMORE */
let noiseFloor = 0;

mouth.onclick = async () => {
  reset();

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  source = audioCtx.createMediaStreamSource(stream);

  source.connect(analyser);

  document.body.classList.add("open","show-dot","scan");

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

  dotDurations = [];
  avgDot = 0;

  feedback.innerText = "";
  bar.style.width = "0%";
  document.body.className = "";
}

/* ✅ TIMER */
function startTimer() {
  let start = Date.now();

  function update() {
    let elapsed = Date.now() - start;
    bar.style.width = (elapsed / 10000 * 100) + "%";
    if (elapsed < 10000) requestAnimationFrame(update);
  }

  update();
}

/* ✅ LISTENING SMART */
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

    /* ✅ noise auto */
    noiseFloor = noiseFloor * 0.95 + rms * 0.05;
    let threshold = noiseFloor * 3 + 0.02;

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

      /* ✅ PRIMO SEMPRE PUNTO */
      if (firstSound) {
        symbol = '.';
        firstSound = false;
        dotDurations.push(duration);
      } else {
        /* ✅ CALCOLA MEDIA PUNTO */
        if (dotDurations.length >= 2) {
          avgDot = dotDurations.reduce((a,b)=>a+b,0) / dotDurations.length;
        }

        let thresholdLine = avgDot * 1.8 || 350;

        if (duration > thresholdLine) {
          symbol = '-';
        } else {
          symbol = '.';
          dotDurations.push(duration);
        }
      }

      pattern.push(symbol);
      feedback.innerText = pattern.join(" ");

      if (pattern.length === 4) {
        listening = false;
      }
    }

    requestAnimationFrame(loop);
  }

  loop();
}

function success() {
  document.body.classList.add("success");
}

function fail() {
  document.body.className = "";
  feedback.innerText = "";
  bar.style.width = "0%";
}

function checkResult() {
  listening = false;

  if (pattern.join('') === "..--") {
    success();
  } else {
    fail();
  }
}
