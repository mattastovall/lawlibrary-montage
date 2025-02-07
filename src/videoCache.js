// Cache configuration
const CACHE_NAME = 'video-cache-v1';
const VIDEO_SOURCES = {
    mainVideo: '/Intro - Montage TopLayer.mp4',
    lumaMatte: '/Intro - Montage LumaMatte.mp4'
    // Later we can add AWS URLs here:
    // mainVideo: 'https://your-aws-bucket.s3.amazonaws.com/Intro-Montage-TopLayer.mp4',
    // lumaMatte: 'https://your-aws-bucket.s3.amazonaws.com/Intro-Montage-LumaMatte.mp4'
};

class VideoCacheManager {
    constructor() {
        this.cache = null;
    }

    async init() {
        try {
            // Open or create the cache
            this.cache = await caches.open(CACHE_NAME);
            console.log('Video cache initialized');
        } catch (error) {
            console.error('Failed to initialize cache:', error);
            throw error;
        }
    }

    async getVideo(key) {
        if (!this.cache) {
            await this.init();
        }

        const videoUrl = VIDEO_SOURCES[key];
        if (!videoUrl) {
            throw new Error(`No video URL found for key: ${key}`);
        }

        try {
            // Check cache first
            const cachedResponse = await this.cache.match(videoUrl);
            if (cachedResponse) {
                console.log(`Found cached video for ${key}`);
                return cachedResponse.blob();
            }

            // If not in cache, fetch and cache
            console.log(`Fetching and caching video for ${key}`);
            const response = await fetch(videoUrl);
            const clonedResponse = response.clone();
            await this.cache.put(videoUrl, clonedResponse);
            return response.blob();
        } catch (error) {
            console.error(`Error fetching video for ${key}:`, error);
            throw error;
        }
    }

    async preloadAll() {
        try {
            const promises = Object.keys(VIDEO_SOURCES).map(key => this.getVideo(key));
            await Promise.all(promises);
            console.log('All videos preloaded');
        } catch (error) {
            console.error('Error preloading videos:', error);
            throw error;
        }
    }

    async clearCache() {
        try {
            await caches.delete(CACHE_NAME);
            this.cache = null;
            console.log('Video cache cleared');
        } catch (error) {
            console.error('Error clearing cache:', error);
            throw error;
        }
    }

    // Helper method to create a File object from a blob
    async createVideoFile(key, blob) {
        const filename = VIDEO_SOURCES[key].split('/').pop();
        return new File([blob], filename, { type: 'video/mp4' });
    }
}

export const videoCacheManager = new VideoCacheManager(); 