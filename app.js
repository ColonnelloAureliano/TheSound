const mouth = document.getElementById("mouth");
const feedback = document.getElementById("feedback");
const statusText = document.getElementById("status");
const bar = document.getElementById("bar");

let analyser, audioCtx, source, stream;

let listening = false;
let pattern = [];

let signalOn = false;
let startTime = 0;
let silentStart = 0;

/* ✅ HOLD-OFF */
const SILENCE_HOLD = 150; // ms

/* ✅ soglie */
const MIN_SOUND = 300;
const MIN_LINE = 1000;

let noiseFloor = 0;
let noiseSamples = [];

let firstSound = true;
let dotDurations = [];
let avgDot = 0;

mouth.onclick = async () => {
  reset();

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  source = audioCtx.createMediaStreamSource(stream);

  source.connect(analyser);

  document.body.classList.add("open","show-dot","scan");

  statusText.innerText = "FAI SILENZIO";

  calibrate();
};

function calibrate(){
  const data = new Uint8Array(analyser.fftSize);
  let start = Date.now();

  function loop(){
    analyser.getByteTimeDomainData(data);

    let rms = getRMS(data);
    noiseSamples.push(rms);

    if(Date.now()-start < 3000){
      requestAnimationFrame(loop);
    } else {
      noiseFloor = avg(noiseSamples);
      startGame();
    }
  }

  loop();
}

function startGame(){
  document.body.classList.remove("scan");
  document.body.classList.add("red");
  statusText.innerText="";

  startListening();
  startTimer();

  setTimeout(checkResult,10000);
}

function startTimer(){
  let start = Date.now();
  function loop(){
    let t = Date.now()-start;
    bar.style.width = (t/10000*100)+"%";
    if(t<10000) requestAnimationFrame(loop);
  }
  loop();
}

/* ✅ DETECTION STABILE */
function startListening(){
  listening = true;
  const data = new Uint8Array(analyser.fftSize);

  function loop(){
    if(!listening) return;

    analyser.getByteTimeDomainData(data);

    let rms = getRMS(data);
    let threshold = noiseFloor * 4;

    let isSound = rms > threshold;
    let now = performance.now();

    if(isSound){
      if(!signalOn){
        signalOn = true;
        startTime = now;
      }
      silentStart = 0;
    }

    if(!isSound && signalOn){

      // ✅ aspetta silenzio stabile
      if(!silentStart) silentStart = now;

      if(now - silentStart > SILENCE_HOLD){

        signalOn = false;

        let duration = silentStart - startTime;

        if(duration < MIN_SOUND){
          requestAnimationFrame(loop);
          return;
        }

        let symbol;

        if(firstSound){
          symbol='.';
          firstSound=false;
          dotDurations.push(duration);
        } else {

          if(dotDurations.length>=2){
            avgDot = avg(dotDurations);
          }

          let dyn = Math.max(avgDot*2, MIN_LINE);

          if(duration > dyn){
            symbol='-';
          } else {
            symbol='.';
            dotDurations.push(duration);
          }
        }

        pattern.push(symbol);

        // ✅ FEEDBACK COMPLETO
        feedback.innerText += ` ${symbol}(${Math.round(duration)}ms)`;

        if(pattern.length === 4){
          listening=false;
        }
      }
    }

    requestAnimationFrame(loop);
  }

  loop();
}

function checkResult(){
  listening=false;

  if(pattern.join('')==="..--"){
    document.body.classList.add("success");
  } else {
    reset();
  }
}

function reset(){
  pattern=[];
  firstSound=true;
  dotDurations=[];
  noiseSamples=[];
  avgDot=0;
  noiseFloor=0;

  feedback.innerText="";
  statusText.innerText="";
  bar.style.width="0%";

  document.body.className="";
}

/* utility */
function getRMS(data){
  let sum=0;
  for(let i=0;i<data.length;i++){
    let v=(data[i]-128)/128;
    sum+=v*v;
  }
  return Math.sqrt(sum/data.length);
}

function avg(arr){
  return arr.reduce((a,b)=>a+b,0)/arr.length;
}
