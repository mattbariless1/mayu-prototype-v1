/**
 * MAYU PROTOTYPE V1.1 - DYNAMIC TIMELINE ENGINE (0-Based Index)
 * Uses RNBO multibuffer~, 12s overlapping sequence, and mathematical fade outs.
 */

document.addEventListener('DOMContentLoaded', () => {
    
    // --- 1. CONFIGURATION ---
    const SUPABASE_URL = 'https://lnxgiuebbdoaqlmeyujj.supabase.co'; 
    const SUPABASE_KEY = 'sb_publishable_SNWgZmd5pTlRQJ601FGG7A_5t3vEXea'; 
    const mayuDb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    // --- 2. GLOBAL STATE ---
    let rnboDevice, audioContext;
    let selectedFileUrl = null;
    let mediaRecorder;
    let audioChunks = [];
    const audioPlayer = new Audio(); // Added Audio object for Auditioning
    
    // Dictionaries to hold durations of our loaded files (0, 1, 2)
    const durations = { inst: {}, amb: {}, voice: 0 };
    
    // UI Elements
    const recordBtn = document.getElementById('recordBtn');
    const mixToggle = document.getElementById('mixToggle');
    const playBtn = document.getElementById('playBtn'); 
    const stopBtn = document.getElementById('stopBtn'); 
    const exportBtn = document.getElementById('exportWavBtn');
    const exportStatus = document.getElementById('exportStatus');
    const status = document.getElementById('status');
    const listContainer = document.getElementById('recordingsList');

    // ==========================================
    // 3. RNBO ENGINE SETUP
    // ==========================================

    async function setupRNBO() {
        const response = await fetch('mayu-prototype-v1.1.export.json');
        const patcher = await response.json();
        rnboDevice = await RNBO.createDevice({ context: audioContext, patcher });
        rnboDevice.node.connect(audioContext.destination);

        console.log("Loading multibuffer assets...");
        
        // Corrected File Paths & Exact DataBuffer IDs mapped to JS indices (0, 1, 2)
        await loadAudio(`media/mayu-inst-1.wav`, `inst1`, rnboDevice, audioContext, 'inst', 0);
        await loadAudio(`media/mayu-inst-2.wav`, `inst2`, rnboDevice, audioContext, 'inst', 1);
        await loadAudio(`media/mayu-inst-3.wav`, `inst3`, rnboDevice, audioContext, 'inst', 2);

        await loadAudio(`media/mayu-amb-1.wav`, `amb1`, rnboDevice, audioContext, 'amb', 0);
        await loadAudio(`media/mayu-amb-2.wav`, `amb2`, rnboDevice, audioContext, 'amb', 1);
        await loadAudio(`media/mayu-amb-3.wav`, `amb3`, rnboDevice, audioContext, 'amb', 2);

        console.log("Assets loaded. Exact Durations:", durations);
    }

    async function loadAudio(url, bufferId, device, context, type, index) {
        const res = await fetch(url);
        const arrayBuffer = await res.arrayBuffer(); 
        const audioBuffer = await context.decodeAudioData(arrayBuffer);
        
        if (type === 'inst') durations.inst[index] = audioBuffer.duration;
        if (type === 'amb') durations.amb[index] = audioBuffer.duration;
        if (type === 'voice') durations.voice = audioBuffer.duration;

        await device.setDataBuffer(bufferId, audioBuffer);
    }

    // ==========================================
    // 4. THE TIMELINE GENERATOR
    // ==========================================

    class PlaybackEngine {
        constructor() {
            this.timeline = [];
            this.instPool = [];
            this.ambPool = [];
        }

        shuffle(array) {
            let currentIndex = array.length, randomIndex;
            while (currentIndex !== 0) {
                randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
            }
            return array;
        }

        getNext(type) {
            let pool = type === 'inst' ? this.instPool : this.ambPool;
            if (pool.length === 0) {
                pool.push(...this.shuffle([0, 1, 2]));
            }
            return pool.shift();
        }

        buildTimeline(durationSeconds) {
            this.timeline = [];
            let t = 0;

            this.instPool = [];
            this.ambPool = [];

            while (t < durationSeconds) {
                // 1. MUSIC (Inst)
                let iIdx = this.getNext('inst');
                let iLen = durations.inst[iIdx];
                this.timeline.push({ time: t, param: 'inst_index', val: iIdx });
                this.timeline.push({ time: t, param: 'play_inst', val: 1 });
                // FIX: Send the stop message ONLY when the instrument file finishes
                this.timeline.push({ time: t + iLen, param: 'play_inst', val: 0 });

                // 2. ATMOSPHERE (Starts 12 seconds before Music ends)
                let ambStart = t + iLen - 12;
                if (ambStart < t) ambStart = t + iLen;

                let aIdx = this.getNext('amb');
                let aLen = durations.amb[aIdx];
                this.timeline.push({ time: ambStart, param: 'amb_index', val: aIdx });
                this.timeline.push({ time: ambStart, param: 'play_amb', val: 1 });
                // FIX: Send the stop message ONLY when the atmosphere file finishes
                this.timeline.push({ time: ambStart + aLen, param: 'play_amb', val: 0 });

                // 3. VOICE (Starts immediately after Atmosphere ends)
                let voiceStart = ambStart + aLen;
                let vLen = durations.voice;
                this.timeline.push({ time: voiceStart, param: 'play_voice', val: 1 });
                // FIX: Send the stop message ONLY when the voice file finishes
                this.timeline.push({ time: voiceStart + vLen, param: 'play_voice', val: 0 });

                // Loop restarts after Voice ends
                t = voiceStart + vLen;
            }
            this.timeline.sort((a, b) => a.time - b.time);
        }
    }

    const engine = new PlaybackEngine();

    // ==========================================
    // 5. REAL-TIME PLAYBACK
    // ==========================================
    
    let isPlaying = false;
    let rAF_ID = null;
    let playStartTime = 0;
    let eventIndex = 0;

    playBtn.onclick = () => {
        if (!selectedFileUrl) return alert("Please select a recording to audition.");
        audioPlayer.src = selectedFileUrl;
        audioPlayer.play();
    };

    mixToggle.onchange = async (e) => {
        if (!selectedFileUrl) {
            alert("Please select a voice recording.");
            e.target.checked = false;
            return;
        }

        // Fix: Instantly create and resume the AudioContext upon click
        if (!audioContext) {
            const WAContext = window.AudioContext || window.webkitAudioContext;
            audioContext = new WAContext();
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        console.log("AudioContext state is now:", audioContext.state); 

        if (!rnboDevice) await setupRNBO();

        if (e.target.checked) {
            await loadAudio(selectedFileUrl, 'voice_trk', rnboDevice, audioContext, 'voice', 0);
            
            engine.buildTimeline(7200); 
            isPlaying = true;
            eventIndex = 0;
            playStartTime = audioContext.currentTime;
            processRealtime();
        } else {
            isPlaying = false;
            cancelAnimationFrame(rAF_ID);
            
            const pInst = rnboDevice.parameters.find(p => p.id.includes("play_inst"));
            const pAmb = rnboDevice.parameters.find(p => p.id.includes("play_amb"));
            const pVoice = rnboDevice.parameters.find(p => p.id.includes("play_voice"));
            if (pInst) pInst.value = 0;
            if (pAmb) pAmb.value = 0;
            if (pVoice) pVoice.value = 0;
        }
    };

    function processRealtime() {
        if (!isPlaying) return;
        let now = audioContext.currentTime - playStartTime;
        
        while (eventIndex < engine.timeline.length && engine.timeline[eventIndex].time <= now) {
            let ev = engine.timeline[eventIndex];
            const p = rnboDevice.parameters.find(param => param.id.includes(ev.param));
            if (p) {
                p.value = ev.val;
                console.log(`[MAYU] Fired ${p.id} -> ${ev.val} (Time: ${now.toFixed(2)}s)`);
            } else {
                console.warn(`[MAYU] Warning: RNBO parameter '${ev.param}' not found!`);
            }
            eventIndex++;
        }
        rAF_ID = requestAnimationFrame(processRealtime);
    }

    stopBtn.onclick = () => {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
        if (mixToggle.checked) {
            mixToggle.click(); 
        }
    };

    // ==========================================
    // 6. PRODUCTION RENDER ENGINE (With Fade)
    // ==========================================

    exportBtn.onclick = async () => {
        if (!selectedFileUrl) return alert("Please select a recording to export.");
        exportStatus.innerText = "Initializing Export Engine...";
        
        try {
            const renderLengthSeconds = 600; 
            const sampleRate = 48000;
            const offlineContext = new OfflineAudioContext(2, renderLengthSeconds * sampleRate, sampleRate);

            const response = await fetch('mayu-prototype-v1.1.export.json');
            const patcher = await response.json();
            const renderDevice = await RNBO.createDevice({ context: offlineContext, patcher });
            renderDevice.node.connect(offlineContext.destination);

            exportStatus.innerText = "Loading assets for rendering...";
            
            // Corrected Offline Renderer Buffer IDs and File Paths
            await loadAudio(`media/mayu-inst-1.wav`, `inst1`, renderDevice, offlineContext, 'inst', 0);
            await loadAudio(`media/mayu-inst-2.wav`, `inst2`, renderDevice, offlineContext, 'inst', 1);
            await loadAudio(`media/mayu-inst-3.wav`, `inst3`, renderDevice, offlineContext, 'inst', 2);
            await loadAudio(`media/mayu-amb-1.wav`, `amb1`, renderDevice, offlineContext, 'amb', 0);
            await loadAudio(`media/mayu-amb-2.wav`, `amb2`, renderDevice, offlineContext, 'amb', 1);
            await loadAudio(`media/mayu-amb-3.wav`, `amb3`, renderDevice, offlineContext, 'amb', 2);
            
            await loadAudio(selectedFileUrl, 'voice_trk', renderDevice, offlineContext, 'voice', 0);

            exportStatus.innerText = "Calculating sequence...";
            engine.buildTimeline(renderLengthSeconds);

            const timeMap = {};
            engine.timeline.forEach(ev => {
                if (ev.time >= renderLengthSeconds) return;
                if (!timeMap[ev.time]) timeMap[ev.time] = [];
                timeMap[ev.time].push(ev);
            });

            const uniqueTimes = Object.keys(timeMap).map(Number).sort((a,b) => a - b);

            for (let t of uniqueTimes) {
                offlineContext.suspend(t).then(() => {
                    timeMap[t].forEach(ev => {
                        const p = renderDevice.parameters.find(param => param.id.includes(ev.param));
                        if (p) p.value = ev.val;
                    });
                    offlineContext.resume();
                });
            }

            exportStatus.innerText = "Rendering 10-minute soundscape... (Takes ~10s)";
            const renderedBuffer = await offlineContext.startRendering();

            exportStatus.innerText = "Applying final fade out...";
            applyFadeOut(renderedBuffer, 10);

            exportStatus.innerText = "Encoding WAV...";
            const wavBlob = bufferToWav(renderedBuffer);
            const url = URL.createObjectURL(wavBlob);
            
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `mayu_soundscape_${Date.now()}.wav`;
            anchor.click();
            
            exportStatus.innerText = "Download Complete!";

        } catch (err) {
            console.error("Render Error:", err);
            exportStatus.innerText = "Render failed. Check console.";
        }
    };

    function applyFadeOut(audioBuffer, fadeSeconds) {
        const sampleRate = audioBuffer.sampleRate;
        const fadeSamples = fadeSeconds * sampleRate;
        const length = audioBuffer.length;
        const startFade = length - fadeSamples;

        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = startFade; i < length; i++) {
                const multiplier = 1.0 - ((i - startFade) / fadeSamples);
                channelData[i] *= Math.max(0, multiplier);
            }
        }
    }

    function bufferToWav(abuffer) {
        let numOfChan = abuffer.numberOfChannels,
            length = abuffer.length * numOfChan * 2 + 44,
            buffer = new ArrayBuffer(length), view = new DataView(buffer),
            channels = [], i, sample, offset = 0, pos = 0;
        function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

        setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
        setUint32(0x20746d66); setUint16(16); setUint16(1); setUint16(numOfChan);
        setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan);
        setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - pos - 4);
        for(i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));
        while(pos < length) {
            for(i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][offset]));
                sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF);
                view.setInt16(pos, sample, true); pos += 2;
            }
            offset++;
        }
        return new Blob([buffer], {type: "audio/wav"});
    }

    // ==========================================
    // 7. SUPABASE RECORDING LOGIC
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