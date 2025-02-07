// Main Application Module
import WebGLRenderer from './webgl/renderer.js';
import VideoSyncManager from './VideoSyncManager.js';
import TimelineManager from './timeline/timelineManager.js';
import { videoCacheManager } from './videoCache.js';

class VideoMontageApp {
    constructor() {
        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        try {
            // Initialize components
            this.initializeComponents();
            
            // Set up event listeners
            this.setupEventListeners();
            
            // Initialize video state
            this.videoState = {
                isPlaying: false,
                currentTime: 0,
                duration: 0,
                fps: 30
            };
            
            // Initialize layers
            this.initializeLayers();

            // Load default videos
            this.loadDefaultVideos();
        } catch (error) {
            console.error('Error initializing app:', error);
        }
    }

    initializeComponents() {
        try {
            // Initialize WebGL renderer
            const canvas = document.getElementById('videoCanvas');
            if (!canvas) throw new Error('Video canvas element not found');
            this.renderer = new WebGLRenderer(canvas);
            
            // Initialize video sync manager
            this.syncManager = new VideoSyncManager();
            
            // Initialize timeline manager
            const timelineContainer = document.querySelector('.timeline-container');
            const timelineGrid = document.querySelector('.timeline-grid');
            const thumbnailMarkers = document.querySelector('.thumbnail-markers');
            const playheadMarker = document.querySelector('.playhead-marker');

            if (!timelineContainer) throw new Error('Timeline container not found');
            if (!timelineGrid) throw new Error('Timeline grid not found');
            if (!thumbnailMarkers) throw new Error('Thumbnail markers container not found');
            if (!playheadMarker) throw new Error('Playhead marker not found');

            this.timelineManager = new TimelineManager({
                container: timelineContainer,
                timelineGrid: timelineGrid,
                thumbnailMarkers: thumbnailMarkers,
                playheadMarker: playheadMarker,
                onMarkerSelect: this.handleMarkerSelect.bind(this),
                onTimeUpdate: this.handleTimeUpdate.bind(this)
            });
            
            // Initialize video cache
            this.videoCache = videoCacheManager;

            console.log('Components initialized successfully');
        } catch (error) {
            console.error('Error initializing components:', error);
            throw error;
        }
    }

    setupEventListeners() {
        try {
            // Video input handling
            const videoInput = document.getElementById('videoUpload');
            if (!videoInput) throw new Error('Video input element not found');
            videoInput.addEventListener('change', this.handleVideoUpload.bind(this));
            
            // Playback controls
            const playPauseBtn = document.getElementById('playPause');
            if (!playPauseBtn) throw new Error('Play/Pause button not found');
            playPauseBtn.addEventListener('click', this.togglePlayback.bind(this));
            
            // Export button
            const exportBtn = document.getElementById('exportVideo');
            if (!exportBtn) throw new Error('Export button not found');
            exportBtn.addEventListener('click', this.exportVideo.bind(this));
            
            // Drag and drop handling
            const dropZone = document.getElementById('dropZone');
            if (!dropZone) throw new Error('Drop zone not found');
            dropZone.addEventListener('dragover', this.handleDragOver.bind(this));
            dropZone.addEventListener('drop', this.handleDrop.bind(this));
            
            // Window resize handling
            window.addEventListener('resize', this.handleResize.bind(this));

            console.log('Event listeners set up successfully');
        } catch (error) {
            console.error('Error setting up event listeners:', error);
            throw error;
        }
    }

    initializeLayers() {
        // Create main track
        this.createMainTrack();
        
        // Create composite tracks
        this.createCompositeTracks();
    }

    createMainTrack() {
        const mainTrack = {
            id: 1,
            isMainTrack: true,
            zIndex: 3,
            videoElement: document.getElementById('videoPreview'),
            startFrame: 0,
            endFrame: Infinity
        };
        
        this.timelineManager.createMarker(mainTrack);
    }

