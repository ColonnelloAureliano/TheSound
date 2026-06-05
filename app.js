let audioContext;
let analyser;
let dataArray;

let running = false;

const btn = document.getElementById("startBtn");
const status = document.getElementById("status");
const level = document.getElementById("level");

btn.addEventListener("click", async () => {

    if (running) return;

    try {
        status.innerText = "Avvio microfono...";

        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        const source = audioContext.createMediaStreamSource(stream);

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;

        source.connect(analyser);

        dataArray = new Uint8Array(analyser.frequencyBinCount);

        running = true;

        document.body.classList.add("active");
        status.innerText = "Ascolto...";

        detect();

        // stop automatico dopo 10 secondi
        setTimeout(() => {
            running = false;
            document.body.classList.remove("active");
            status.innerText = "Finito";
        }, 10000);

    } catch (err) {
        alert("Errore microfono (usa HTTPS e consenti permessi)");
        console.error(err);
    }

});

function detect() {
    if (!running) return;

    analyser.getByteFrequencyData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }

    let avg = sum / dataArray.length;

    level.innerText = Math.round(avg);

    requestAnimationFrame(detect);
}
