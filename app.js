/**
 * MAYU PROTOTYPE V1 - FINAL UI LAYOUT
 */

document.addEventListener('DOMContentLoaded', () => {
    
    // --- 1. CONFIGURATION ---
    const SUPABASE_URL = 'https://lnxgiuebbdoaqlmeyujj.supabase.co'; 
    const SUPABASE_KEY = 'sb_publishable_SNWgZmd5pTlRQJ601FGG7A_5t3vEXea'; 
    const mayuDb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    // --- 2. GLOBAL STATE ---
    let mediaRecorder;
    let audioChunks = [];
    let audioPlayer = new Audio(); 
    let selectedFileUrl = null;
    let rnboDevice;
    let audioContext;

    // UI Elements
    const status = document.getElementById('status');
    const recordBtn = document.getElementById('recordBtn');
    const mixToggle = document.getElementById('mixToggle');
    const playBtn = document.getElementById('playBtn'); 
    const stopBtn = document.getElementById('stopBtn'); 
    const listContainer = document.getElementById('recordingsList');

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

            console.log("Loading ambient tracks...");
            const depResponse = await fetch('dependencies.json');
            const dependencies = await depResponse.json();

            for (const dep of dependencies) {
                const fileUrl = dep.file.startsWith('media/') ? dep.file : `media/${dep.file}`;
                await loadAudioIntoBuffer(fileUrl, dep.id);
            }
            
            syncAmbientSelection();
            setupParamListeners();
            console.log("DSP Ready");
        } catch (err) {
            console.error("RNBO Setup Error:", err);
        }
    }

    async function loadAudioIntoBuffer(url, bufferId) {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        await rnboDevice.setDataBuffer(bufferId, audioBuffer);
    }

    function syncAmbientSelection() {
        const selector = document.getElementById('ambientSelect');
        if (selector && rnboDevice) {
            const param = rnboDevice.parametersById.get("which_ambient");
            if (param) param.value = parseFloat(selector.value);
        }
    }

    function setupParamListeners() {
        const selector = document.getElementById('ambientSelect');
        if (selector) selector.onchange = () => syncAmbientSelection();
    }

    // ==========================================
    // 4. PLAYBACK & MIX LOGIC 
    // ==========================================

    // Audition (Preview)
    playBtn.onclick = () => {
        if (!selectedFileUrl) return alert("Please select a recording to audition.");
        audioPlayer.src = selectedFileUrl;
        audioPlayer.play();
    };

    // Mayu Mix Toggle
    mixToggle.onchange = async (e) => {
        if (!selectedFileUrl) {
            alert("Please select a recording first.");
            e.target.checked = false;
            return;
        }

        if (!rnboDevice) await setupRNBO();
        if (audioContext.state === 'suspended') await audioContext.resume();

        const state = e.target.checked ? 1 : 0;
        
        if (state === 1) {
            await loadAudioIntoBuffer(selectedFileUrl, 'voice_trk');
            rnboDevice.parametersById.get("mix_state").value = 1;
        } else {
            rnboDevice.parametersById.get("mix_state").value = 0;
        }
    };

    // Universal Stop
    stopBtn.onclick = () => {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
        if (rnboDevice) {
            rnboDevice.parametersById.get("mix_state").value = 0;
            mixToggle.checked = false; 
        }
    };

    // ==========================================
    // 5. RECORDING & SUPABASE 
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
                status.innerText = "Uploading...";
                const blob = new Blob(audioChunks, { type: 'audio/wav' });
                await uploadToSupabase(blob);
            };
            mediaRecorder.start();
            recordBtn.innerText = "Stop";
            status.innerText = "Recording...";
        } catch (err) {
            status.innerText = "Mic access denied.";
        }
    };

    async function uploadToSupabase(blob) {
        const fileName = `voice_${Date.now()}.wav`;
        const { error } = await mayuDb.storage.from('mayu-recordings').upload(fileName, blob);
        if (error) return status.innerText = "Upload failed.";
        const { data: { publicUrl } } = mayuDb.storage.from('mayu-recordings').getPublicUrl(fileName);
        await mayuDb.from('recordings').insert([{ label: `Recording ${new Date().toLocaleTimeString()}`, file_url: publicUrl }]);
        
        status.innerText = "Saved.";
        fetchRecordings();
    }

    // ==========================================
    // 6. REPOSITORY UI
    // ==========================================

    async function fetchRecordings() {
        const { data, error } = await mayuDb.from('recordings').select('*').order('created_at', { ascending: false });
        if (error || !data) return;

        listContainer.innerHTML = data.map(rec => `
            <div class="recording-item" id="rec-${rec.id}">
                <input type="checkbox" name="rec-select" value="${rec.file_url}" onchange="handleSelectInternal(this)">
                <span class="rec-label">${rec.label}</span>
                <div class="item-actions">
                    <button onclick="renameRecording('${rec.id}', '${rec.label}')" class="btn-icon">✎</button>
                    <button onclick="deleteRecording('${rec.id}', '${rec.file_url}')" class="btn-icon delete">✕</button>
                </div>
            </div>
        `).join('');
    }

    window.handleSelectInternal = (checkbox) => {
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
        if (!confirm("Delete?")) return;
        const fileName = fileUrl.split('/').pop();
        await mayuDb.storage.from('mayu-recordings').remove([fileName]);
        await mayuDb.from('recordings').delete().eq('id', id);
        fetchRecordings();
    };

    fetchRecordings();
    const exportBtn = document.getElementById('exportWavBtn');
    const exportStatus = document.getElementById('exportStatus');

    exportBtn.onclick = async () => {
        if (!selectedFileUrl) return alert("Please select a recording to export.");
        
        exportStatus.innerText = "Initializing Render Engine...";
        
        // 1. Setup the 10-minute "Headless" Context
        const renderLengthSeconds = 600; 
        const sampleRate = 48000;
        const lengthSamples = renderLengthSeconds * sampleRate;
        const offlineContext = new OfflineAudioContext(2, lengthSamples, sampleRate);

        // 2. Instantiate a second, invisible RNBO device
        const response = await fetch('mayu-prototype-v1.export.json');
        const patcher = await response.json();
        const renderDevice = await RNBO.createDevice({ context: offlineContext, patcher });
        renderDevice.node.connect(offlineContext.destination);

        // 3. Load the Ambient & Voice files into the Render Device
        exportStatus.innerText = "Loading assets into memory...";
        const ambientId = `ambient_trk_${document.getElementById('ambientSelect').value}`;
        
        // Helper to load specifically into the offline context
        const loadToOffline = async (url, bufferId) => {
            const res = await fetch(url);
            const arrayBuf = await res.arrayBuffer();
            const audioBuf = await offlineContext.decodeAudioData(arrayBuf);
            await renderDevice.setDataBuffer(bufferId, audioBuf);
        };

        await loadToOffline(`media/${ambientId}.wav`, ambientId);
        await loadToOffline(selectedFileUrl, 'voice_trk');

        exportStatus.innerText = "Render Engine Ready. Ready for scheduling?";
        console.log("Offline device initialized:", renderDevice);
    };
});