    createCompositeTracks() {
        // Create additional tracks with their configurations
        const tracks = [
            { id: 2, zIndex: 1, startFrame: 0, endFrame: 67 },
            { id: 3, zIndex: 2, startFrame: 0, endFrame: 67 },
            { id: 4, zIndex: 1, startFrame: 68, endFrame: 152 },
            { id: 5, zIndex: 1, startFrame: 153, endFrame: 208 },
            { id: 6, zIndex: 1, startFrame: 209, endFrame: 240 }
        ];
        
        tracks.forEach(track => {
            track.hasCornerPin = true;
            track.cornerPin = this.getDefaultCornerPin(track.id);
            this.timelineManager.createMarker(track);
        });
    }

    getDefaultCornerPin(trackId) {
        // Return corner pin configuration based on track ID
        const cornerPins = {
            2: {
                topLeft: { x: -72, y: 1164 },
                topRight: { x: 1920, y: -188 },
                bottomLeft: { x: -336, y: 2560 },
                bottomRight: { x: 1916, y: 1956 }
            },
            3: {
                topLeft: { x: -72, y: 1164 },
                topRight: { x: 1920, y: -188 },
                bottomLeft: { x: -336, y: 2560 },
                bottomRight: { x: 1916, y: 1956 }
            },
            4: {
                topLeft: { x: 96, y: 0 },
                topRight: { x: 3720, y: 8 },
                bottomLeft: { x: 288, y: 2088 },
                bottomRight: { x: 3704, y: 1976 }
            },
            5: {
                topLeft: { x: 544, y: 64 },
                topRight: { x: 3824, y: 64 },
                bottomLeft: { x: 544, y: 2216 },
                bottomRight: { x: 3824, y: 2192 }
            },
            6: {
                topLeft: { x: 0, y: 0 },
                topRight: { x: 3840, y: 0 },
                bottomLeft: { x: 0, y: 2160 },
                bottomRight: { x: 3840, y: 2160 }
            }
        };
        
        return cornerPins[trackId] || null;
    }

    async handleVideoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            // Load video
            const videoElement = document.getElementById('videoPreview');
            const videoURL = URL.createObjectURL(file);
            
            // Set up video element
            videoElement.src = videoURL;
            videoElement.muted = true;
            videoElement.playsInline = true;
            videoElement.crossOrigin = 'anonymous';
            
            // Wait for metadata
            await new Promise(resolve => {
                videoElement.addEventListener('loadedmetadata', resolve, { once: true });
            });
            
            // Wait for video to be ready to play
            await new Promise(resolve => {
                const checkReady = () => {
                    if (videoElement.readyState >= 2) {
                        resolve();
                    } else {
                        setTimeout(checkReady, 100);
                    }
                };
                checkReady();
            });
            
            // Update video state
            this.videoState.duration = videoElement.duration;
            this.timelineManager.setDuration(videoElement.duration);
            
            // Add video to sync manager with a unique ID
            const mainVideoId = 'main-video';
            this.syncManager.addVideo(mainVideoId, videoElement);
            
            // Set as master video using the ID
            this.syncManager.setMasterVideo(mainVideoId);
            
            // Hide drop zone and show canvas
            const dropZone = document.getElementById('dropZone');
            const canvas = document.getElementById('videoCanvas');
            if (dropZone) dropZone.style.display = 'none';
            if (canvas) {
                canvas.style.display = 'block';
                canvas.style.opacity = '1';
            }
            
            // Enable controls
            const playPauseBtn = document.getElementById('playPause');
            const exportBtn = document.getElementById('exportVideo');
            if (playPauseBtn) playPauseBtn.disabled = false;
            if (exportBtn) exportBtn.disabled = false;
            
            // Initialize WebGL with the video
            await this.renderer.initializeWithVideo(videoElement);
            
            // Start playback and render loop
            this.videoState.isPlaying = true;
            await videoElement.play();
            this.startRenderLoop();
            
