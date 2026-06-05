let audioContext;
let analyser;
let microphone;
let dataArray;

let isRunning = false;
let countdownActive = false;

const btn = document.getElementById("startBtn");
const status = document.getElementById("status");
const levelEl = document.getElementById("level");

btn.addEventListener("click", async () => {

    // ✅ BLOCCO CLICK DURANTE I 10s
    if (countdownActive) return;

    try {
        status.innerText = "Richiesta microfono...";

        // ✅ AudioContext creato dentro click (iOS FIX)
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }

        // ✅ piccolo hack iOS
        const osc = audioContext.createOscillator();
        osc.start();
        osc.stop();

        // ✅ richiesta microfono
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        microphone = audioContext.createMediaStreamSource(stream);

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;

        microphone.connect(analyser);

        dataArray = new Uint8Array(analyser.frequencyBinCount);

        isRunning = true;

        startCountdown();
        detectAudio();

        console.log("✅ Microfono attivo (iOS OK)");

    } catch (err) {
        console.error(err);
        alert("Errore accesso microfono.\nUsa HTTPS e consenti i permessi!");
    }

});

function startCountdown() {
    countdownActive = true;

    document.body.classList.add("red");
    status.innerText = "🎤 Ascolto (10s)";

    setTimeout(() => {
        countdownActive = false;
        document.body.classList.remove("red");
        status.innerText = "Fine ascolto - riprova";

    }, 10000);
}

function detectAudio() {

    function loop() {

        if (!isRunning) return;

        analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }

        let avg = sum / dataArray.length;

        levelEl.innerText = avg.toFixed(0);

        // ✅ soglia base semplice (poi miglioriamo)
        if (avg > 60) {
            status.innerText = "🔊 Suono rilevato";
        }

        requestAnimationFrame(loop);
    }

    loop();
}
