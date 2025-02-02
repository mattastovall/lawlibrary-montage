// Video processing web worker

let videoMetadata = {
    duration: 0,
    frameCount: 0,
    lastFrameTimestamp: 0,
    format: null,
    lastTimeUpdate: 0,
    expectedFrameTime: 1000 / 30,
    shouldLoop: true,
    isNearEnd: false
};

// Handle messages from main thread
self.onmessage = async function(e) {
    const { type, data } = e.data;

    switch (type) {
        case 'init':
            videoMetadata = {
                ...videoMetadata,
                duration: data.duration,
                format: data.format,
                shouldLoop: data.shouldLoop,
                frameCount: 0,
                lastFrameTimestamp: 0,
                lastTimeUpdate: 0,
                isNearEnd: false
            };
            self.postMessage({ type: 'initialized' });
            break;

        case 'processFrame':
            const { currentTime, timestamp, readyState, buffered, duration, paused } = data;
            
            // Process frame timing
            if (videoMetadata.frameCount === 0) {
                videoMetadata.lastFrameTimestamp = timestamp;
                videoMetadata.lastTimeUpdate = currentTime;
                videoMetadata.frameCount++;
                self.postMessage({ type: 'frameProcessed', data: { isFirstFrame: true } });
                return;
            }

            // Calculate timing information
            const frameTime = timestamp - videoMetadata.lastFrameTimestamp;
            const timeDiff = currentTime - videoMetadata.lastTimeUpdate;

            // Check if we should loop
            let shouldRestart = false;
            if (videoMetadata.shouldLoop) {
                // Check if we're near the end (within last 0.2 seconds)
                if (currentTime >= duration - 0.2) {
                    if (!videoMetadata.isNearEnd) {
                        videoMetadata.isNearEnd = true;
                        shouldRestart = true;
                    }
                } else {
                    videoMetadata.isNearEnd = false;
                }
            }

            // Process buffer state
            let bufferInfo = null;
            if (buffered && buffered.length > 0) {
                try {
                    const bufferedEnd = buffered[0].end;
                    const bufferedStart = buffered[0].start;
                    bufferInfo = {
                        currentTime: currentTime.toFixed(2),
                        bufferedEnd: bufferedEnd.toFixed(2),
                        bufferedStart: bufferedStart.toFixed(2),
                        duration: duration.toFixed(2),
                        bufferPercentage: ((bufferedEnd/duration)*100).toFixed(1),
                        readyState,
                        frameTime,
                        timeDiff: (timeDiff * 1000).toFixed(1)
                    };
                } catch (error) {
                    console.warn('Error processing buffer info:', error);
                }
            }

            // Update tracking variables
            videoMetadata.lastFrameTimestamp = timestamp;
            videoMetadata.lastTimeUpdate = currentTime;
            videoMetadata.frameCount++;

            // Send processed data back to main thread
            self.postMessage({
                type: 'frameProcessed',
                data: {
                    shouldRestart,
                    bufferInfo,
                    currentTime,
                    frameTime,
                    timeDiff,
                    isNearEnd: videoMetadata.isNearEnd
                }
            });
            break;

        case 'reset':
            videoMetadata = {
                ...videoMetadata,
                frameCount: 0,
                lastFrameTimestamp: 0,
                lastTimeUpdate: 0,
                isNearEnd: false
            };
            self.postMessage({ type: 'reset' });
            break;
    }
}; 