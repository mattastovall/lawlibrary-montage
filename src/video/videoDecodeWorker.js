// Video Decode Worker
let decoder = null;
let videoId = null;
let isDecoding = false;
let frameQueue = [];
let maxQueueSize = 5;
let lastStatsUpdate = 0;
const STATS_UPDATE_INTERVAL = 2000; // Increased to 2 seconds
let codecPreference = 'avc1.42E01E'; // Default to H.264

// Dynamic queue size management
function updateMaxQueueSize(processingTime) {
    // Adjust queue size based on processing time
    if (processingTime > 50) { // If frame processing takes more than 50ms
        maxQueueSize = Math.max(3, maxQueueSize - 1);
    } else if (processingTime < 20) { // If processing is fast
        maxQueueSize = Math.min(8, maxQueueSize + 1);
    }
}

// Initialize decoder with codec detection
async function initDecoder(config) {
    try {
        const { width, height, codec, videoData } = config;
        
        // Detect codec from video data if available
        if (videoData) {
            try {
                const mimeType = await detectCodec(videoData);
                if (mimeType) {
                    codecPreference = mimeType;
                }
            } catch (e) {
                console.warn('Codec detection failed, using default:', e);
            }
        }

        // Create video decoder with enhanced error handling
        decoder = new VideoDecoder({
            output: handleFrame,
            error: handleDecoderError
        });

        // Configure decoder with detected or specified codec
        const decoderConfig = {
            codec: codec || codecPreference,
            codedWidth: width,
            codedHeight: height,
            displayWidth: width,
            displayHeight: height,
            optimizeForLatency: true
        };

        // Test if codec is supported
        if (!VideoDecoder.isConfigSupported(decoderConfig)) {
            throw new Error(`Codec ${decoderConfig.codec} not supported`);
        }

        await decoder.configure(decoderConfig);
        
        return true;
    } catch (error) {
        console.error('Decoder initialization error:', error);
        self.postMessage({
            type: 'error',
            videoId,
            error: `Decoder initialization failed: ${error.message}`
        });
        return false;
    }
}

// Frame handling with processing time feedback
function handleFrame(frame) {
    const startTime = performance.now();
    try {
        // Create transferable frame data
        const frameData = {
            timestamp: frame.timestamp,
            duration: frame.duration,
            width: frame.displayWidth,
            height: frame.displayHeight
        };

        // Copy frame data to transferable buffer
        const buffer = new ArrayBuffer(frame.allocationSize());
        const videoData = new Uint8Array(buffer);
        frame.copyTo(buffer);

        // Add frame to queue with dynamic size management
        frameQueue.push({
            ...frameData,
            data: videoData.buffer
        });

        // Trim queue if too large
        while (frameQueue.length > maxQueueSize) {
            const droppedFrame = frameQueue.shift();
            self.postMessage({
                type: 'frameDropped',
                videoId,
                timestamp: droppedFrame.timestamp
            });
        }

        // Send frame to main thread
        self.postMessage({
            type: 'decodedFrame',
            videoId,
            frameData: {
                ...frameData,
                data: videoData.buffer
            }
        }, [videoData.buffer]);

        frame.close();

        // Update queue size based on processing time
        const processingTime = performance.now() - startTime;
        updateMaxQueueSize(processingTime);

    } catch (error) {
        console.error('Frame handling error:', error);
        self.postMessage({
            type: 'error',
            videoId,
            error: `Frame handling failed: ${error.message}`
        });
    }
}

// Handle decoder errors
function handleDecoderError(error) {
    console.error('Decoder error:', error);
    self.postMessage({
        type: 'error',
        videoId,
        error: error.message
    });
}

// Process incoming encoded chunks
async function processChunk(chunk) {
    if (!decoder || decoder.state !== 'configured') return;

    try {
        // Create encoded video chunk
        const encodedChunk = new EncodedVideoChunk({
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            data: chunk.data
        });

        // Decode chunk
        decoder.decode(encodedChunk);
    } catch (error) {
        console.error('Chunk processing error:', error);
    }
}

// Combined message handler
self.onmessage = async function(e) {
    if (!e.data || typeof e.data !== 'object') {
        console.error('Invalid message received:', e.data);
        return;
    }

    const { type, data = {} } = e.data;

    try {
        switch (type) {
            case 'init':
                if (!data.videoId) {
                    throw new Error('videoId is required for initialization');
                }
                videoId = data.videoId;
                const success = await initDecoder(data);
                self.postMessage({
                    type: 'initialized',
                    videoId,
                    success,
                    codec: codecPreference
                });
                break;

            case 'decode':
                if (!decoder) {
                    throw new Error('Decoder not initialized');
                }
                if (data.chunk) {
                    await processChunk(data.chunk);
                }
                break;

            case 'play':
            case 'pause':
                self.postMessage({
                    type: `${type}Acknowledged`,
                    videoId
                });
                break;

            case 'flush':
                if (decoder) {
                    await decoder.flush();
                    frameQueue = [];
                }
                self.postMessage({
                    type: 'flushed',
                    videoId
                });
                break;

            case 'close':
                if (decoder) {
                    await decoder.close();
                    decoder = null;
                    frameQueue = [];
                    videoId = null;
                }
                self.postMessage({
                    type: 'closed',
                    success: true
                });
                break;

            default:
                console.warn('Unknown message type:', type);
        }
    } catch (error) {
        console.error('Error processing message:', error);
        self.postMessage({
            type: 'error',
            videoId,
            error: error.message,
            messageType: type
        });
    }
}

// Optimized performance monitoring
function sendStats() {
    const now = performance.now();
    if (now - lastStatsUpdate < STATS_UPDATE_INTERVAL) return;
    
    self.postMessage({
        type: 'stats',
        videoId,
        stats: {
            queueSize: frameQueue.length,
            maxQueueSize,
            decoderState: decoder?.state,
            codec: codecPreference
        }
    });
    
    lastStatsUpdate = now;
}

// Detect codec from video data
async function detectCodec(videoData) {
    try {
        // Simple codec detection based on file signature
        const signature = new Uint8Array(videoData.slice(0, 12));
        
        // Check for H.264
        if (signature[4] === 0x66 && signature[5] === 0x74 && signature[6] === 0x79 && signature[7] === 0x70) {
            return 'avc1.42E01E';
        }
        
        // Check for VP8/VP9
        if (signature[0] === 0x1A && signature[1] === 0x45 && signature[2] === 0xDF && signature[3] === 0xA3) {
            return 'vp8';
        }
        
        return null;
    } catch (e) {
        console.warn('Codec detection failed:', e);
        return null;
    }
} 