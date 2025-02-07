class AdaptiveStreamingManager {
    constructor() {
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.qualityLevels = [
            { width: 3840, height: 2160, bitrate: 16000000, name: '4K' },
            { width: 1920, height: 1080, bitrate: 8000000, name: '1080p' },
            { width: 1280, height: 720, bitrate: 4000000, name: '720p' },
            { width: 854, height: 480, bitrate: 2000000, name: '480p' }
        ];
        this.currentQuality = 1; // Start with 1080p
        this.bufferSize = 10; // Buffer 10 seconds ahead
        this.isInitialized = false;
        this.hasInitSegment = false;
        this.networkMetrics = {
            lastCheck: 0,
            downloadSpeed: 0,
            bufferHealth: 1,
            switchCooldown: 0
        };
        this.performanceMetrics = {
            droppedFrames: 0,
            totalFrames: 0,
            lastFrameTime: 0,
            frameTimings: []
        };
        this.pendingOperations = [];
        this.isSourceOpen = false;
        this.bufferQueue = [];
        this.currentUrl = null; // Keep track of current URL
        this.aborted = false; // Flag to indicate if cleanup has been initiated
        this.initializationPromise = null;
    }

    async initialize(videoElement) {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        this.initializationPromise = new Promise((resolve, reject) => {
            if (this.aborted) {
                reject(new Error('AdaptiveStreamingManager has been aborted'));
                return;
            }

            if (this.mediaSource) {
                console.warn('MediaSource already initialized');
                resolve(); // Already initialized
                return;
            }

            this.mediaSource = new MediaSource();
            this.currentUrl = URL.createObjectURL(this.mediaSource); // Store the URL
            videoElement.src = this.currentUrl;

            this.mediaSource.addEventListener('sourceopen', () => {
                this.isSourceOpen = true;
                this.sourceBuffer = this.mediaSource.addSourceBuffer('video/mp4; codecs="avc1.640028,mp4a.40.2"');

                this.sourceBuffer.addEventListener('updateend', () => {
                    if (this.bufferQueue.length > 0 && !this.sourceBuffer.updating) {
                        const nextSegment = this.bufferQueue.shift();
                        this.sourceBuffer.appendBuffer(nextSegment);
                    } else if (this.mediaSource.readyState === 'open' && this.bufferQueue.length === 0 && !this.sourceBuffer.updating) {
                        // Check if we need to signal end of stream
                        // This is a simplified example; you might need more sophisticated logic
                        // to determine when the stream has truly ended.
                        // this.mediaSource.endOfStream();
                    }
                });

                this.sourceBuffer.addEventListener('error', (e) => {
                    console.error('SourceBuffer error:', e);
                    reject(e); // Reject initialization promise on error
                });

                this.processPendingOperations();
                resolve(); // Resolve initialization promise
            }, { once: true });

            this.mediaSource.addEventListener('sourceended', () => {
                console.log('MediaSource ended');
            });

            this.mediaSource.addEventListener('sourceclose', () => {
                console.log('MediaSource closed');
            });

            this.mediaSource.addEventListener('error', (e) => {
                console.error('MediaSource error:', e);
                reject(e); // Reject initialization promise on error
            });
        });

        return this.initializationPromise;
    }

    processPendingOperations() {
        if (!this.isSourceOpen || !this.sourceBuffer) {
            return;
        }

        if (this.sourceBuffer.updating || this.bufferQueue.length > 0) {
            return;
        }

        const operation = this.pendingOperations.shift();
        if (!operation) {
            return;
        }

        try {
            this.bufferQueue.push(operation.segmentData);
            if (!this.sourceBuffer.updating) {
                const nextSegment = this.bufferQueue.shift();
                this.sourceBuffer.appendBuffer(nextSegment);
            }
            operation.resolve(true);
        } catch (error) {
            console.error('Error appending segment:', error);
            operation.reject(error);
        }
    }

    async appendSegment(segmentData, isInit) {
        if (this.aborted) {
            console.warn('appendSegment called after cleanup');
            return false;
        }
        return new Promise((resolve, reject) => {
            this.pendingOperations.push({ segmentData, isInit, resolve, reject });
            this.processPendingOperations();
        });
    }

    setupEventListeners() {
        // Monitor network conditions
        setInterval(() => this.checkNetworkConditions(), 1000);

        // Monitor playback performance
        this.videoElement.addEventListener('play', () => {
            this.startPerformanceMonitoring();
        });

        // Buffer monitoring
        this.videoElement.addEventListener('waiting', () => {
            this.networkMetrics.bufferHealth = Math.min(this.networkMetrics.bufferHealth * 0.8, 0.8);
            this.evaluateQualitySwitch();
        });

        // Track dropped frames
        this.videoElement.addEventListener('timeupdate', () => {
            const now = performance.now();
            if (this.performanceMetrics.lastFrameTime) {
                const frameDuration = now - this.performanceMetrics.lastFrameTime;
                if (frameDuration > (1000 / 30) * 1.5) { // Assuming 30fps
                    this.performanceMetrics.droppedFrames++;
                }
                this.performanceMetrics.totalFrames++;
            }
            this.performanceMetrics.lastFrameTime = now;
        });
    }

    async checkNetworkConditions() {
        const now = Date.now();
        if (now - this.networkMetrics.lastCheck < 1000) return;

        try {
            const start = performance.now();
            const response = await fetch('/network-test', { method: 'HEAD' });
            const end = performance.now();
            
            // Calculate download speed in Mbps
            const duration = end - start;
            const speed = (1000 / duration) * 8; // Rough estimation in Mbps
            
            this.networkMetrics.downloadSpeed = speed;
            this.networkMetrics.lastCheck = now;
            
            // Update buffer health
            if (this.videoElement.buffered.length > 0) {
                const buffered = this.videoElement.buffered.end(0) - this.videoElement.currentTime;
                this.networkMetrics.bufferHealth = Math.min(buffered / this.bufferSize, 1);
            }

            this.evaluateQualitySwitch();
        } catch (error) {
            console.warn('Network check failed:', error);
            this.networkMetrics.bufferHealth *= 0.8; // Reduce buffer health on error
        }
    }

    evaluateQualitySwitch() {
        if (Date.now() - this.networkMetrics.switchCooldown < 5000) return;

        const currentQuality = this.qualityLevels[this.currentQuality];
        const requiredBandwidth = currentQuality.bitrate * 1.5; // 50% overhead for safety
        
        if (this.networkMetrics.downloadSpeed * 1000000 < requiredBandwidth || 
            this.networkMetrics.bufferHealth < 0.3 ||
            (this.performanceMetrics.droppedFrames / this.performanceMetrics.totalFrames) > 0.1) {
            // Switch to lower quality
            if (this.currentQuality < this.qualityLevels.length - 1) {
                this.switchQuality(this.currentQuality + 1);
            }
        } else if (this.networkMetrics.downloadSpeed * 1000000 > requiredBandwidth * 1.5 &&
                   this.networkMetrics.bufferHealth > 0.8 &&
                   (this.performanceMetrics.droppedFrames / this.performanceMetrics.totalFrames) < 0.05) {
            // Switch to higher quality
            if (this.currentQuality > 0) {
                this.switchQuality(this.currentQuality - 1);
            }
        }
    }

    async switchQuality(newQualityIndex) {
        if (newQualityIndex === this.currentQuality) return;

        const newQuality = this.qualityLevels[newQualityIndex];
        console.log(`Switching quality to ${newQuality.name}`);

        this.currentQuality = newQualityIndex;
        this.networkMetrics.switchCooldown = Date.now();

        // Trigger quality change event
        this.videoElement.dispatchEvent(new CustomEvent('qualitychange', {
            detail: {
                quality: newQuality.name,
                width: newQuality.width,
                height: newQuality.height,
                bitrate: newQuality.bitrate
            }
        }));
    }

    startPerformanceMonitoring() {
        this.performanceMetrics = {
            droppedFrames: 0,
            totalFrames: 0,
            lastFrameTime: 0,
            frameTimings: []
        };
    }

    onSourceBufferUpdateEnd() {
        if (!this.sourceBuffer || !this.videoElement) return;

        try {
            // Remove old segments if buffer is too large
            if (this.sourceBuffer.buffered.length > 0) {
                const bufferedEnd = this.sourceBuffer.buffered.end(0);
                const currentTime = this.videoElement.currentTime;
                
                if (bufferedEnd - currentTime > this.bufferSize * 2) {
                    const removeStart = 0;
                    const removeEnd = currentTime - 1;
                    if (removeEnd > removeStart && !this.sourceBuffer.updating) {
                        try {
                            this.sourceBuffer.remove(removeStart, removeEnd);
                        } catch (e) {
                            console.warn('Error removing old segments:', e);
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Error in onSourceBufferUpdateEnd:', error);
        }
    }

    getQualityLevels() {
        return this.qualityLevels;
    }

    getCurrentQuality() {
        return this.qualityLevels[this.currentQuality];
    }

    getNetworkStats() {
        return {
            downloadSpeed: this.networkMetrics.downloadSpeed,
            bufferHealth: this.networkMetrics.bufferHealth,
            currentQuality: this.getCurrentQuality()
        };
    }

    getPerformanceStats() {
        return {
            droppedFrames: this.performanceMetrics.droppedFrames,
            totalFrames: this.performanceMetrics.totalFrames,
            dropRate: this.performanceMetrics.totalFrames ? 
                (this.performanceMetrics.droppedFrames / this.performanceMetrics.totalFrames) : 0
        };
    }

    async cleanup() {
        this.aborted = true; // Set flag to prevent further operations

        if (this.sourceBuffer) {
            try {
                if (this.sourceBuffer.updating) {
                    this.sourceBuffer.abort();
                }
            } catch (e) {
                console.warn('Error aborting source buffer:', e);
            }
            this.sourceBuffer = null;
        }

        if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try {
                this.mediaSource.endOfStream();
            } catch (e) {
                console.warn('Error ending media source stream:', e);
            }
        }

        // Revoke the object URL
        if (this.currentUrl) {
            URL.revokeObjectURL(this.currentUrl);
            this.currentUrl = null;
        }

        this.mediaSource = null;
        this.isSourceOpen = false;
        this.pendingOperations = [];
        this.bufferQueue = [];
        this.initializationPromise = null; // Reset initialization promise

        // Remove event listeners
        if (this.videoElement) {
            this.videoElement.removeEventListener('play', this.startPerformanceMonitoring);
            this.videoElement.removeEventListener('waiting', this.evaluateQualitySwitch);
            this.videoElement.removeEventListener('timeupdate', this.updatePerformanceMetrics);
        }

        // Reset state
        this.hasInitSegment = false;
        this.networkMetrics = {
            lastCheck: 0,
            downloadSpeed: 0,
            bufferHealth: 1,
            switchCooldown: 0
        };
        this.performanceMetrics = {
            droppedFrames: 0,
            totalFrames: 0,
            lastFrameTime: 0,
            frameTimings: []
        };

        this.isInitialized = false;
        console.log('Adaptive streaming manager cleaned up');
    }
}

export default AdaptiveStreamingManager; 