            console.log('Video loaded successfully:', {
                duration: videoElement.duration,
                readyState: videoElement.readyState,
                size: `${videoElement.videoWidth}x${videoElement.videoHeight}`
            });
            
        } catch (error) {
            console.error('Error loading video:', error);
            alert('Error loading video: ' + error.message);
        }
    }

    async handleCompositeVideoUpload(file, layerId) {
        try {
            const layer = this.timelineManager.getLayerById(layerId);
            if (!layer) return;
            
            // Create video element
            const video = document.createElement('video');
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            
            // Set up video
            const videoURL = URL.createObjectURL(file);
            video.src = videoURL;
            
            // Wait for metadata
            await new Promise(resolve => {
                video.addEventListener('loadedmetadata', resolve, { once: true });
            });
            
            // Update layer
            layer.videoElement = video;
            layer.videoSource = videoURL;
            
            // Add to sync manager
            this.syncManager.addVideo(`layer_${layerId}`, video);
            
            // Update UI
            this.timelineManager.updateMarker(layerId);
            
        } catch (error) {
            console.error('Error loading composite video:', error);
            alert('Error loading composite video: ' + error.message);
        }
    }

    startRenderLoop() {
        const render = () => {
            if (!this.videoState.isPlaying) return;

            try {
                // Get active layers
                const activeLayers = this.timelineManager.getActiveLayers(this.videoState.currentTime);
                
                // Render frame
                this.renderer.render({ 
                    layers: activeLayers,
                    currentTime: this.videoState.currentTime
                });
                
                // Continue loop
                requestAnimationFrame(render);
            } catch (error) {
                console.error('Render error:', error);
                this.videoState.isPlaying = false;
                const playPauseBtn = document.getElementById('playPause');
                if (playPauseBtn) playPauseBtn.textContent = '▶';
            }
        };
        
        requestAnimationFrame(render);
    }

    async togglePlayback() {
        const videoElement = document.getElementById('videoPreview');
        const playPauseBtn = document.getElementById('playPause');
        
        try {
            if (this.videoState.isPlaying) {
                // Pause both managers
                this.timelineManager.pause();
                this.syncManager.pause();
                this.videoState.isPlaying = false;
                playPauseBtn.textContent = '▶';
            } else {
                // Ensure video is ready
                if (videoElement.readyState >= 2) {
                    // Start both managers
                    await Promise.all([
                        videoElement.play(),
                        this.timelineManager.play(),
                        this.syncManager.play()
                    ]);
                    this.videoState.isPlaying = true;
                    playPauseBtn.textContent = '⏸';
                    this.startRenderLoop();
                } else {
                    console.warn('Video not ready to play');
                    // Wait for video to be ready
                    await new Promise((resolve) => {
                        const checkReady = () => {
                            if (videoElement.readyState >= 2) {
                                resolve();
                            } else {
                                setTimeout(checkReady, 100);
                            }
                        };
                        checkReady();
                    });
                    // Try playing again
                    await Promise.all([
                        videoElement.play(),
                        this.timelineManager.play(),
                        this.syncManager.play()
                    ]);
                    this.videoState.isPlaying = true;
                    playPauseBtn.textContent = '⏸';
                    this.startRenderLoop();
                }
            }
        } catch (error) {
            console.error('Playback error:', error);
            this.videoState.isPlaying = false;
            playPauseBtn.textContent = '▶';
        }
    }

    handleTimeUpdate(time) {
        this.videoState.currentTime = time;
        
        // Update time display
        const currentTimeSpan = document.querySelector('.current-time');
        const durationSpan = document.querySelector('.duration');
        
        if (currentTimeSpan) {
            currentTimeSpan.textContent = this.formatTime(time);
        }
        if (durationSpan) {
            durationSpan.textContent = this.formatTime(this.videoState.duration);
        }
        
        // Keep video and timeline in sync
        const videoElement = document.getElementById('videoPreview');
        if (videoElement && Math.abs(time - videoElement.currentTime) > 0.1) {
            videoElement.currentTime = time;
            this.syncManager.seek(time);
        }
    }

    handleMarkerSelect(layerId) {
        const layer = this.timelineManager.getLayerById(layerId);
        if (!layer) return;
        
        // Update properties panel
        this.updatePropertiesPanel(layer);
    }

    updatePropertiesPanel(layer) {
        // Update transform controls
        document.getElementById('scaleRange').value = layer.transform?.scale || 1;
        document.getElementById('rotateRange').value = layer.transform?.rotate || 0;
        document.getElementById('distortRange').value = layer.transform?.distort || 0;
        document.getElementById('skewX').value = layer.transform?.skewX || 0;
        document.getElementById('skewY').value = layer.transform?.skewY || 0;
        document.getElementById('posX').value = layer.transform?.posX || 0;
        document.getElementById('posY').value = layer.transform?.posY || 0;
        
        // Update corner pin if available
        if (layer.hasCornerPin) {
            // Update corner pin canvas
            this.updateCornerPinCanvas(layer.cornerPin);
        }
    }

    updateCornerPinCanvas(cornerPin) {
        const canvas = document.getElementById('cornerPinCanvas');
        const ctx = canvas.getContext('2d');
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Draw corner points and connections
        ctx.beginPath();
        ctx.moveTo(cornerPin.topLeft.x, cornerPin.topLeft.y);
        ctx.lineTo(cornerPin.topRight.x, cornerPin.topRight.y);
        ctx.lineTo(cornerPin.bottomRight.x, cornerPin.bottomRight.y);
        ctx.lineTo(cornerPin.bottomLeft.x, cornerPin.bottomLeft.y);
        ctx.closePath();
        
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Draw corner points
        [cornerPin.topLeft, cornerPin.topRight, cornerPin.bottomLeft, cornerPin.bottomRight]
            .forEach((point, index) => {
                ctx.beginPath();
                ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#FFFFFF';
                ctx.fill();
                ctx.stroke();
            });
    }

    handleResize() {
        // Update renderer
        this.renderer.resize(
            this.renderer.canvas.clientWidth,
            this.renderer.canvas.clientHeight
        );
        
        // Update timeline
        this.timelineManager.handleResize();
    }

    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }

    handleDrop(e) {
        e.preventDefault();
        
        const file = e.dataTransfer.files[0];
        if (!file || !file.type.startsWith('video/')) return;
        
        // Create file input event
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        
        const videoInput = document.getElementById('videoUpload');
        videoInput.files = dataTransfer.files;
        videoInput.dispatchEvent(new Event('change'));
    }

    async exportVideo() {
        // Show progress bar
        const progressBar = document.querySelector('.progress-bar');
        const progressBarFill = document.querySelector('.progress-bar-fill');
        progressBar.style.display = 'block';
        progressBarFill.style.width = '0%';
        
        try {
            // Get all active layers
            const layers = this.timelineManager.getAllLayers();
            
            // Create temporary canvas for export
            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = this.renderer.canvas.width;
            exportCanvas.height = this.renderer.canvas.height;
            
            // Create temporary renderer
            const exportRenderer = new WebGLRenderer(exportCanvas);
            
            // Export frames
            const frameCount = Math.ceil(this.videoState.duration * this.videoState.fps);
            const frames = [];
            
            for (let frame = 0; frame < frameCount; frame++) {
                const time = frame / this.videoState.fps;
                
                // Update all videos to current frame time
                await Promise.all(layers.map(async layer => {
                    if (layer.videoElement) {
                        layer.videoElement.currentTime = time;
                        await new Promise(resolve => {
                            const onSeeked = () => {
                                layer.videoElement.removeEventListener('seeked', onSeeked);
                                resolve();
                            };
                            layer.videoElement.addEventListener('seeked', onSeeked);
                        });
                    }
                }));
                
                // Render frame
                const activeLayers = layers.filter(layer => 
                    layer.isMainTrack || 
                    (frame >= layer.startFrame && frame <= layer.endFrame)
                );
                
                exportRenderer.render({ layers: activeLayers });
                
                // Capture frame
                const frameData = exportCanvas.toDataURL('image/png');
                frames.push(frameData);
                
                // Update progress
                progressBarFill.style.width = `${(frame + 1) / frameCount * 100}%`;
            }
            
            // Create video from frames
            const videoBlob = await this.createVideoFromFrames(frames);
            
            // Create download link
            const url = URL.createObjectURL(videoBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'exported_video.mp4';
            a.click();
            
            // Clean up
            URL.revokeObjectURL(url);
            progressBar.style.display = 'none';
            
        } catch (error) {
            console.error('Export error:', error);
            alert('Error exporting video: ' + error.message);
            progressBar.style.display = 'none';
        }
    }

    async createVideoFromFrames(frames) {
        // This would use a video encoding library or WebCodecs API
        // For now, we'll use a simple canvas-based approach
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(this.videoState.fps);
        const mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'video/webm;codecs=vp9'
        });
        
        const chunks = [];
        mediaRecorder.ondataavailable = e => chunks.push(e.data);
        
        return new Promise((resolve, reject) => {
            mediaRecorder.onstop = () => {
                const blob = new Blob(chunks, { type: 'video/webm' });
                resolve(blob);
            };
            
            mediaRecorder.onerror = reject;
            
            mediaRecorder.start();
            
            let frameIndex = 0;
            const drawFrame = () => {
                if (frameIndex >= frames.length) {
                    mediaRecorder.stop();
                    return;
                }
                
                const img = new Image();
                img.onload = () => {
                    ctx.drawImage(img, 0, 0);
                    frameIndex++;
                    requestAnimationFrame(drawFrame);
                };
                img.src = frames[frameIndex];
            };
            
            drawFrame();
        });
    }

    formatTime(seconds) {
        if (typeof seconds !== 'number' || isNaN(seconds)) {
            return '0:00';
        }
        const minutes = Math.floor(Math.max(0, seconds) / 60);
        const remainingSeconds = Math.floor(Math.max(0, seconds) % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    destroy() {
        // Clean up components
        this.renderer.destroy();
        this.syncManager.destroy();
        this.timelineManager.destroy();
        
        // Remove event listeners
        window.removeEventListener('resize', this.handleResize);
        
        // Clear video state
        this.videoState = null;
    }

    async loadDefaultVideos() {
        try {
            // Initialize video cache
            await this.videoCache.init();

            // Get main video from cache
            const mainVideoBlob = await this.videoCache.getVideo('mainVideo');
            const mainVideoFile = await this.videoCache.createVideoFile('mainVideo', mainVideoBlob);

            // Load the main video
            const mainVideoDataTransfer = new DataTransfer();
            mainVideoDataTransfer.items.add(mainVideoFile);
            const videoInput = document.getElementById('videoUpload');
            videoInput.files = mainVideoDataTransfer.files;
            videoInput.dispatchEvent(new Event('change'));

            // Wait for the main video to load
            await new Promise((resolve) => {
                const checkVideo = () => {
                    if (document.getElementById('videoPreview').readyState >= 2) {
                        resolve();
                    } else {
                        setTimeout(checkVideo, 100);
                    }
                };
                checkVideo();
            });

            // Get luma matte from cache
            const lumaMatteBlob = await this.videoCache.getVideo('lumaMatte');
            const lumaMatteFile = await this.videoCache.createVideoFile('lumaMatte', lumaMatteBlob);

            // Select the main track marker
            const mainMarker = document.querySelector('.thumbnail-marker.main-track');
            if (mainMarker) {
                mainMarker.click(); // Select the main track

                // Set up luma matte input
                const lumaMatteDataTransfer = new DataTransfer();
                lumaMatteDataTransfer.items.add(lumaMatteFile);
                const lumaMatteInput = document.getElementById('toggleLumaMatte');
                if (lumaMatteInput) {
                    lumaMatteInput.click(); // Open luma matte dialog
                    // Simulate file selection
                    const event = new Event('change');
                    Object.defineProperty(event, 'target', {
                        value: { files: lumaMatteDataTransfer.files },
                        enumerable: true
                    });
                    lumaMatteInput.dispatchEvent(event);
                }
            }

            console.log('Default videos loaded successfully');
        } catch (error) {
            console.error('Error loading default videos:', error);
        }
    }
}

// Create and export app instance
const app = new VideoMontageApp();
export default app; 