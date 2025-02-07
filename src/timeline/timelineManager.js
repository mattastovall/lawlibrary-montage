class TimelineManager {
    constructor(config = {}) {
        this.tracks = new Map();
        this.markers = new Map();
        this.currentTime = 0;
        this.duration = 0;
        this.isPlaying = false;
        this.listeners = new Set();
        this.manualDuration = null; // Track if duration is manually set
        this.dimensions = {
            width: window.innerWidth,
            height: window.innerHeight
        };

        // UI elements
        this.container = config.container || null;
        this.timelineGrid = config.timelineGrid || null;
        this.thumbnailMarkers = config.thumbnailMarkers || null;
        this.playheadMarker = config.playheadMarker || null;

        // Callbacks
        this.onMarkerSelect = config.onMarkerSelect || (() => {});
        this.onTimeUpdate = config.onTimeUpdate || (() => {});

        // Initialize UI if elements are provided
        if (this.container && this.timelineGrid && this.thumbnailMarkers) {
            this.initializeUI();
        }
    }

    initializeUI() {
        // Set up timeline grid
        if (this.timelineGrid) {
            this.timelineGrid.innerHTML = '';
            // Grid will be populated when duration is set
        }

        // Set up thumbnail markers container
        if (this.thumbnailMarkers) {
            this.thumbnailMarkers.innerHTML = '';
            // Markers will be added when tracks are created
        }

        // Set up playhead marker
        if (this.playheadMarker) {
            this.updatePlayhead(0);
        }
    }

    updatePlayhead(time) {
        if (this.playheadMarker && this.duration > 0) {
            const progress = time / this.duration;
            const containerWidth = this.container ? this.container.clientWidth : 0;
            this.playheadMarker.style.left = `${progress * containerWidth}px`;
        }
    }

    addTrack(trackId, track) {
        this.tracks.set(trackId, track);
        this.updateDuration();
    }

    removeTrack(trackId) {
        this.tracks.delete(trackId);
        this.updateDuration();
    }

    updateDuration() {
        if (this.manualDuration !== null) {
            this.duration = this.manualDuration;
        } else {
            this.duration = Math.max(
                ...Array.from(this.tracks.values())
                    .map(track => track.duration || 0)
            );
        }
    }

    setDuration(duration) {
        if (duration >= 0) {
            this.manualDuration = duration;
            this.duration = duration;
            this.createTimelineGrid();
            this.notifyListeners();
        }
    }

    // Reset to automatic duration calculation
    resetDuration() {
        this.manualDuration = null;
        this.updateDuration();
        this.notifyListeners();
    }

    seek(time) {
        const newTime = Math.max(0, Math.min(time, this.duration));
        if (this.currentTime !== newTime) {
            this.currentTime = newTime;
            
            // Update all video elements
            for (const marker of this.markers.values()) {
                if (marker.videoElement) {
                    if (Math.abs(marker.videoElement.currentTime - this.currentTime) > 0.1) {
                        marker.videoElement.currentTime = this.currentTime;
                    }
                }
            }
            
            this.notifyListeners();
        }
    }

    play() {
        if (!this.isPlaying) {
            this.isPlaying = true;
            
            // Play all video elements
            for (const marker of this.markers.values()) {
                if (marker.videoElement) {
                    // Ensure video is at the correct time
                    if (Math.abs(marker.videoElement.currentTime - this.currentTime) > 0.1) {
                        marker.videoElement.currentTime = this.currentTime;
                    }
                    
                    // Only play if video is ready
                    if (marker.videoElement.readyState >= 2) {
                        marker.videoElement.play().catch(error => {
                            console.error('Error playing video:', error, marker);
                        });
                    } else {
                        // Wait for video to be ready
                        const onCanPlay = () => {
                            marker.videoElement.play().catch(error => {
                                console.error('Error playing video after ready:', error, marker);
                            });
                            marker.videoElement.removeEventListener('canplay', onCanPlay);
                        };
                        marker.videoElement.addEventListener('canplay', onCanPlay);
                    }
                }
            }

            this.lastFrameTime = performance.now();
            this.animate();
        }
    }

    pause() {
        if (this.isPlaying) {
            this.isPlaying = false;
            
            // Pause all video elements
            for (const marker of this.markers.values()) {
                if (marker.videoElement) {
                    marker.videoElement.pause();
                }
            }
        }
    }

    animate() {
        if (!this.isPlaying) return;

        const now = performance.now();
        const deltaTime = (now - this.lastFrameTime) / 1000;
        this.lastFrameTime = now;

        // Update current time
        const newTime = Math.min(this.currentTime + deltaTime, this.duration);
        
        // Check if we've reached the end
        if (newTime >= this.duration) {
            this.currentTime = 0;
            // Reset all videos to start
            for (const marker of this.markers.values()) {
                if (marker.videoElement) {
                    marker.videoElement.currentTime = 0;
                }
            }
        } else {
            this.currentTime = newTime;
        }

        // Sync videos if they drift
        for (const marker of this.markers.values()) {
            if (marker.videoElement) {
                const drift = Math.abs(marker.videoElement.currentTime - this.currentTime);
                if (drift > 0.1) {
                    marker.videoElement.currentTime = this.currentTime;
                }
            }
        }

        this.notifyListeners();
        
        if (this.isPlaying) {
            requestAnimationFrame(() => this.animate());
        }
    }

    addListener(callback) {
        this.listeners.add(callback);
    }

    removeListener(callback) {
        this.listeners.delete(callback);
    }

    notifyListeners() {
        for (const listener of this.listeners) {
            listener(this.currentTime);
        }
        // Call the time update callback
        if (this.onTimeUpdate) {
            this.onTimeUpdate(this.currentTime);
        }
        // Update playhead position
        this.updatePlayhead(this.currentTime);
    }

    getCurrentTime() {
        return this.currentTime;
    }

    getDuration() {
        return this.duration;
    }

    getPlaybackState() {
        return this.isPlaying;
    }

    createMarker(trackConfig) {
        const { id, isMainTrack, zIndex, videoElement, startFrame, endFrame } = trackConfig;
        
        // Set up video element if provided
        if (videoElement) {
            videoElement.muted = true;
            videoElement.playsInline = true;
            if (isMainTrack) {
                videoElement.loop = true;
            }
        }
        
        const marker = {
            id,
            isMainTrack: isMainTrack || false,
            zIndex: zIndex || 0,
            videoElement,
            startFrame,
            endFrame,
            duration: videoElement ? videoElement.duration : 0
        };

        this.markers.set(id, marker);
        
        // If this is a video track, also add it to the tracks map
        if (videoElement) {
            this.addTrack(id, {
                element: videoElement,
                duration: videoElement.duration || 0,
                startTime: startFrame || 0
            });
        }

        // Create visual marker element
        this.createVisualMarker(marker);

        return marker;
    }

    createVisualMarker(marker) {
        if (!this.thumbnailMarkers) return;

        const visualMarker = document.createElement('div');
        visualMarker.className = 'thumbnail-marker';
        if (marker.isMainTrack) {
            visualMarker.classList.add('main-track');
        }
        visualMarker.dataset.id = marker.id;

        // Calculate position and size
        const timelineWidth = this.container ? this.container.clientWidth : 742.74; // Default width if container not available
        const totalFrames = Math.floor(this.duration * 30); // Assuming 30fps
        const frameWidth = timelineWidth / totalFrames;

        if (marker.isMainTrack) {
            visualMarker.style.left = '0';
            visualMarker.style.width = '100%';
            visualMarker.style.backgroundColor = 'rgba(40, 40, 40, 0.8)';
            marker.endFrame = totalFrames;
        } else {
            visualMarker.style.left = `${marker.startFrame * frameWidth}px`;
            visualMarker.style.width = `${(marker.endFrame - marker.startFrame) * frameWidth}px`;
        }

        visualMarker.style.zIndex = marker.zIndex;
        const baseOffset = 0;
        const verticalSpacing = 70;
        visualMarker.style.top = `${baseOffset + (marker.zIndex - 1) * verticalSpacing}px`;

        // Add video selection button for non-main tracks
        if (!marker.isMainTrack) {
            const selectButton = document.createElement('button');
            selectButton.className = 'select-video-btn';
            selectButton.textContent = marker.videoElement ? '🎥' : '➕';
            selectButton.title = marker.videoElement ? 'Change Video' : 'Add Video';
            visualMarker.appendChild(selectButton);
        }

        // Add click handler
        visualMarker.addEventListener('click', (e) => {
            if (e.target === visualMarker) {
                this.handleMarkerClick(marker.id);
            }
        });

        // Add to timeline
        this.thumbnailMarkers.appendChild(visualMarker);
    }

    handleMarkerClick(markerId) {
        // Remove selected class from all markers
        const markers = this.thumbnailMarkers.querySelectorAll('.thumbnail-marker');
        markers.forEach(m => m.classList.remove('selected'));

        // Add selected class to clicked marker
        const clickedMarker = this.thumbnailMarkers.querySelector(`[data-id="${markerId}"]`);
        if (clickedMarker) {
            clickedMarker.classList.add('selected');
        }

        // Call the selection callback
        if (this.onMarkerSelect) {
            this.onMarkerSelect(markerId);
        }
    }

    getMarker(markerId) {
        return this.markers.get(markerId);
    }

    updateMarker(markerId, updates) {
        const marker = this.markers.get(markerId);
        if (marker) {
            Object.assign(marker, updates);
            
            // If updating a video track, also update the track info
            if (marker.videoElement && this.tracks.has(markerId)) {
                const track = this.tracks.get(markerId);
                if (updates.startFrame !== undefined) {
                    track.startTime = updates.startFrame;
                }
                if (updates.videoElement !== undefined) {
                    track.element = updates.videoElement;
                    track.duration = updates.videoElement.duration || 0;
                }
            }
        }
    }

    removeMarker(markerId) {
        this.markers.delete(markerId);
        // If it was also a video track, remove it from tracks
        if (this.tracks.has(markerId)) {
            this.removeTrack(markerId);
        }
    }

    getMarkers() {
        return Array.from(this.markers.values())
            .sort((a, b) => b.zIndex - a.zIndex);
    }

    handleResize(width, height) {
        this.dimensions = { width, height };
        
        // Update all video elements to match new dimensions
        for (const marker of this.markers.values()) {
            if (marker.videoElement) {
                // Maintain aspect ratio while fitting within new dimensions
                const videoAspect = marker.videoElement.videoWidth / marker.videoElement.videoHeight;
                const containerAspect = width / height;
                
                let newWidth, newHeight;
                if (videoAspect > containerAspect) {
                    // Video is wider than container
                    newWidth = width;
                    newHeight = width / videoAspect;
                } else {
                    // Video is taller than container
                    newHeight = height;
                    newWidth = height * videoAspect;
                }
                
                marker.videoElement.style.width = `${newWidth}px`;
                marker.videoElement.style.height = `${newHeight}px`;
            }
        }
        
        // Notify listeners of resize
        this.notifyListeners();
    }

    getDimensions() {
        return this.dimensions;
    }

    getLayerById(layerId) {
        return this.markers.get(layerId);
    }

    getAllLayers() {
        return Array.from(this.markers.values());
    }

    getActiveLayers(time) {
        return Array.from(this.markers.values()).filter(layer => {
            if (layer.isMainTrack) return true;
            const startTime = layer.startFrame / 30; // assuming 30fps
            const endTime = layer.endFrame / 30;
            return time >= startTime && time <= endTime;
        });
    }

    destroy() {
        this.tracks.clear();
        this.markers.clear();
        this.listeners.clear();
        if (this.timelineGrid) {
            this.timelineGrid.innerHTML = '';
        }
        if (this.thumbnailMarkers) {
            this.thumbnailMarkers.innerHTML = '';
        }
    }

    createTimelineGrid() {
        if (!this.timelineGrid) return;

        // Clear existing grid
        this.timelineGrid.innerHTML = '';

        const fps = 30;
        const duration = this.duration;
        const timelineWidth = 742.74; // Fixed timeline width
        
        // Calculate spacing
        const secondWidth = timelineWidth / Math.ceil(duration); // Ensure even distribution
        const frameWidth = secondWidth / fps; // Width per frame

        // Create grid lines and labels for each second
        for (let i = 0; i <= Math.ceil(duration); i++) {
            // Don't create elements that would go beyond timeline width
            if (i * secondWidth <= timelineWidth) {
                // Create second marker
                const gridLine = document.createElement('div');
                gridLine.className = 'grid-line major';
                gridLine.style.left = `${i * secondWidth}px`;
                
                // Create second label
                const label = document.createElement('div');
                label.className = 'grid-label';
                label.textContent = `${i}s`;
                label.style.left = `${i * secondWidth}px`;
                
                this.timelineGrid.appendChild(gridLine);
                this.timelineGrid.appendChild(label);

                // Add frame markers between seconds
                if (i < Math.ceil(duration)) {
                    for (let f = 1; f < fps; f++) {
                        const framePosition = (i * secondWidth) + (f * frameWidth);
                        if (framePosition <= timelineWidth) {
                            const frameMarker = document.createElement('div');
                            frameMarker.className = 'grid-line frame';
                            frameMarker.style.left = `${framePosition}px`;
                            frameMarker.style.height = '10px';
                            frameMarker.style.opacity = '0.2';
                            this.timelineGrid.appendChild(frameMarker);
                        }
                    }
                }
            }
        }

        // Update marker positions based on new grid
        this.markers.forEach(marker => {
            const visualMarker = this.thumbnailMarkers.querySelector(`[data-id="${marker.id}"]`);
            if (visualMarker) {
                if (marker.isMainTrack) {
                    visualMarker.style.left = '0';
                    visualMarker.style.width = '100%';
                } else {
                    const startPosition = (marker.startFrame / fps) * secondWidth;
                    const endPosition = (marker.endFrame / fps) * secondWidth;
                    visualMarker.style.left = `${startPosition}px`;
                    visualMarker.style.width = `${endPosition - startPosition}px`;
                }
            }
        });
    }
}

export default TimelineManager; 