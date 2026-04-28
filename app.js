/**
 * MAYU PROTOTYPE V1 - RECONCILED APP.JS
 * Includes: Supabase Storage/DB, Local RNBO Media, and Cloud Mix Engine
 */

// --- 1. CONFIGURATION ---
const SUPABASE_URL = 'https://lnxgiuebbdoaqlmeyujj.supabase.co'; 
const SUPABASE_KEY = 'sb_publishable_SNWgZmd5pTlRQJ601FGG7A_5t3vEXea'; 
const mayuDb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// --- 2. GLOBAL STATE ---
let mediaRecorder;
let audioChunks = [];
let audioPlayer = new Audio(); // For basic previewing
let selectedFileUrl = null;

// RNBO State
let rnboDevice;
let audioContext;
let mixIsPlaying = false;

// UI Elements
const status = document.getElementById('status');
const recordBtn = document.getElementById('recordBtn');
const playMixBtn = document.getElementById('playMixBtn');

// ==========================================
// 3. RNBO ENGINE (The Back-End)
// ==========================================

async function setupRNBO() {
    try {
        const WAContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new WAContext();

        // Load the patcher export
        const response = await fetch('mayu-prototype-v1.export.json');
        const patcher = await response.json();

        // Create the RNBO Device
        rnboDevice = await RNBO.createDevice({ context: audioContext, patcher });
        rnboDevice.node.connect(audioContext.destination);

        // Standard Loader: Handles local files in /media folder via dependencies.json
        status.innerText = "Loading ambient tracks...";
        await rnboDevice.loadDependencies(); 
        
        setupParamListeners();
        status.innerText = "DSP Ready";
    } catch (err) {
        console.error("RNBO Setup Error:", err);
        status.innerText = "DSP Error: Check Console";
    }
}

// Manual helper for the dynamic Supabase recordings
async function loadCloudAudio(url, bufferId) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    await rnboDevice.setDataBuffer(bufferId, audioBuffer);
}

function setupParamListeners() {
    const selector = document.getElementById('ambientSelect');
    if (selector) {
        selector.onchange = (e) => {
            if (rnboDevice) {
                const param = rnboDevice.parametersById.get("which_ambient");
                if (param) param.value = parseFloat(e.target.value);
            }
        };
    }
}

// ==========================================
// 4. MIX PLAYBACK LOGIC
// ==========================================

playMixBtn.onclick = async () => {
    if (!selectedFileUrl) return alert("Please select a recording from the list first.");
    
    // Lazy-load RNBO on first interaction
    if (!rnboDevice) await setupRNBO();
    
    // Resume context (required by browsers)
    if (audioContext.state === 'suspended') await audioContext.resume();

    if (!mixIsPlaying) {
        status.innerText = "Syncing cloud recording...";
        
        try {
            // Inject the selected Supabase file into the voice buffer
            await loadCloudAudio(selectedFileUrl, 'voice_trk');
            
            mixIsPlaying = true;
            rnboDevice.parametersById.get("mix_state").value = 1;
            playMixBtn.innerText = "Stop Mayu Mix";
            status.innerText = "Mix Playing!";
        } catch (err) {
            console.error("Sync Error:", err);
            status.innerText = "Sync Failed (CORS?)";
        }
    } else {
        // Toggle Stop
        mixIsPlaying = false;
        rnboDevice.parametersById.get("mix_state").value = 0;
        playMixBtn.innerText = "Play Mayu Mix";
        status.innerText = "Ready";
    }
};

// ==========================================
// 5. RECORDING & SUPABASE UPLOAD
// ==========================================

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
            status.innerText = "Uploading to Cloud...";
            const blob = new Blob(audioChunks, { type: 'audio/wav' });
            await uploadToSupabase(blob);
        };

        mediaRecorder.start();
        recordBtn.innerText = "Stop";
        status.innerText = "Recording... (60s limit)";

        // Auto-stop at 60s
        setTimeout(() => {
            if (mediaRecorder.state === "recording") mediaRecorder.stop();
        }, 60000);

    } catch (err) {
        console.error("Mic Access Denied:", err);
        status.innerText = "Error: Mic access denied.";
    }
};

async function uploadToSupabase(blob) {
    const fileName = `voice_${Date.now()}.wav`;
    
    const { data, error: storageError } = await mayuDb.storage
        .from('mayu-recordings')
        .upload(fileName, blob);

    if (storageError) {
        console.error("Upload Error:", storageError);
        return status.innerText = "Upload failed.";
    }

    const { data: { publicUrl } } = mayuDb.storage
        .from('mayu-recordings')
        .getPublicUrl(fileName);

    const { error: dbError } = await mayuDb.from('recordings').insert([{ 
        label: `Recording ${new Date().toLocaleTimeString()}`, 
        file_url: publicUrl 
    }]);

    if (dbError) console.error("Database Log Error:", dbError);

    status.innerText = "Saved.";
    fetchRecordings(); // Refresh the list
}

// ==========================================
// 6. REPOSITORY UI (Fetch, Rename, Delete)
// ==========================================

async function fetchRecordings() {
    const { data, error } = await mayuDb
        .from('recordings')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return console.error("Fetch Error:", error);

    const list = document.getElementById('recordingsList');
    list.innerHTML = data.map(rec => `
        <div class="recording-item" id="rec-${rec.id}">
            <input type="checkbox" name="rec-select" value="${rec.file_url}" onchange="handleSelect(this)">
            <span class="rec-label">${rec.label}</span>
            <div class="item-actions">
                <button onclick="renameRecording('${rec.id}', '${rec.label}')" class="btn-icon">✎</button>
                <button onclick="deleteRecording('${rec.id}', '${rec.file_url}')" class="btn-icon delete">✕</button>
            </div>
        </div>
    `).join('');
}

// Maintain single-selection for the mix
window.handleSelect = (checkbox) => {
    const checkboxes = document.getElementsByName('rec-select');
    checkboxes.forEach((item) => { if (item !== checkbox) item.checked = false; });
    selectedFileUrl = checkbox.checked ? checkbox.value : null;
};

window.renameRecording = async (id, oldLabel) => {
    const newLabel = window.prompt("Enter new name:", oldLabel);
    if (newLabel && newLabel !== oldLabel) {
        const { error } = await mayuDb.from('recordings').update({ label: newLabel }).eq('id', id);
        if (error) alert("Rename failed.");
        fetchRecordings();
    }
};

window.deleteRecording = async (id, fileUrl) => {
    if (!confirm("Are you sure you want to delete this?")) return;
    const fileName = fileUrl.split('/').pop();

    await mayuDb.storage.from('mayu-recordings').remove([fileName]);
    await mayuDb.from('recordings').delete().eq('id', id);
    fetchRecordings();
};

// --- Initial Load ---
document.getElementById('stopBtn').onclick = () => {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
};

fetchRecordings();