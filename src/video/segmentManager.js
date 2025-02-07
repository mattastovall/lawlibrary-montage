import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

class VideoSegmentManager {
    constructor() {
        this.ffmpeg = new FFmpeg();
        this.isLoaded = false;
        this.segmentDuration = 3; // seconds
        this.progressCallback = null;
        this.terminated = false; // Add termination flag
    }

    async initialize() {
        if (this.terminated) {
            throw new Error('VideoSegmentManager has been terminated');
        }
        if (this.isLoaded) {
            return;
        }
        await this.ffmpeg.load();
        this.ffmpeg.on('progress', ({ progress }) => {
            if (this.progressCallback) {
                this.progressCallback(progress);
            }
        });
        this.isLoaded = true;
    }

    setProgressCallback(callback) {
        this.progressCallback = callback;
    }

    async generateSegments(videoBlob, quality, startTime = 0) {
        if (this.terminated) {
            throw new Error('VideoSegmentManager has been terminated');
        }
        if (!this.isLoaded) {
            await this.initialize();
        }

        const videoName = 'input_video';
        const videoData = new Uint8Array(await videoBlob.arrayBuffer());
        await this.ffmpeg.writeFile(videoName, videoData);

        const segments = [];
        const duration = await this.getVideoDuration(videoName);
        const numSegments = Math.ceil((duration - startTime) / this.segmentDuration);

        // Generate initialization segment
        const initSegmentName = `init_${quality}.mp4`;
        await this.ffmpeg.exec([
            '-i', videoName,
            '-map', '0',
            '-c', 'copy',
            '-f', 'mp4',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-frag_duration', '100000', // Fragment duration in microseconds
            '-min_frag_duration', '100000',
            '-reset_timestamps', '1',
            '-vsync', '0',
            '-copyts',
            '-start_at_zero',
            initSegmentName
        ]);
        const initSegmentData = await this.ffmpeg.readFile(initSegmentName);
        segments.push({ isInit: true, data: initSegmentData, quality });
        await this.ffmpeg.deleteFile(initSegmentName);

        // Generate media segments
        for (let i = 0; i < numSegments; i++) {
            const segmentStartTime = startTime + i * this.segmentDuration;
            if (segmentStartTime >= duration) {
                break; // No more segments needed
            }
            const segmentName = `segment_${quality}_${i}.m4s`;
            const segmentArgs = [
                '-i', videoName,
                '-map', '0',
                '-c', 'copy',
                '-f', 'mp4',
                '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                '-frag_duration', '100000',
                '-min_frag_duration', '100000',
                '-reset_timestamps', '1',
                '-vsync', '0',
                '-copyts',
                '-start_at_zero',
                '-ss', segmentStartTime.toFixed(3),
                '-t', this.segmentDuration.toFixed(3),
                segmentName
            ];

            await this.ffmpeg.exec(segmentArgs);
            const segmentData = await this.ffmpeg.readFile(segmentName);
            segments.push({ isInit: false, data: segmentData, quality });
            await this.ffmpeg.deleteFile(segmentName);
        }

        await this.ffmpeg.deleteFile(videoName);
        return segments;
    }

    async getVideoDuration(videoName) {
        if (this.terminated) {
            throw new Error('VideoSegmentManager has been terminated');
        }
        let duration = 0;
        try {
            // Use ffprobe to get video duration
            await this.ffmpeg.exec(['-i', videoName, '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '-v', 'quiet', 'duration.txt']);
            const durationData = await this.ffmpeg.readFile('duration.txt');
            duration = parseFloat(new TextDecoder().decode(durationData));
            await this.ffmpeg.deleteFile('duration.txt');

        } catch (error) {
            console.error('Error getting video duration:', error);
            return 0; // Return 0 on error
        }
        return duration;
    }

    async terminate() {
        if (this.terminated) {
            return; // Already terminated
        }
        this.terminated = true;
        this.isLoaded = false;
        if (this.ffmpeg) {
            try {
                // Clean up any remaining files
                const files = await this.ffmpeg.listDir('/');
                for (const file of files) {
                    if (file.name !== '.' && file.name !== '..') {
                        await this.ffmpeg.deleteFile(file.name);
                    }
                }
                // Unload FFmpeg (if supported by the version)
                if (this.ffmpeg.exit) {
                    await this.ffmpeg.exit();
                }
            } catch (e) {
                console.warn('Error during FFmpeg cleanup:', e);
            }
            this.ffmpeg = null; // Release reference
        }
        this.progressCallback = null;
    }
}

export default VideoSegmentManager; 