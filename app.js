// 1. Configuration
const SUPABASE_URL = 'https://lnxgiuebbdoaqlmeyujj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SNWgZmd5pTlRQJ601FGG7A_5t3vEXea'; // Replace with your actual key

// Initialize the client with a unique name 'mayuDb'
const mayuDb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let mediaRecorder;
let audioChunks = [];
let audioPlayer = new Audio();
let selectedFileUrl = null;

const recordBtn = document.getElementById('recordBtn');
const status = document.getElementById('status');

// 2. Recording Logic
recordBtn.onclick = async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        recordBtn.innerText = "Record";
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        
        mediaRecorder.onstop = async () => {
            status.innerText = "Uploading to Mayu Cloud...";
            const blob = new Blob(audioChunks, { type: 'audio/wav' });
            await uploadToSupabase(blob);
        };

        mediaRecorder.start();
        recordBtn.innerText = "Stop";
        status.innerText = "Recording... (60s limit)";

        // Safety limit
        setTimeout(() => {
            if (mediaRecorder.state === "recording") mediaRecorder.stop();
        }, 60000);

    } catch (err) {
        console.error("Microphone access denied:", err);
        status.innerText = "Error: Mic access denied.";
    }
};

// 3. Backend Logic (Upload & Log)
async function uploadToSupabase(blob) {
    const fileName = `voice_${Date.now()}.wav`;
    status.innerText = "Uploading...";

    console.log("Attempting upload to bucket: mayu-recordings");

    const { data, error } = await mayuDb.storage
        .from('mayu-recordings')
        .upload(fileName, blob);

    if (error) {
        console.error("Upload failed details:", error);
        return status.innerText = `Upload Error: ${error.message}`;
    }

    console.log("Upload successful, logging to database...");

    const { data: { publicUrl } } = mayuDb.storage
        .from('mayu-recordings')
        .getPublicUrl(fileName);

    const { error: dbError } = await mayuDb.from('recordings').insert([{ 
        label: `Recording ${new Date().toLocaleTimeString()}`, 
        file_url: publicUrl 
    }]);

    if (dbError) {
        console.error("Database Log Error:", dbError);
        return status.innerText = "File uploaded, but listing failed.";
    }

    status.innerText = "Saved.";
    fetchRecordings();
}

// 4. Interface Logic (Fetch & List)
async function fetchRecordings() {
    const { data, error } = await mayuDb
        .from('recordings')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return console.error("Fetch Error:", error);

    const list = document.getElementById('recordingsList');
    list.innerHTML = data.map(rec => `
        <div class="recording-item">
            <input type="checkbox" name="rec-select" value="${rec.file_url}" onchange="handleSelect(this)">
            <span>${rec.label}</span>
        </div>
    `).join('');
}

// Handle single selection for playback
window.handleSelect = (checkbox) => {
    const checkboxes = document.getElementsByName('rec-select');
    checkboxes.forEach((item) => { if (item !== checkbox) item.checked = false; });
    selectedFileUrl = checkbox.checked ? checkbox.value : null;
};

// 5. Playback Logic
document.getElementById('playBtn').onclick = () => {
    if (!selectedFileUrl) return alert("Please select a recording first.");
    audioPlayer.src = selectedFileUrl;
    audioPlayer.play();
};

document.getElementById('stopBtn').onclick = () => {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
};

// Initial load of the list
fetchRecordings();