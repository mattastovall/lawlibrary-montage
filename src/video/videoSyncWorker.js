// Video Sync Worker
const videoStates = new Map();
let masterVideoId = null;
const SYNC_INTERVAL = 16; // ~60fps
let syncIntervalId = null;

let masterTime = 0;
let isPlaying = false;
let videos = {};

// Store video timing information
class VideoState {
    constructor(id) {
        this.id = id;
        this.lastFrameTime = 0;
        this.mediaTime = 0;
        this.expectedDisplay = 0;
        this.frameCount = 0;
        this.totalDrift = 0;
        this.driftSamples = 0;
        this.averageDrift = 0;
        this.isPlaying = false;
        this.adjustment = 0;
        this.lastUpdate = 0;
    }

    updateFrame(timestamp, mediaTime, expectedDisplay) {
        this.lastFrameTime = timestamp;
        this.mediaTime = mediaTime;
        this.expectedDisplay = expectedDisplay;
        this.frameCount++;
    }

    calculateDrift(masterState) {
        if (!masterState) return 0;
        
        const drift = this.mediaTime - masterState.mediaTime;
        this.totalDrift += drift;
        this.driftSamples++;
        this.averageDrift = this.totalDrift / this.driftSamples;
        
        return drift;
    }

    reset() {
        this.totalDrift = 0;
        this.driftSamples = 0;
        this.averageDrift = 0;
        this.frameCount = 0;
    }
}

// Handle messages from main thread
self.onmessage = function(e) {
    if (!e.data || typeof e.data !== 'object') {
        console.error('Invalid message received:', e.data);
        return;
    }

    const { type, videoId, mediaTime, timestamp, expectedDisplay, time } = e.data;

    // Add logging for every message received
    console.debug(`[videoSyncWorker] Received message: type=${type}, videoId=${videoId}, mediaTime=${mediaTime}, timestamp=${timestamp}, expectedDisplay=${expectedDisplay}, time=${time}`);

    try {
        switch (type) {
            case 'init':
                if (!videoId) {
                    throw new Error('videoId is required for initialization');
                }
                handleInit(videoId);
                break;

            case 'frame':
                if (!videoId) {
                    throw new Error('videoId is required for frame update');
                }
                handleFrame(videoId, e.data);
                break;

            case 'play':
                handlePlay(e.data);
                break;

            case 'pause':
                handlePause();
                break;

            case 'seek':
                handleSeek(e.data);
                break;

            case 'remove':
                if (videos[videoId]) {
                    delete videos[videoId];
                }
                break;

            default:
                console.warn('Unknown message type:', type);
        }
    } catch (error) {
        console.error('Error processing message:', error);
        self.postMessage({
            type: 'error',
            error: error.message
        });
    }
};

function handleInit(videoId) {
    console.log('Initializing video state for:', videoId);
    
    // Create new video state
    const newState = new VideoState(videoId);
    videoStates.set(videoId, newState);
    
    // If this is the first video or explicitly marked as master, set it as master
    if (!masterVideoId || videoId === 'master') {
        masterVideoId = videoId;
        console.log('Set master video ID to:', videoId);
    }
    
    // Log current state
    console.log('Current video states:', {
        masterVideoId,
        totalVideos: videoStates.size,
        videos: Array.from(videoStates.keys())
    });

    videos[videoId] = newState;
}

function handleFrame(videoId, data) {
    const state = videoStates.get(videoId);
    if (!state) {
        console.warn('No state found for video:', videoId);
        return;
    }

    state.updateFrame(data.timestamp, data.mediaTime, data.expectedDisplay);
    
    // If this is not the master video, check sync
    if (videoId !== masterVideoId) {
        const masterState = videoStates.get(masterVideoId);
        if (masterState) {
            const drift = state.calculateDrift(masterState);
            
            // Send sync adjustment if needed
            if (Math.abs(drift) > 0.001) { // 1ms threshold
                self.postMessage({
                    type: 'sync',
                    videoId,
                    adjustment: drift
                });
            }
        }
    }

    if (videoId !== 'master' && isPlaying) {
        const master = videos['master'];
        if (master) {
            const expectedTime = master.mediaTime + (data.timestamp - master.lastUpdate) / 1000;
            const drift = data.mediaTime - expectedTime;
            // Simple proportional control
            const adjustment = drift * 0.5; // Adjust by 50% of the drift

            state.adjustment += adjustment;

            self.postMessage({
                type: 'sync',
                videoId,
                adjustment
            });
        }
    }
}

function handlePlay(data) {
    console.log('Starting playback');
    videoStates.forEach(state => {
        state.isPlaying = true;
        state.reset();
    });

    // Start sync interval
    if (syncIntervalId) {
        clearInterval(syncIntervalId);
    }
    
    syncIntervalId = setInterval(checkSync, SYNC_INTERVAL);

    isPlaying = true;
    masterTime = data.time; // Set master time on play
    for (const id in videos) {
        videos[id].lastUpdate = performance.now();
    }
}

function handlePause() {
    console.log('Pausing playback');
    videoStates.forEach(state => {
        state.isPlaying = false;
    });

    if (syncIntervalId) {
        clearInterval(syncIntervalId);
        syncIntervalId = null;
    }

    isPlaying = false;
}

function handleSeek(data) {
    console.log('Seeking to:', data.time);
    videoStates.forEach(state => {
        state.reset();
    });

    masterTime = data.time;
    for (const id in videos) {
        videos[id].mediaTime = data.time;
        videos[id].lastUpdate = performance.now();
        videos[id].adjustment = 0;
    }
}

function checkSync() {
    const masterState = videoStates.get(masterVideoId);
    if (!masterState || !masterState.isPlaying) return;

    // Add logging for sync checks
    console.debug('[videoSyncWorker] Checking sync...');

    // Check sync for all non-master videos
    videoStates.forEach((state, videoId) => {
        if (videoId === masterVideoId) return;

        const drift = state.calculateDrift(masterState);
        
        // Send sync adjustment if average drift is significant
        if (Math.abs(state.averageDrift) > 0.005) { // 5ms average drift threshold
            // Add logging for sync adjustments
            console.debug(`[videoSyncWorker] Sending sync adjustment: videoId=${videoId}, adjustment=${state.averageDrift}`);

            self.postMessage({
                type: 'sync',
                videoId,
                adjustment: state.averageDrift
            });
            
            // Reset drift tracking after adjustment
            state.reset();
        }
    });
}

// Performance monitoring
setInterval(() => {
    const stats = {};
    videoStates.forEach((state, id) => {
        stats[id] = {
            frameCount: state.frameCount,
            averageDrift: state.averageDrift,
            isPlaying: state.isPlaying
        };
    });
    
    self.postMessage({
        type: 'stats',
        stats
    });
}, 1000); 