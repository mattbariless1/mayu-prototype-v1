// --- 1. CONFIGURATION ---
const SUPABASE_URL = 'https://lnxgiuebbdoaqlmeyujj.supabase.co'; 
const SUPABASE_KEY = 'YOUR_PUBLISHABLE_KEY_HERE'; 
const mayuDb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// --- 2. GLOBAL STATE ---
let mediaRecorder;
let audioChunks = [];
let audioPlayer = new Audio(); 
let selectedFileUrl = null;

let rnboDevice;
let audioContext;
let mixIsPlaying = false;

const status = document.getElementById('status');
const recordBtn = document.getElementById('recordBtn');
const playMixBtn = document.getElementById('playMixBtn');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');

// ==========================================
// 3. RNBO ENGINE
// ==========================================

async function setupRNBO() {
    try {
        const WAContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new WAContext();

        const response = await fetch('mayu-prototype-v1.export.json');
        const patcher = await response.json();

        rnboDevice = await RNBO.createDevice({ context: audioContext, patcher });
        rnboDevice.node.connect(audioContext.destination);

        // Manually load dependencies to avoid 'loadDependencies is not a function' error
        status.innerText = "Loading ambient tracks...";
        const depResponse = await fetch('dependencies.json');
        const dependencies = await depResponse.json();

        for (const dep of dependencies) {
            // Ensure we are pointing to the /media folder
            const fileUrl = dep.file.startsWith('media/') ? dep.file : `media/${dep.file}`;
            await loadAudioIntoBuffer(fileUrl, dep.id);
        }
        
        setupParamListeners();
        status.innerText = "DSP Ready";
    } catch (err) {
        console.error("RNBO Setup Error:", err);
        status.innerText = "DSP Error: Check Console";
    }
}

async function loadAudioIntoBuffer(url, bufferId) {
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
// 4. PLAYBACK & MIX LOGIC
// ==========================================

// Preview only (Standard Browser Audio)
playBtn.onclick = () => {
    if (!selectedFileUrl) return alert("Please select a recording first.");
    
    // Stop the mix if it's playing to avoid cacophony
    if (mixIsPlaying) stopMix();
    
    audioPlayer.src = selectedFileUrl;
    audioPlayer.play();
    status.innerText = "Previewing recording...";
};

// Full RNBO Mix
playMixBtn.onclick = async () => {
    if (!selectedFileUrl) return alert("Please select a recording from the list first.");
    
    if (!rnboDevice) await setupRNBO();
    if (audioContext.state === 'suspended') await audioContext.resume();

    if (!mixIsPlaying) {
        status.innerText = "Syncing cloud recording...";
        try {
            await loadAudioIntoBuffer(selectedFileUrl, 'voice_trk');
            mixIsPlaying = true;
            rnboDevice.parametersById.get("mix_state").value = 1;
            playMixBtn.innerText = "Stop Mayu Mix";
            status.innerText = "Mix Playing!";
        } catch (err) {
            console.error("Sync Error:", err);
            status.innerText = "Sync Failed (CORS?)";
        }
    } else {
        stopMix();
    }
};

function stopMix() {
    if (rnboDevice) {
        mixIsPlaying = false;
        rnboDevice.parametersById.get("mix_state").value = 0;
        playMixBtn.innerText = "Play Mayu Mix";
        status.innerText = "Ready";
    }
}

stopBtn.onclick = () => {
    // Stops both standard preview and RNBO mix
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    if (mixIsPlaying) stopMix();
};

// ==========================================
// 5. RECORDING & CRUD (Supabase)
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
        status.innerText = "Recording...";
        setTimeout(() => { if (mediaRecorder.state === "recording") mediaRecorder.stop(); }, 60000);
    } catch (err) {
        status.innerText = "Error: Mic access denied.";
    }
};

async function uploadToSupabase(blob) {
    const fileName = `voice_${Date.now()}.wav`;
    const { error: storageError } = await mayuDb.storage.from('mayu-recordings').upload(fileName, blob);
    if (storageError) return status.innerText = "Upload failed.";

    const { data: { publicUrl } } = mayuDb.storage.from('mayu-recordings').getPublicUrl(fileName);
    await mayuDb.from('recordings').insert([{ 
        label: `Recording ${new Date().toLocaleTimeString()}`, 
        file_url: publicUrl 
    }]);

    status.innerText = "Saved.";
    fetchRecordings();
}

async function fetchRecordings() {
    const { data, error } = await mayuDb.from('recordings').select('*').order('created_at', { ascending: false });
    if (error) return;
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

window.handleSelect = (checkbox) => {
    const checkboxes = document.getElementsByName('rec-select');
    checkboxes.forEach((item) => { if (item !== checkbox) item.checked = false; });
    selectedFileUrl = checkbox.checked ? checkbox.value : null;
};

window.renameRecording = async (id, oldLabel) => {
    const newLabel = window.prompt("Enter new name:", oldLabel);
    if (newLabel && newLabel !== oldLabel) {
        await mayuDb.from('recordings').update({ label: newLabel }).eq('id', id);
        fetchRecordings();
    }
};

window.deleteRecording = async (id, fileUrl) => {
    if (!confirm("Are you sure?")) return;
    const fileName = fileUrl.split('/').pop();
    await mayuDb.storage.from('mayu-recordings').remove([fileName]);
    await mayuDb.from('recordings').delete().eq('id', id);
    fetchRecordings();
};

fetchRecordings();