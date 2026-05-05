/**
 * MAYU PROTOTYPE V1 - PRODUCTION ENGINE (FINAL RECONCILED)
 * Uses native OfflineAudioContext suspend/resume scheduling to bypass RNBO constructor bugs.
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

    // UI Element Selections
    const status = document.getElementById('status');
    const recordBtn = document.getElementById('recordBtn');
    const mixToggle = document.getElementById('mixToggle');
    const playBtn = document.getElementById('playBtn'); // Audition
    const stopBtn = document.getElementById('stopBtn'); // ■
    const exportBtn = document.getElementById('exportWavBtn');
    const exportStatus = document.getElementById('exportStatus');
    const listContainer = document.getElementById('recordingsList');

    // ==========================================
    // 3. RNBO ENGINE (Real-time Playback)
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
                await loadAudioIntoBuffer(fileUrl, dep.id, rnboDevice, audioContext);
            }
            
            syncAmbientSelection();
            setupParamListeners();
            console.log("DSP Ready");
        } catch (err) {
            console.error("RNBO Setup Error:", err);
        }
    }

    async function loadAudioIntoBuffer(url, bufferId, device, context) {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer(); 
        const audioBuffer = await context.decodeAudioData(arrayBuffer);
        await device.setDataBuffer(bufferId, audioBuffer);
    }

    function syncAmbientSelection() {
        const selector = document.getElementById('ambientSelect');
        if (selector && rnboDevice) {
            const param = findParam(rnboDevice, "which_ambient");
            if (param) param.value = parseFloat(selector.value);
        }
    }

    function setupParamListeners() {
        const selector = document.getElementById('ambientSelect');
        if (selector) selector.onchange = () => syncAmbientSelection();
    }

    function findParam(device, searchStr) {
        return device.parameters.find(p => 
            p.id.toLowerCase().includes(searchStr.toLowerCase()) || 
            p.name.toLowerCase().includes(searchStr.toLowerCase())
        );
    }

    // ==========================================
    // 4. INTERFACE LOGIC (Audition & Mix)
    // ==========================================

    playBtn.onclick = () => {
        if (!selectedFileUrl) return alert("Please select a recording to audition.");
        audioPlayer.src = selectedFileUrl;
        audioPlayer.play();
    };

    mixToggle.onchange = async (e) => {
        if (!selectedFileUrl) {
            alert("Please select a recording first.");
            e.target.checked = false;
            return;
        }
        if (!rnboDevice) await setupRNBO();
        if (audioContext.state === 'suspended') await audioContext.resume();

        const mixParam = findParam(rnboDevice, "mix_state");
        if (e.target.checked) {
            await loadAudioIntoBuffer(selectedFileUrl, 'voice_trk', rnboDevice, audioContext);
            if (mixParam) mixParam.value = 1;
        } else {
            if (mixParam) mixParam.value = 0;
        }
    };

    stopBtn.onclick = () => {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
        if (rnboDevice) {
            const mixParam = findParam(rnboDevice, "mix_state");
            if (mixParam) mixParam.value = 0;
            mixToggle.checked = false; 
        }
    };

    // ==========================================
    // 5. PRODUCTION RENDER ENGINE
    // ==========================================

    exportBtn.onclick = async () => {
        if (!selectedFileUrl) return alert("Please select a recording to export.");
        
        exportStatus.innerText = "Initializing Render Engine...";
        
        try {
            const renderLengthSeconds = 600; 
            const sampleRate = 48000;
            const lengthSamples = renderLengthSeconds * sampleRate;
            const offlineContext = new OfflineAudioContext(2, lengthSamples, sampleRate);

            const response = await fetch('mayu-prototype-v1.export.json');
            const patcher = await response.json();
            const renderDevice = await RNBO.createDevice({ context: offlineContext, patcher });
            renderDevice.node.connect(offlineContext.destination);

            exportStatus.innerText = "Loading assets into memory...";
            const ambientId = `ambient_trk_${document.getElementById('ambientSelect').value}`;
            
            await loadAudioIntoBuffer(`media/${ambientId}.wav`, ambientId, renderDevice, offlineContext);
            await loadAudioIntoBuffer(selectedFileUrl, 'voice_trk', renderDevice, offlineContext);

            const pMix = findParam(renderDevice, "mix_state");
            const pAmb = findParam(renderDevice, "which_ambient");

            if (!pMix || !pAmb) throw new Error("Parameters not found.");

            // 4. ROBUST SUSPEND/RESUME SCHEDULING
            // Set initial state for time 0
            pAmb.value = parseFloat(document.getElementById('ambientSelect').value);
            pMix.value = 1; 

            // Schedule all future state changes by pausing the render, changing the value, and resuming
            for (let t = 0; t < renderLengthSeconds; t += 90) {
                const timeOff = t + 85; // 85 seconds
                const timeOn = t + 90;  // 90 seconds

                if (timeOff < renderLengthSeconds) {
                    offlineContext.suspend(timeOff).then(() => {
                        pMix.value = 0;
                        offlineContext.resume();
                    });
                }
                
                if (timeOn < renderLengthSeconds) {
                    offlineContext.suspend(timeOn).then(() => {
                        pMix.value = 1;
                        offlineContext.resume();
                    });
                }
            }

            exportStatus.innerText = "Rendering 10-minute soundscape... (Takes ~10s)";
            const startTime = performance.now();

            const renderedBuffer = await offlineContext.startRendering();
            
            const endTime = performance.now();
            console.log(`Render complete in ${((endTime - startTime)/1000).toFixed(2)} seconds.`);

            exportStatus.innerText = "Encoding WAV...";
            const wavBlob = bufferToWav(renderedBuffer);
            const url = URL.createObjectURL(wavBlob);
            
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `mayu_render_${Date.now()}.wav`;
            anchor.click();
            
            exportStatus.innerText = "Download Complete!";

        } catch (err) {
            console.error("Render Error:", err);
            exportStatus.innerText = "Render failed. Check console.";
        }
    };

    function bufferToWav(abuffer) {
        let numOfChan = abuffer.numberOfChannels,
            length = abuffer.length * numOfChan * 2 + 44,
            buffer = new ArrayBuffer(length),
            view = new DataView(buffer),
            channels = [], i, sample,
            offset = 0, pos = 0;

        function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

        setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
        setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
        setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan);
        setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - pos - 4);

        for(i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));
        while(pos < length) {
            for(i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][offset]));
                sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF);
                view.setInt16(pos, sample, true);
                pos += 2;
            }
            offset++;
        }
        return new Blob([buffer], {type: "audio/wav"});
    }

    // ==========================================
    // 6. RECORDING & SUPABASE
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
        fetchRecordings();
    }

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
});