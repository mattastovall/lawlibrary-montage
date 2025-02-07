class VideoSyncManager {
    constructor() {
        this.videos = new Map();
        this.currentTime = 0;
        this.isPlaying = false;
        this.listeners = new Set();
        this.masterVideoId = null;
    }

    addVideo(videoId, videoElement) {
        this.videos.set(videoId, {
            element: videoElement,
            startTime: 0,
            duration: videoElement.duration || 0
        });
    }

    removeVideo(videoId) {
        this.videos.delete(videoId);
    }

    play() {
        if (!this.isPlaying) {
            this.isPlaying = true;
            this.syncVideosToMaster();
            for (const [_, video] of this.videos) {
                if (video.element.readyState >= 2) {
                    video.element.play();
                }
            }
        }
    }

    pause() {
        this.isPlaying = false;
        for (const [_, video] of this.videos) {
            video.element.pause();
        }
    }

    seek(time) {
        this.currentTime = time;
        this.syncVideosToMaster();
        this.notifyListeners();
    }

    setVideoStartTime(videoId, startTime) {
        const video = this.videos.get(videoId);
        if (video) {
            video.startTime = startTime;
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
    }

    getCurrentTime() {
        return this.currentTime;
    }

    getPlaybackState() {
        return this.isPlaying;
    }

    handleVideoTimeUpdate(videoId) {
        const video = this.videos.get(videoId);
        if (video && this.isPlaying && videoId === this.masterVideoId) {
            this.currentTime = video.element.currentTime + video.startTime;
            this.syncVideosToMaster();
            this.notifyListeners();
        }
    }

    handleVideoEnded(videoId) {
        const video = this.videos.get(videoId);
        if (video) {
            video.element.currentTime = 0;
            if (this.isPlaying) {
                video.element.play();
            }
        }
    }

    handleVideoError(videoId, error) {
        console.error(`Error with video ${videoId}:`, error);
    }

    setMasterVideo(videoIdOrElement) {
        let videoId;
        
        // Handle both video ID and video element cases
        if (typeof videoIdOrElement === 'string') {
            videoId = videoIdOrElement;
        } else if (videoIdOrElement instanceof HTMLVideoElement) {
            // Find the video ID by matching the element
            for (const [id, video] of this.videos) {
                if (video.element === videoIdOrElement) {
                    videoId = id;
                    break;
                }
            }
        }

        if (!videoId || !this.videos.has(videoId)) {
            throw new Error('Video not found');
        }

        this.masterVideoId = videoId;
        const masterVideo = this.videos.get(videoId);

        if (masterVideo) {
            this.currentTime = masterVideo.element.currentTime + masterVideo.startTime;
            this.syncVideosToMaster();
        }

        masterVideo.element.addEventListener('timeupdate', () => {
            if (this.isPlaying && videoId === this.masterVideoId) {
                this.handleVideoTimeUpdate(videoId);
            }
        });
    }

    getMasterVideo() {
        return this.masterVideoId ? this.videos.get(this.masterVideoId) : null;
    }

    syncVideosToMaster() {
        if (!this.masterVideoId) return;

        const masterVideo = this.videos.get(this.masterVideoId);
        if (!masterVideo) return;

        const masterTime = masterVideo.element.currentTime + masterVideo.startTime;

        for (const [id, video] of this.videos) {
            if (id !== this.masterVideoId) {
                const adjustedTime = Math.max(0, masterTime - video.startTime);
                if (adjustedTime <= video.duration) {
                    video.element.currentTime = adjustedTime;
                }
            }
        }
    }
}

export default VideoSyncManager; 