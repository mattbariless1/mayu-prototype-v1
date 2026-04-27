const SUPABASE_URL = 'https://lnxgiuebbdoaqlmeyujj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SNWgZmd5pTlRQJ601FGG7A_5t3vEXea';
const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let mediaRecorder;
let audioChunks = [];
let audioPlayer = new Audio();
let selectedFileUrl = null;

const recordBtn = document.getElementById('recordBtn');
const status = document.getElementById('status');

// 1. Handle Recording
recordBtn.onclick = async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        recordBtn.innerText = "Record";
        return;
    }

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

    // Auto-stop after 60 seconds
    setTimeout(() => {
        if (mediaRecorder.state === "recording") mediaRecorder.stop();
    }, 60000);
};

// 2. Upload Logic
async function uploadToSupabase(blob) {
    const fileName = `voice_${Date.now()}.wav`;
    
    const { data, error } = await supabase.storage
        .from('mayu-recordings')
        .upload(fileName, blob);

    if (error) return alert("Upload error");

    const { data: { publicUrl } } = supabase.storage
        .from('mayu-recordings')
        .getPublicUrl(fileName);

    await supabase.from('recordings').insert([{ 
        label: `Recording ${new Date().toLocaleTimeString()}`, 
        file_url: publicUrl 
    }]);

    status.innerText = "Saved.";
    fetchRecordings();
}

// 3. Fetch & List Logic
async function fetchRecordings() {
    const { data } = await supabase.from('recordings').select('*').order('created_at', { ascending: false });
    const list = document.getElementById('recordingsList');
    list.innerHTML = data.map(rec => `
        <div class="recording-item">
            <input type="checkbox" name="rec-select" value="${rec.file_url}" onchange="handleSelect(this)">
            <span>${rec.label}</span>
        </div>
    `).join('');
}

// Ensure only one checkbox is selected
window.handleSelect = (checkbox) => {
    const checkboxes = document.getElementsByName('rec-select');
    checkboxes.forEach((item) => { if (item !== checkbox) item.checked = false; });
    selectedFileUrl = checkbox.checked ? checkbox.value : null;
};

// 4. Playback Logic
document.getElementById('playBtn').onclick = () => {
    if (!selectedFileUrl) return alert("Please select a recording first.");
    audioPlayer.src = selectedFileUrl;
    audioPlayer.play();
};

document.getElementById('stopBtn').onclick = () => audioPlayer.pause();

fetchRecordings(); // Initial load