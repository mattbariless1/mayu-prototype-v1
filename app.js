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

        // 2. Instantiate the Render Device
        const response = await fetch('mayu-prototype-v1.export.json');
        const patcher = await response.json();
        const renderDevice = await RNBO.createDevice({ context: offlineContext, patcher });
        renderDevice.node.connect(offlineContext.destination);

        // 3. Load Assets
        exportStatus.innerText = "Loading assets into memory...";
        const ambientId = `ambient_trk_${document.getElementById('ambientSelect').value}`;
        
        const loadToOffline = async (url, bufferId) => {
            const res = await fetch(url);
            const arrayBuf = await res.arrayBuffer();
            const audioBuf = await offlineContext.decodeAudioData(arrayBuf);
            await renderDevice.setDataBuffer(bufferId, audioBuf);
        };

        await loadToOffline(`media/${ambientId}.wav`, ambientId);
        await loadToOffline(selectedFileUrl, 'voice_trk');

        // 4. SCHEDULE THE START
        // We send the 'mix_state' = 1 event at time 0 (sample 0)
        const mixParam = renderDevice.parametersById.get("mix_state");
        mixParam.setValueAtTime(1, 0); 
        
        // Ensure the correct ambient track is selected in the render engine
        const ambientParam = renderDevice.parametersById.get("which_ambient");
        ambientParam.setValueAtTime(parseFloat(document.getElementById('ambientSelect').value), 0);

        // 5. THE BIG CRUNCH (Rendering)
        exportStatus.innerText = "Rendering 10-minute soundscape... (Processing)";
        const startTime = performance.now();

        const renderedBuffer = await offlineContext.startRendering();
        
        const endTime = performance.now();
        console.log(`Render complete in ${((endTime - startTime)/1000).toFixed(2)} seconds.`);

        // 6. CONVERT TO WAV & DOWNLOAD
        exportStatus.innerText = "Encoding WAV...";
        const wavBlob = bufferToWav(renderedBuffer);
        const url = URL.createObjectURL(wavBlob);
        
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `mayu_render_${Date.now()}.wav`;
        anchor.click();
        
        exportStatus.innerText = "Download Complete!";
    };

    // --- WAV ENCODING HELPER ---
    // This takes the raw AudioBuffer and adds the header info so it opens in iTunes/Quicktime
    function bufferToWav(abuffer) {
        let numOfChan = abuffer.numberOfChannels,
            length = abuffer.length * numOfChan * 2 + 44,
            buffer = new ArrayBuffer(length),
            view = new DataView(buffer),
            channels = [], i, sample,
            offset = 0,
            pos = 0;

        // Write WAV header
        setUint32(0x46464952);                         // "RIFF"
        setUint32(length - 8);                         // file length - 8
        setUint32(0x45564157);                         // "WAVE"
        setUint32(0x20746d66);                         // "fmt " chunk
        setUint32(16);                                 // length = 16
        setUint16(1);                                  // PCM (uncompressed)
        setUint16(numOfChan);
        setUint32(abuffer.sampleRate);
        setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
        setUint16(numOfChan * 2);                      // block-align
        setUint16(16);                                 // 16-bit
        setUint32(0x61746164);                         // "data" - chunk
        setUint32(length - pos - 4);                   // chunk length

        // Write interleaved samples
        for(i = 0; i < abuffer.numberOfChannels; i++)
            channels.push(abuffer.getChannelData(i));

        while(pos < length) {
            for(i = 0; i < numOfChan; i++) {             // interleave channels
                sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
                sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF); // scale to 16-bit signed int
                view.setInt16(pos, sample, true);          // write 16-bit sample
                pos += 2;
            }
            offset++;                                     // next sample chunk
        }

        return new Blob([buffer], {type: "audio/wav"});

        function setUint16(data) {
            view.setUint16(pos, data, true);
            pos += 2;
        }

        function setUint32(data) {
            view.setUint32(pos, data, true);
            pos += 4;
        }
    }
});