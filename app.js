const mouth = document.getElementById("mouth");
const feedback = document.getElementById("feedback");
const statusText = document.getElementById("status");
const hint = document.getElementById("hint");
const timeDisplay = document.getElementById("timeDisplay");
const bar = document.getElementById("bar");

let analyser, audioCtx, source, stream;
let freqData;

let listening = false;
let gameActive = false;

let pattern = [];

let signalOn = false;
let startTime = 0;
let silentStart = 0;

const SILENCE_HOLD = 250;
const MIN_DOT = 200;
const MIN_LINE = 500;

let noiseFloor = 0;
let noiseSamples = [];

let dotDurations = [];
let avgDot = 0;
let firstSound = true;

const MIN_FREQ = 1200;
const MAX_FREQ = 4000;

/* CLICK */
mouth.onclick = async () => {

  if (gameActive) return;

  gameActive = true;
  mouth.disabled = true;

  hardReset(false);

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  source = audioCtx.createMediaStreamSource(stream);
  source.connect(analyser);

  freqData = new Uint8Array(analyser.frequencyBinCount);

  document.body.classList.add("open","show-dot","scan");
  statusText.innerText = "FAI SILENZIO";

  calibrate();
};

/* CALIBRAZIONE */
function calibrate(){
  const data = new Uint8Array(analyser.fftSize);
  let start = Date.now();

  function loop(){
    analyser.getByteTimeDomainData(data);
    noiseSamples.push(getRMS(data));

    if(Date.now()-start < 3000){
      requestAnimationFrame(loop);
    } else {
      noiseFloor = avg(noiseSamples);
      startGame();
    }
  }
  loop();
}

/* START */
function startGame(){
  document.body.classList.remove("scan");
  document.body.classList.add("red");
  statusText.innerText="";

  startListening();
  startTimer();

  setTimeout(checkResult,10000);
}

/* TIMER */
function startTimer(){
  let start = Date.now();

  function loop(){
    let t = Date.now()-start;
    bar.style.width = (t/10000*100)+"%";
    if(t<10000) requestAnimationFrame(loop);
  }

  loop();
}

/* DETECTION */
function startListening(){
  listening = true;
  const data = new Uint8Array(analyser.fftSize);

  function loop(){
    if(!listening) return;

    analyser.getByteTimeDomainData(data);
    analyser.getByteFrequencyData(freqData);

    let rms = getRMS(data);
    let threshold = noiseFloor * 4;

    let freq = getFreq();
    let isSound = rms > threshold && freq > MIN_FREQ && freq < MAX_FREQ;

    let now = performance.now();

    if(isSound){
      if(!signalOn){
        signalOn = true;
        startTime = now;
      }
      silentStart = 0;
    }

    if(!isSound && signalOn){

      if(!silentStart) silentStart = now;

      if(now - silentStart > SILENCE_HOLD){

        signalOn = false;

        let duration = silentStart - startTime;

        if(duration < MIN_DOT){
          requestAnimationFrame(loop);
          return;
        }

        let symbol;

        if(firstSound){
          symbol='.';
          firstSound=false;
          dotDurations.push(duration);

          let lineThreshold = Math.min(duration * 2, MIN_LINE);

          hint.innerText =
            `. = ${Math.round(duration)} ms → linea > ${Math.round(lineThreshold)} ms`;
        }
        else{
          if(dotDurations.length>=2){
            avgDot = avg(dotDurations);
          }

          let dyn = avgDot * 2;

          if(duration >= MIN_LINE && duration >= dyn){
            symbol='-';
          } else {
            symbol='.';
            dotDurations.push(duration);
          }
        }

        pattern.push(symbol);

        feedback.innerText = pattern.join(" ");
        timeDisplay.innerText = `Durata: ${Math.round(duration)} ms`;

        if(pattern.length === 4){
          listening=false;
        }
      }
    }

    requestAnimationFrame(loop);
  }

  loop();
}

/* FREQ */
function getFreq(){
  let max = 0;
  let idx = 0;

  for(let i=0;i<freqData.length;i++){
    if(freqData[i]>max){
      max = freqData[i];
      idx = i;
    }
  }

  return idx * audioCtx.sampleRate / analyser.fftSize;
}

/* RESULT */
function checkResult(){
  listening=false;
  gameActive=false;
  mouth.disabled=false;

  if(pattern.join('')==="..--"){
    document.body.classList.add("success");
  } else {
    hardReset();
  }
}

/* RESET */
function hardReset(full=true){

  listening=false;
  gameActive=false;

  signalOn=false;
  silentStart=0;
  startTime=0;

  pattern=[];
  firstSound=true;
  dotDurations=[];
  avgDot=0;

  noiseSamples=[];
  noiseFloor=0;

  feedback.innerText="";
  hint.innerText="";
  statusText.innerText="";
  timeDisplay.innerText="";
  bar.style.width="0%";

  document.body.className="";

  if(full){
    mouth.disabled=false;
  }
}

/* UTIL */
function getRMS(data){
  let sum=0;
  for(let i=0;i<data.length;i++){
    let v=(data[i]-128)/128;
    sum+=v*v;
  }
  return Math.sqrt(sum/data.length);
}

function avg(a){
  return a.reduce((x,y)=>x+y,0)/a.length;
}
