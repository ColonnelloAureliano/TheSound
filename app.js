const mouth = document.getElementById("mouth");
const feedback = document.getElementById("feedback");
const bar = document.getElementById("bar");
const statusText = document.getElementById("status");

let analyser, audioCtx, source, stream;

let listening = false;
let pattern = [];
let signalOn = false;
let startTime = 0;

let firstSound = true;

/* ✅ calibrazione */
let noiseSamples = [];
let noiseFloor = 0;

/* ✅ auto adattivo */
let dotDurations = [];
let avgDot = 0;

/* COSTANTI */
const MIN_SOUND = 300;       // < 0.3s ignorato
const MIN_LINE = 1000;       // minimo linea

mouth.onclick = async () => {
  reset();

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  source = audioCtx.createMediaStreamSource(stream);

  source.connect(analyser);

  document.body.classList.add("open","show-dot","scan");

  statusText.innerText = "FAI SILENZIO";

  calibrateNoise();
};

/* ✅ CALIBRAZIONE */
function calibrateNoise(){
  const data = new Uint8Array(analyser.fftSize);
  let start = Date.now();

  function loop(){
    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i=0;i<data.length;i++){
      let v=(data[i]-128)/128;
      sum += v*v;
    }

    let rms = Math.sqrt(sum/data.length);
    noiseSamples.push(rms);

    if(Date.now() - start < 3000){
      requestAnimationFrame(loop);
    } else {

      noiseFloor = noiseSamples.reduce((a,b)=>a+b,0)/noiseSamples.length;

      startGame();
    }
  }

  loop();
}

/* ✅ START GAME */
function startGame(){

  document.body.classList.remove("scan");
  document.body.classList.add("red");
  statusText.innerText = "";

  startListening();
  startTimer();

  setTimeout(checkResult, 10000);
}

/* ✅ TIMER */
function startTimer(){
  let start = Date.now();

  function update(){
    let elapsed = Date.now()-start;
    bar.style.width = (elapsed/10000*100)+"%";
    if(elapsed<10000) requestAnimationFrame(update);
  }

  update();
}

/* ✅ DETECTION */
function startListening(){

  listening = true;
  const data = new Uint8Array(analyser.fftSize);

  function loop(){
    if(!listening) return;

    analyser.getByteTimeDomainData(data);

    let sum=0;
    for(let i=0;i<data.length;i++){
      let v=(data[i]-128)/128;
      sum += v*v;
    }

    let rms = Math.sqrt(sum/data.length);

    /* ✅ soglia robusta */
    let threshold = noiseFloor * 4;

    let isSound = rms > threshold;
    let now = performance.now();

    if(isSound && !signalOn){
      signalOn = true;
      startTime = now;
    }

    if(!isSound && signalOn){
      signalOn = false;

      let duration = now - startTime;

      /* ✅ ignora micro rumori */
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
          avgDot = dotDurations.reduce((a,b)=>a+b,0)/dotDurations.length;
        }

        let dynamicThreshold = Math.max(avgDot*2, MIN_LINE);

        if(duration > dynamicThreshold){
          symbol='-';
        } else{
          symbol='.';
          dotDurations.push(duration);
        }
      }

      pattern.push(symbol);
      feedback.innerText = pattern.join(" ");

      if(pattern.length === 4){
        listening=false;
      }
    }

    requestAnimationFrame(loop);
  }

  loop();
}

/* ✅ CHECK FINALE */
function checkResult(){
  listening=false;

  if(pattern.join('')==="..--"){
    document.body.classList.add("success");
  } else{
    reset();
  }
}

/* ✅ RESET */
function reset(){
  pattern=[];
  firstSound=true;
  dotDurations=[];
  noiseSamples=[];
  noiseFloor=0;
  avgDot=0;

  feedback.innerText="";
  statusText.innerText="";
  bar.style.width="0%";

  document.body.className="";
}
