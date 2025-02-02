import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

// Initialize FFmpeg
const ffmpeg = new FFmpeg({
    log: true,
});
let isFFmpegLoaded = false;

// Initialize video worker
const videoWorker = new Worker(new URL('./videoWorker.js', import.meta.url), { type: 'module' });

// WebGL shader sources
const vertexShaderSource = `
    attribute vec2 position;
    varying vec2 vTexCoord;
    uniform mat4 transform;
    uniform vec4 cornerPin;
    uniform vec4 cornerPin2;
    
    void main() {
        // Simple pass-through vertex shader for testing
        gl_Position = vec4(position, 0.0, 1.0);
        
        // Calculate texture coordinates - flip Y coordinate for WebGL
        vTexCoord = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
    }
`;

const fragmentShaderSource = `
    precision mediump float;
    uniform sampler2D videoTexture;
    uniform sampler2D lumaTexture;
    uniform float useLumaMatte;
    varying vec2 vTexCoord;

    // Function to calculate luminance
    float getLuminance(vec3 color) {
        return dot(color, vec3(0.299, 0.587, 0.114));
    }

    void main() {
        // Sample main video texture
        vec4 texColor = texture2D(videoTexture, vTexCoord);
        
        if (useLumaMatte > 0.5) {
            // Sample luma matte texture
            vec4 lumaColor = texture2D(lumaTexture, vTexCoord);
            
            // Calculate alpha from luma matte luminance
            float alpha = getLuminance(lumaColor.rgb);
            
            // Apply luma matte alpha to video color
            gl_FragColor = vec4(texColor.rgb, alpha);
        } else {
            // No luma matte - use original video alpha
            gl_FragColor = texColor;
        }
    }
`;

// DOM Elements
const videoInput = document.getElementById('videoUpload');
const videoPreview = document.getElementById('videoPreview');
const canvas = document.getElementById('videoCanvas');
const applyTransformBtn = document.getElementById('applyTransform');
const exportVideoBtn = document.getElementById('exportVideo');
const addOverlayBtn = document.getElementById('addOverlay');
const overlayInput = document.getElementById('overlayUpload');
const dropZone = document.getElementById('dropZone');
const progressBar = document.querySelector('.progress-bar');
const progressBarFill = document.querySelector('.progress-bar-fill');
const playPauseBtn = document.getElementById('playPause');
const timelineContainer = document.querySelector('.timeline');
const timelineLine = document.querySelector('.timeline-line');

// Create playhead marker
const playheadMarker = document.createElement('div');
playheadMarker.className = 'playhead-marker';
timelineLine.appendChild(playheadMarker);

// Update playhead position
function updatePlayhead() {
    if (videoPreview.duration) {
        const progress = videoPreview.currentTime / videoPreview.duration;
        const timelineWidth = timelineLine.offsetWidth;
        playheadMarker.style.left = `${progress * timelineWidth}px`;
        requestAnimationFrame(updatePlayhead);
    }
}

// Add timeupdate event listener to video
videoPreview.addEventListener('play', () => {
    updatePlayhead();
});

videoPreview.addEventListener('timeupdate', () => {
    if (videoPreview.paused) {
        updatePlayhead();
    }
});

// Add timeline seeking functionality
timelineLine.addEventListener('click', (e) => {
    const rect = timelineLine.getBoundingClientRect();
    const clickPosition = e.clientX - rect.left;
    const progress = clickPosition / rect.width;
    videoPreview.currentTime = progress * videoPreview.duration;
});

// Transform controls
const scaleRange = document.getElementById('scaleRange');
const rotateRange = document.getElementById('rotateRange');
const distortRange = document.getElementById('distortRange');
const scaleValue = document.getElementById('scaleValue');
const rotateValue = document.getElementById('rotateValue');
const distortValue = document.getElementById('distortValue');

// Additional DOM Elements
const skewXInput = document.getElementById('skewX');
const skewYInput = document.getElementById('skewY');
const posXInput = document.getElementById('posX');
const posYInput = document.getElementById('posY');
const skewXValue = document.getElementById('skewXValue');
const skewYValue = document.getElementById('skewYValue');
const posXValue = document.getElementById('posXValue');
const posYValue = document.getElementById('posYValue');
const cornerPinCanvas = document.getElementById('cornerPinCanvas');
const resetCornerPinBtn = document.getElementById('resetCornerPin');

// WebGL context and program
let gl;
let program;
let videoTexture;
let transformMatrix = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
]);

// Corner pin state
let cornerPoints = [
    {x: 0, y: 0},    // top-left
    {x: 1, y: 0},    // top-right
    {x: 0, y: 1},    // bottom-left
    {x: 1, y: 1}     // bottom-right
];
let activePoint = null;

// Add these DOM elements after other DOM element declarations
const currentTimeSpan = document.querySelector('.current-time');
const durationSpan = document.querySelector('.duration');

// Update the formatTime function to handle NaN and invalid values
function formatTime(seconds) {
    if (typeof seconds !== 'number' || isNaN(seconds)) {
        return '0:00';
    }
    const minutes = Math.floor(Math.max(0, seconds) / 60);
    const remainingSeconds = Math.floor(Math.max(0, seconds) % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Add texture management for composite clips
let compositeTextures = new Map(); // Store textures for each composite clip

// Add video state tracking
let videoMetadata = {
    duration: 0,
    keyframeIntervals: [],
    lastBufferCheck: 0,
    isPlaying: false,
    hasAttemptedPlay: false,
    format: null,
    lastTimeUpdate: 0,
    unexpectedLoops: 0,
    preventLoop: false,
    lastValidTime: 0,
    endingPrevented: false,
    wasPlaying: false,
    lastJumpTime: 0,
    jumpCount: 0,
    expectedFrameTime: 1000 / 30, // assuming 30fps
    lastFrameTimestamp: 0,
    frameCount: 0,
    actualEndTime: 0,
    shouldLoop: true  // Add this flag
};

// Add DOM elements
const toggleLumaMatteBtn = document.getElementById('toggleLumaMatte');
const lumaMatteInput = document.createElement('input');
lumaMatteInput.type = 'file';
lumaMatteInput.accept = 'video/*';
lumaMatteInput.style.display = 'none';
document.body.appendChild(lumaMatteInput);

// Add luma matte texture
let lumaTexture;

// Add uniform locations as global variables
let videoTextureUniform;
let lumaTextureUniform;
let useLumaMatteUniform;

// Update initWebGL to store uniform locations
function initWebGL() {
    gl = canvas.getContext('webgl', { 
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        antialias: true
    });
    if (!gl) {
        console.error('WebGL not supported');
        return;
    }

    console.log('WebGL context created successfully');

    // Configure alpha blending
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
        gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,  // RGB channels
        gl.ONE, gl.ONE_MINUS_SRC_ALPHA         // Alpha channel
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    // Create shaders
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexShaderSource);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
        console.error('Vertex shader compile error:', gl.getShaderInfoLog(vertexShader));
        return;
    }
    console.log('Vertex shader compiled successfully');

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, fragmentShaderSource);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
        console.error('Fragment shader compile error:', gl.getShaderInfoLog(fragmentShader));
        return;
    }
    console.log('Fragment shader compiled successfully');

    // Create program
    program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
        return;
    }
    console.log('Program linked successfully');

    gl.useProgram(program);

    // Create vertex buffer
    const vertices = new Float32Array([
        -1, 1,   // top left
        1, 1,    // top right
        -1, -1,  // bottom left
        1, -1    // bottom right
    ]);
    
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // Set up attributes and uniforms
    const positionAttribute = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionAttribute);
    gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);

    // Create textures
    videoTexture = createVideoTexture();
    
    // Store uniform locations
    videoTextureUniform = gl.getUniformLocation(program, 'videoTexture');
    lumaTextureUniform = gl.getUniformLocation(program, 'lumaTexture');
    useLumaMatteUniform = gl.getUniformLocation(program, 'useLumaMatte');
    
    gl.uniform1i(videoTextureUniform, 0);  // Use texture unit 0
    gl.uniform1i(lumaTextureUniform, 1);   // Use texture unit 1
    gl.uniform1f(useLumaMatteUniform, 0.0);
    
    // Set initial viewport
    gl.viewport(0, 0, canvas.width, canvas.height);
    
    // Set initial uniforms
    updateTransform();
    
    // Clear canvas with transparent background
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    console.log('WebGL initialized successfully');
}

// Helper function to create a video texture
function createVideoTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    
    // Set texture parameters for video
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    // Initialize with a 1x1 transparent pixel
    gl.texImage2D(
        gl.TEXTURE_2D, 
        0, 
        gl.RGBA, 
        1, 1, 
        0, 
        gl.RGBA, 
        gl.UNSIGNED_BYTE, 
        new Uint8Array([0, 0, 0, 0])
    );
    
    return texture;
}

// Initialize corner pin canvas
function initCornerPin() {
    const ctx = cornerPinCanvas.getContext('2d');
    
    function updateCornerPinCanvas() {
        const baseWidth = 3840;
        const baseHeight = 2160;
        
        ctx.clearRect(0, 0, cornerPinCanvas.width, cornerPinCanvas.height);

        // Draw base dimension grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        
        // Vertical lines for base width
        ctx.moveTo(0, 0);
        ctx.lineTo(0, cornerPinCanvas.height);
        ctx.moveTo(cornerPinCanvas.width * (baseWidth / baseWidth), 0);
        ctx.lineTo(cornerPinCanvas.width * (baseWidth / baseWidth), cornerPinCanvas.height);
        
        // Horizontal lines for base height
        ctx.moveTo(0, 0);
        ctx.lineTo(cornerPinCanvas.width, 0);
        ctx.moveTo(0, cornerPinCanvas.height * (baseHeight / baseHeight));
        ctx.lineTo(cornerPinCanvas.width, cornerPinCanvas.height * (baseHeight / baseHeight));
        
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Draw lines between points
        ctx.beginPath();
        ctx.moveTo(cornerPoints[0].x * cornerPinCanvas.width / baseWidth, 
                   cornerPoints[0].y * cornerPinCanvas.height / baseHeight);
        ctx.lineTo(cornerPoints[1].x * cornerPinCanvas.width / baseWidth,
                   cornerPoints[1].y * cornerPinCanvas.height / baseHeight);
        ctx.lineTo(cornerPoints[3].x * cornerPinCanvas.width / baseWidth,
                   cornerPoints[3].y * cornerPinCanvas.height / baseHeight);
        ctx.lineTo(cornerPoints[2].x * cornerPinCanvas.width / baseWidth,
                   cornerPoints[2].y * cornerPinCanvas.height / baseHeight);
        ctx.lineTo(cornerPoints[0].x * cornerPinCanvas.width / baseWidth,
                   cornerPoints[0].y * cornerPinCanvas.height / baseHeight);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Draw points
        const labels = ['TL', 'TR', 'BL', 'BR'];
        cornerPoints.forEach((point, i) => {
            const x = point.x * cornerPinCanvas.width / baseWidth;
            const y = point.y * cornerPinCanvas.height / baseHeight;
            
            // Draw point circle
            ctx.beginPath();
            ctx.arc(x, y, 8, 0, Math.PI * 2);
            ctx.fillStyle = activePoint === i ? '#FF4444' : '#FFFFFF';
            ctx.fill();
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2;
            ctx.stroke();
            
            // Draw label
            ctx.fillStyle = '#000000';
            ctx.font = 'bold 12px Inter';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(labels[i], x, y - 20);
            
            // Draw coordinates
            ctx.fillStyle = '#FFFFFF';
            ctx.font = '10px Inter';
            ctx.fillText(`(${Math.round(point.x)}, ${Math.round(point.y)})`, x, y + 20);
        });
    }

    // Set canvas size
    function updateCanvasSize() {
        const container = cornerPinCanvas.parentElement;
        cornerPinCanvas.width = container.clientWidth;
        cornerPinCanvas.height = container.clientHeight;
        updateCornerPinCanvas();
    }

    // Reset corner points
    function resetCornerPoints() {
        const videoWidth = videoPreview.videoWidth || 3840;
        const videoHeight = videoPreview.videoHeight || 2160;
        
        // Scale down to 40% of the original size
        const scale = 0.4;
        const scaledWidth = videoWidth * scale;
        const scaledHeight = videoHeight * scale;
        
        // Center the scaled rectangle
        const centerX = videoWidth / 2;
        const centerY = videoHeight / 2;
        const halfScaledWidth = scaledWidth / 2;
        const halfScaledHeight = scaledHeight / 2;

        cornerPoints = [
            {x: centerX - halfScaledWidth, y: centerY - halfScaledHeight},  // top-left
            {x: centerX + halfScaledWidth, y: centerY - halfScaledHeight},  // top-right
            {x: centerX - halfScaledWidth, y: centerY + halfScaledHeight},  // bottom-left
            {x: centerX + halfScaledWidth, y: centerY + halfScaledHeight}   // bottom-right
        ];
        updateCornerPinCanvas();
        updateTransform();
    }

    // Initialize with default size
    updateCanvasSize();
    window.addEventListener('resize', updateCanvasSize);
    
    // Mouse interaction
    let isDragging = false;
    const hitRadius = 15; // Increased hit area for better interaction

    function getMousePos(e) {
        const rect = cornerPinCanvas.getBoundingClientRect();
        // Always use 3840x2160 coordinate system
        const baseWidth = 3840;
        const baseHeight = 2160;
        
        // Convert mouse position to our fixed coordinate system
        return {
            x: (e.clientX - rect.left) * (baseWidth / cornerPinCanvas.width),
            y: (e.clientY - rect.top) * (baseHeight / cornerPinCanvas.height)
        };
    }

    function findClosestPoint(pos) {
        const baseWidth = 3840;
        const baseHeight = 2160;
        const hitRadius = Math.min(baseWidth, baseHeight) * 0.02; // 2% of base size
        
        return cornerPoints.reduce((closest, point, index) => {
            const dist = Math.hypot(point.x - pos.x, point.y - pos.y);
            return dist < hitRadius && dist < closest.dist ? {index, dist} : closest;
        }, {index: -1, dist: Infinity});
    }

    cornerPinCanvas.addEventListener('mousemove', (e) => {
        const pos = getMousePos(e);
        
        if (isDragging && activePoint !== -1) {
            // Remove constraints to allow points beyond base dimensions
            cornerPoints[activePoint].x = pos.x;
            cornerPoints[activePoint].y = pos.y;
            updateCornerPinCanvas();
            updateTransform();
        } else {
            // Highlight closest point
            const closest = findClosestPoint(pos);
            if (closest.index !== activePoint) {
                activePoint = closest.index;
                cornerPinCanvas.style.cursor = activePoint !== -1 ? 'grab' : 'default';
                updateCornerPinCanvas();
            }
        }
    });
    
    cornerPinCanvas.addEventListener('mousedown', (e) => {
        if (activePoint !== -1) {
            isDragging = true;
            cornerPinCanvas.style.cursor = 'grabbing';
            e.preventDefault(); // Prevent text selection
        }
    });
    
    document.addEventListener('mouseup', () => {
        isDragging = false;
        cornerPinCanvas.style.cursor = activePoint !== -1 ? 'grab' : 'default';
    });
    
    cornerPinCanvas.addEventListener('mouseleave', () => {
        if (!isDragging) {
            activePoint = -1;
            updateCornerPinCanvas();
        }
    });
    
    resetCornerPinBtn.addEventListener('click', resetCornerPoints);
    
    // Initial setup
    resetCornerPoints();
}

// Update transform function
function updateTransform() {
    if (!gl || !program) return;

    // Get values from controls
    const scale = parseFloat(scaleRange.value);
    const rotate = parseFloat(rotateRange.value) * Math.PI / 180;
    const distort = parseFloat(distortRange.value);
    const skewX = parseFloat(skewXInput.value) * Math.PI / 180;
    const skewY = parseFloat(skewYInput.value) * Math.PI / 180;
    const posX = parseFloat(posXInput.value);
    const posY = parseFloat(posYInput.value);

    // Create transformation matrix
    const transform = new Float32Array([
        scale * Math.cos(rotate), -Math.sin(rotate) + Math.tan(skewX),  0, 0,
        Math.sin(rotate) + Math.tan(skewY),  scale * Math.cos(rotate),  0, 0,
        0,                       0,                                      1, 0,
        posX,                    posY,                                   0, 1
    ]);

    // Update uniforms
    const transformUniform = gl.getUniformLocation(program, 'transform');
    gl.uniformMatrix4fv(transformUniform, false, transform);

    const distortUniform = gl.getUniformLocation(program, 'distortAmount');
    gl.uniform1f(distortUniform, distort);

    // Update corner pin uniforms if needed
    if (selectedMarker) {
        const rect = rectangles.find(r => r.id === parseInt(selectedMarker.dataset.id));
        if (rect && rect.hasCornerPin) {
            const cornerPinUniform = gl.getUniformLocation(program, 'cornerPin');
            const cornerPin2Uniform = gl.getUniformLocation(program, 'cornerPin2');
            
            gl.uniform4f(cornerPinUniform,
                rect.cornerPin.topLeft.x, rect.cornerPin.topLeft.y,
                rect.cornerPin.topRight.x, rect.cornerPin.topRight.y
            );
            
            gl.uniform4f(cornerPin2Uniform,
                rect.cornerPin.bottomLeft.x, rect.cornerPin.bottomLeft.y,
                rect.cornerPin.bottomRight.x, rect.cornerPin.bottomRight.y
            );
        }
    }
}

// Update render frame function
function renderFrame() {
    if (!gl || !videoPreview || !videoTexture) {
        console.warn('Missing required resources:', { 
            gl: !!gl, 
            videoPreview: !!videoPreview, 
            videoTexture: !!videoTexture 
        });
        return;
    }

    if (!videoPreview.videoWidth || !videoPreview.videoHeight) {
        console.warn('Video dimensions not ready');
        return;
    }
    
    try {
        // Clear canvas with transparent background
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Set up WebGL state for alpha blending
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
            gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,  // RGB channels
            gl.ONE, gl.ONE_MINUS_SRC_ALPHA         // Alpha channel
        );

        // Get the currently selected rectangle
        const selectedRect = selectedMarker ? 
            rectangles.find(r => r.id === parseInt(selectedMarker.dataset.id)) : 
            null;
            
        console.debug('Render state:', {
            selectedMarkerId: selectedMarker?.dataset.id,
            selectedRect: selectedRect ? {
                id: selectedRect.id,
                isMainTrack: selectedRect.isMainTrack,
                hasVideo: selectedRect.isMainTrack ? !!videoPreview : !!selectedRect.videoElement,
                hasLumaMatte: !!selectedRect.lumaMatte,
                lumaMatteReady: selectedRect.lumaMatte?.video?.readyState > 0
            } : null
        });

        // Reset texture units
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // Update video texture (unit 0)
        gl.activeTexture(gl.TEXTURE0);
        let currentVideo = null;
        
        if (selectedRect) {
            if (selectedRect.isMainTrack) {
                currentVideo = videoPreview;
                gl.bindTexture(gl.TEXTURE_2D, videoTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoPreview);
            } else if (selectedRect.videoElement) {
                currentVideo = selectedRect.videoElement;
                const compositeTexture = compositeTextures.get(selectedRect.id);
                if (compositeTexture) {
                    gl.bindTexture(gl.TEXTURE_2D, compositeTexture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, selectedRect.videoElement);
                }
            }
        } else {
            currentVideo = videoPreview;
            gl.bindTexture(gl.TEXTURE_2D, videoTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoPreview);
        }
        gl.uniform1i(videoTextureUniform, 0);

        // Handle luma matte
        let hasLumaMatte = false;
        if (selectedRect && selectedRect.lumaMatte && selectedRect.lumaMatte.video) {
            const lumaVideo = selectedRect.lumaMatte.video;
            
            // Only use luma matte if it's ready
            if (lumaVideo.readyState > 0) {
                console.debug('Applying luma matte:', {
                    rectId: selectedRect.id,
                    lumaVideoState: {
                        readyState: lumaVideo.readyState,
                        currentTime: lumaVideo.currentTime,
                        paused: lumaVideo.paused,
                        size: `${lumaVideo.videoWidth}x${lumaVideo.videoHeight}`
                    },
                    mainVideoState: {
                        paused: currentVideo.paused,
                        currentTime: currentVideo.currentTime
                    }
                });
                
                // Ensure luma video is playing and synced
                if (!currentVideo.paused && lumaVideo.paused) {
                    lumaVideo.currentTime = currentVideo.currentTime;
                    lumaVideo.play().catch(error => {
                        console.error('Failed to play luma video:', error);
                    });
                }

                // Bind and update luma texture
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, selectedRect.lumaMatteTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lumaVideo);
                gl.uniform1i(lumaTextureUniform, 1);
                hasLumaMatte = true;
            }
        }

        // Update luma matte uniform
        gl.uniform1f(useLumaMatteUniform, hasLumaMatte ? 1.0 : 0.0);
        console.debug('Luma matte state:', { hasLumaMatte, useLumaMatteValue: hasLumaMatte ? 1.0 : 0.0 });

        // Update transform uniforms
        updateTransform();

        // Draw the video frame
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Check for WebGL errors
        const glError = gl.getError();
        if (glError !== gl.NO_ERROR) {
            console.error('WebGL error:', glError);
        }

        // Request next frame if video is playing
        if (!videoPreview.paused) {
            requestAnimationFrame(renderFrame);
        }
    } catch (error) {
        console.error('Error in renderFrame:', error);
    }
}

// Update the worker message handler
videoWorker.onmessage = function(e) {
    const { type, data } = e.data;

    switch (type) {
        case 'frameProcessed':
            if (data.shouldRestart) {
                console.log('Near end, preparing to loop...');
                videoPreview.currentTime = 0;
            }

            if (data.bufferInfo) {
                console.log(`
                    Buffer State:
                    - Current Time: ${data.bufferInfo.currentTime}s
                    - Buffered End: ${data.bufferInfo.bufferedEnd}s
                    - Duration: ${data.bufferInfo.duration}s
                    - Buffer %: ${data.bufferInfo.bufferPercentage}%
                    - Ready State: ${data.bufferInfo.readyState}
                    - Frame Time: ${data.bufferInfo.frameTime}ms
                    - Time Diff: ${data.bufferInfo.timeDiff}ms
                `);
            }

            // Update UI with proper type conversion
            if (typeof data.currentTime === 'number') {
                currentTimeSpan.textContent = formatTime(data.currentTime);
            }
            updatePlayhead();
            break;

        case 'initialized':
            console.log('Video worker initialized');
            // Ensure initial time display is valid
            currentTimeSpan.textContent = formatTime(0);
            break;

        case 'reset':
            console.log('Video worker reset');
            // Reset time display
            currentTimeSpan.textContent = formatTime(0);
            break;
    }
};

// Update video metadata loaded handler
videoPreview.addEventListener('loadedmetadata', () => {
    resizeCanvasToFitVideo();
    // Update duration display with proper type checking
    const duration = videoPreview.duration;
    durationSpan.textContent = formatTime(duration);
    createTimelineGrid();

    // Initialize worker with video metadata
    videoWorker.postMessage({
        type: 'init',
        data: {
            duration: duration,
            format: videoMetadata.format,
            shouldLoop: true
        }
    });
});

// Update the onTimeUpdate function
const onTimeUpdate = () => {
    if (!videoPreview.paused) {
        // Send frame data to worker for processing
        const bufferedRanges = [];
        for (let i = 0; i < videoPreview.buffered.length; i++) {
            bufferedRanges.push({
                start: videoPreview.buffered.start(i),
                end: videoPreview.buffered.end(i)
            });
        }

        videoWorker.postMessage({
            type: 'processFrame',
            data: {
                currentTime: videoPreview.currentTime,
                timestamp: Date.now(),
                readyState: videoPreview.readyState,
                buffered: bufferedRanges,
                duration: videoPreview.duration,
                paused: videoPreview.paused
            }
        });
    }
};

// Add the onEnded handler
const onEnded = async () => {
    console.log('Video ended at:', videoPreview.currentTime);
    
    if (videoMetadata.format === 'webm' && videoMetadata.shouldLoop) {
        console.log('Restarting WebM playback from beginning');
        try {
            // Pause first to ensure clean state
            videoPreview.pause();
            
            // Reset to beginning
            videoPreview.currentTime = 0;
            
            // Wait a frame to ensure the time update has been processed
            await new Promise(resolve => requestAnimationFrame(resolve));
            
            // Check if we have enough buffer to start playing
            if (videoPreview.buffered.length > 0 && videoPreview.buffered.end(0) > 1) {
                    await videoPreview.play();
                videoMetadata.isPlaying = true;
                playPauseBtn.textContent = '⏸';
            } else {
                // Wait for buffer before playing
                await new Promise(resolve => {
                    const checkBuffer = () => {
                        if (videoPreview.buffered.length > 0 && videoPreview.buffered.end(0) > 1) {
                            videoPreview.play()
                                .then(() => {
                                    videoMetadata.isPlaying = true;
                                    playPauseBtn.textContent = '⏸';
                                    resolve();
                                })
                                .catch(error => {
                                    console.error('Failed to restart after buffering:', error);
                                    videoMetadata.isPlaying = false;
                                    playPauseBtn.textContent = '▶';
                                    resolve();
                                });
                        } else {
                            setTimeout(checkBuffer, 100);
                        }
                    };
                    checkBuffer();
                });
            }
                            } catch (error) {
            console.error('Failed to restart WebM playback:', error);
            videoMetadata.isPlaying = false;
            playPauseBtn.textContent = '▶';
        }
    } else {
        videoMetadata.isPlaying = false;
        playPauseBtn.textContent = '▶';
    }
};

// Update video input handler
videoInput.addEventListener('change', async (event) => {
    try {
        const file = event.target.files[0];
        if (!file) return;

        console.log('Loading video file:', {
            name: file.name,
            type: file.type,
            size: file.size
        });

        // Reset video state
        videoPreview.pause();
        videoPreview.currentTime = 0;
        
        // Set up video element properties
        videoPreview.muted = true;
        videoPreview.playsInline = true;
        videoPreview.loop = true;
        videoPreview.crossOrigin = 'anonymous';
        videoPreview.style.display = 'none'; // Hide video element
        canvas.style.display = 'block'; // Show canvas

        // Create object URL for video
        const videoURL = URL.createObjectURL(file);
        videoPreview.src = videoURL;

        console.log('Waiting for video metadata...');
        // Wait for metadata to load
        await new Promise((resolve, reject) => {
            videoPreview.addEventListener('loadedmetadata', resolve, { once: true });
            videoPreview.addEventListener('error', reject, { once: true });
        });
        console.log('Video metadata loaded');

        // Initialize WebGL if not already initialized
        if (!gl) {
            console.log('Initializing WebGL...');
            initWebGL();
        }

        // Create video texture if needed
        if (!videoTexture) {
            console.log('Creating video texture...');
            videoTexture = createVideoTexture();
        }

        // Resize canvas to fit video
        console.log('Resizing canvas...');
        resizeCanvasToFitVideo();

        console.log('Waiting for video to be ready...');
        // Wait for video to be ready to play
        await new Promise((resolve, reject) => {
            videoPreview.addEventListener('canplay', resolve, { once: true });
            videoPreview.addEventListener('error', reject, { once: true });
        });
        console.log('Video ready to play');

        // Update UI
        dropZone.style.display = 'none';
        playPauseBtn.disabled = false;
        durationSpan.textContent = formatTime(videoPreview.duration);

        // Start playback and rendering
        try {
            console.log('Starting video playback...');
            await videoPreview.play();
            playPauseBtn.textContent = '⏸';
            console.log('Starting render loop...');
            
            // Start the render loop with continuous updates
            let animationFrameId;
            
            function animate() {
                // Update texture and render frame
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, videoTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoPreview);
                
                // Clear and render
                gl.clearColor(0.0, 0.0, 0.0, 1.0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                
                // Continue animation if video is playing
                if (!videoPreview.paused) {
                    animationFrameId = requestAnimationFrame(animate);
                }
            }
            
            // Start animation loop
            animationFrameId = requestAnimationFrame(animate);
            
            console.log('Playback started successfully');
        } catch (playError) {
            console.error('Error starting playback:', playError);
            playPauseBtn.textContent = '▶';
        }

        console.log('Video setup complete:', {
            duration: videoPreview.duration,
            size: `${videoPreview.videoWidth}x${videoPreview.videoHeight}`,
            type: file.type,
            readyState: videoPreview.readyState,
            paused: videoPreview.paused,
            webglContext: gl ? 'initialized' : 'missing',
            videoTexture: videoTexture ? 'created' : 'missing'
        });
    } catch (error) {
        console.error('Error setting up video:', error);
        alert('Error loading video: ' + error.message);
    }
});

// Update video event listeners
videoPreview.addEventListener('waiting', () => {
    console.log('Video waiting for data...');
});

videoPreview.addEventListener('canplay', () => {
    console.log('Video can play');
    if (videoMetadata.wasPlaying) {
        videoPreview.play().catch(console.error);
    }
});

videoPreview.addEventListener('play', () => {
    console.log('Video started playing');
    videoMetadata.isPlaying = true;
    
    // Start render loop
    function animate() {
        renderFrame();
        if (!videoPreview.paused) {
            requestAnimationFrame(animate);
        }
    }
    requestAnimationFrame(animate);
});

videoPreview.addEventListener('pause', () => {
    console.log('Video paused');
    videoMetadata.isPlaying = false;
    // Render one last frame to ensure display is updated
    renderFrame();
});

videoPreview.addEventListener('seeking', () => {
    // Render current frame while seeking
    renderFrame();
});

videoPreview.addEventListener('seeked', () => {
    // Update display after seeking completes
    renderFrame();
});

// Drag and drop handling
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) {
        videoInput.files = e.dataTransfer.files;
        videoInput.dispatchEvent(new Event('change'));
    }
});

// Transform control listeners
[scaleRange, rotateRange, distortRange].forEach(control => {
    control.addEventListener('input', updateTransform);
});

// Add new control listeners
[skewXInput, skewYInput, posXInput, posYInput].forEach(control => {
    control.addEventListener('input', updateTransform);
});

applyTransformBtn.addEventListener('click', () => {
    updateTransform();
    if (videoPreview.readyState >= 2) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
});

exportVideoBtn.addEventListener('click', exportTransformedVideo);

// Play/Pause functionality
playPauseBtn.addEventListener('click', async () => {
    try {
        if (videoPreview.paused) {
            videoMetadata.wasPlaying = true;
            await videoPreview.play();
            playPauseBtn.textContent = '⏸';
            requestAnimationFrame(renderFrame);
        } else {
            videoMetadata.wasPlaying = false;
            videoPreview.pause();
            playPauseBtn.textContent = '▶';
        }
    } catch (error) {
        console.error('Play/Pause error:', error);
    }
});

// Update TimelineRectangle class
class TimelineRectangle {
    constructor(id, hasCornerPin = true) {
        this.id = id;
        this.zIndex = 1;
        this.startFrame = 0;
        this.endFrame = 0;
        this.videoSource = null;
        this.videoElement = null;
        this.isMainTrack = false;
        this.lumaMatte = null; // Will store { video, source, texture }
        this.lumaMatteTexture = null;
        this.hasCornerPin = hasCornerPin;
        this.cornerPin = hasCornerPin ? {
            topLeft: { x: 0, y: 0 },
            topRight: { x: 1, y: 0 },
            bottomLeft: { x: 0, y: 1 },
            bottomRight: { x: 1, y: 1 }
        } : null;
        this.transform = {
            scale: 1,
            rotate: 0,
            distort: 0,
            skewX: 0,
            skewY: 0,
            posX: 0,
            posY: 0
        };
    }
}

// Timeline state - create main track first
const rectangles = [
    new TimelineRectangle(1, false), // Main track - no corner pin
    new TimelineRectangle(2),
    new TimelineRectangle(3),
    new TimelineRectangle(4),
    new TimelineRectangle(5)
];

// Set main track properties
rectangles[0].isMainTrack = true;
rectangles[0].zIndex = 0; // Keep main track at bottom

// Initialize rectangles with z-indices and positions
rectangles[1].zIndex = 1;
rectangles[2].zIndex = 1;
rectangles[3].zIndex = 1;
rectangles[4].zIndex = 1;

// Set corner pin coordinates for each rectangle (skip main track)
// Rectangle 2
rectangles[1].cornerPin = {
    topLeft: { x: -72, y: 1164 },
    topRight: { x: 1920, y: -188 },
    bottomLeft: { x: -336, y: 2560 },
    bottomRight: { x: 1916, y: 1956 }
};

// Rectangle 3
rectangles[2].cornerPin = {
    topLeft: { x: 96, y: 0 },
    topRight: { x: 3720, y: 8 },
    bottomLeft: { x: 288, y: 2088 },
    bottomRight: { x: 3704, y: 1976 }
};

// Rectangle 4
rectangles[3].cornerPin = {
    topLeft: { x: 544, y: 64 },
    topRight: { x: 3824, y: 64 },
    bottomLeft: { x: 544, y: 2216 },
    bottomRight: { x: 3824, y: 2192 }
};

// Rectangle 5
rectangles[4].cornerPin = {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 3840, y: 0 },
    bottomLeft: { x: 0, y: 2160 },
    bottomRight: { x: 3840, y: 2160 }
};

// Set exact frame ranges for each rectangle
rectangles[0].startFrame = 0;
rectangles[0].endFrame = 55;

rectangles[1].startFrame = 0;  // Duplicate of first marker's position
rectangles[1].endFrame = 55;   // Duplicate of first marker's position

rectangles[2].startFrame = 56;
rectangles[2].endFrame = 126;

rectangles[3].startFrame = 127;
rectangles[3].endFrame = 173;

rectangles[4].startFrame = 174;
rectangles[4].endFrame = 216;

// Timeline grid and marker handling
const timelineGrid = document.querySelector('.timeline-grid');
const thumbnailMarkers = document.querySelector('.thumbnail-markers');
let isDragging = false;
let currentMarker = null;
let startX = 0;
let markerStartLeft = 0;
let isResizing = false;
let resizeEdge = null;

// Add selection tracking
let selectedMarker = null;

function createTimelineGrid() {
    const fps = 30; // Frames per second
    const duration = videoPreview.duration || 0;
    const totalFrames = Math.floor(duration * fps);
    const timelineWidth = 742.74; // Match the timeline-line width
    const frameWidth = timelineWidth / totalFrames;

    // Clear existing grid
    timelineGrid.innerHTML = '';
    thumbnailMarkers.innerHTML = '';

    // Create grid lines and labels for each second
    for (let i = 0; i <= duration; i++) {
        const gridLine = document.createElement('div');
        gridLine.className = 'grid-line';
        gridLine.style.left = `${(i * fps * frameWidth)}px`;
        
        const label = document.createElement('div');
        label.className = 'grid-label';
        label.textContent = `${i}s`;
        label.style.left = `${(i * fps * frameWidth)}px`;
        
        timelineGrid.appendChild(gridLine);
        timelineGrid.appendChild(label);

        // Add minor grid lines for frames
        if (i < duration) {
            for (let f = 1; f < fps; f++) {
                const minorLine = document.createElement('div');
                minorLine.className = 'grid-line';
                minorLine.style.left = `${(i * fps + f) * frameWidth}px`;
                minorLine.style.height = '10px';
                minorLine.style.opacity = '0.05';
                timelineGrid.appendChild(minorLine);
            }
        }
    }

    // Create rectangles
    rectangles.forEach(rect => createMarker(rect));
}

function createMarker(rectangle) {
    const marker = document.createElement('div');
    marker.className = 'thumbnail-marker';
    if (rectangle.isMainTrack) {
        marker.classList.add('main-track');
    }
    marker.dataset.id = rectangle.id;
    
    const timelineWidth = 742.74;
    const totalFrames = Math.floor(videoPreview.duration * 30);
    const frameWidth = timelineWidth / totalFrames;
    
    if (rectangle.isMainTrack) {
        marker.style.left = '0';
        marker.style.width = '100%';
        marker.style.backgroundColor = 'rgba(40, 40, 40, 0.8)';
        rectangle.endFrame = totalFrames;
    } else {
        marker.style.left = `${rectangle.startFrame * frameWidth}px`;
        marker.style.width = `${(rectangle.endFrame - rectangle.startFrame) * frameWidth}px`;
    }
    
    marker.style.zIndex = rectangle.zIndex;
    const baseOffset = 0;
    const verticalSpacing = 70;
    marker.style.top = `${baseOffset - (rectangle.zIndex - 1) * verticalSpacing}px`;
    
    // Add video selection button for non-main tracks
    if (!rectangle.isMainTrack) {
        const selectButton = document.createElement('button');
        selectButton.className = 'select-video-btn';
        selectButton.textContent = rectangle.videoSource ? '🎥' : '➕';
        selectButton.title = rectangle.videoSource ? 'Change Video' : 'Add Video';
        
        const compositeVideoInput = document.createElement('input');
        compositeVideoInput.type = 'file';
        compositeVideoInput.accept = 'video/*';
        compositeVideoInput.style.display = 'none';
        
        compositeVideoInput.addEventListener('change', (event) => {
            handleCompositeVideoInput(event.target, rectangle);
        });
        
        selectButton.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent marker selection when clicking button
            compositeVideoInput.click();
        });
        
        marker.appendChild(selectButton);
        marker.appendChild(compositeVideoInput);
    }

    // Add selection handling for all markers
    marker.addEventListener('click', function(e) {
        // Don't trigger selection when clicking buttons or handles
        if (e.target !== marker) {
            e.stopPropagation();
            return;
        }

        // Deselect previous marker if any
        if (selectedMarker && selectedMarker !== marker) {
            selectedMarker.classList.remove('selected');
        }

        // Toggle selection
        if (selectedMarker === marker) {
            marker.classList.remove('selected');
            selectedMarker = null;
            // Force render update with no selection
            console.debug('Marker deselected');
            renderFrame();
        } else {
            selectedMarker = marker;
            marker.classList.add('selected');
            // Force render update with new selection
            const rect = rectangles.find(r => r.id === parseInt(marker.dataset.id));
            console.debug('Marker selected:', {
                id: marker.dataset.id,
                rectangle: rect ? {
                    isMainTrack: rect.isMainTrack,
                    hasVideo: rect.isMainTrack ? !!videoPreview : !!rect.videoElement,
                    hasLumaMatte: !!rect.lumaMatte,
                    lumaMatteReady: rect.lumaMatte?.video?.readyState > 0
                } : null
            });
            updatePropertiesPanel(rect);
            renderFrame();
        }
        
        // Stop event from bubbling to prevent deselection
        e.stopPropagation();
    });

    // Mouse down handler for dragging (non-main tracks only)
    if (!rectangle.isMainTrack) {
        marker.addEventListener('mousedown', (e) => {
            if (e.target === marker) {
                isDragging = true;
                currentMarker = marker;
                startX = e.clientX;
                markerStartLeft = parseFloat(marker.style.left);
                marker.classList.add('dragging');
            } else if (e.target.classList.contains('resize-handle')) {
                isResizing = true;
                resizeEdge = e.target.classList.contains('left') ? 'left' : 'right';
                currentMarker = marker;
                startX = e.clientX;
                e.stopPropagation();
            }
        });
    }

    // Add marker to timeline
    thumbnailMarkers.appendChild(marker);
    return marker;
}

// Update mouse event listeners for dragging and resizing
document.addEventListener('mousemove', (e) => {
    if (!isDragging && !isResizing || !currentMarker) return;

    const timelineWidth = 742.74; // Match the timeline-line width
    const totalFrames = Math.floor(videoPreview.duration * 30);
    const frameWidth = timelineWidth / totalFrames;
    const rect = rectangles.find(r => r.id === parseInt(currentMarker.dataset.id));
    
    if (isResizing) {
        const deltaX = e.clientX - startX;
        if (resizeEdge === 'left') {
            let newStartFrame = Math.round((parseFloat(currentMarker.style.left) + deltaX) / frameWidth);
            newStartFrame = Math.max(0, Math.min(newStartFrame, rect.endFrame - 1));
            rect.startFrame = newStartFrame;
            currentMarker.style.left = `${newStartFrame * frameWidth}px`;
            currentMarker.style.width = `${(rect.endFrame - newStartFrame) * frameWidth}px`;
        } else {
            let newEndFrame = Math.round((parseFloat(currentMarker.style.left) + currentMarker.offsetWidth + deltaX) / frameWidth);
            newEndFrame = Math.max(rect.startFrame + 1, Math.min(newEndFrame, totalFrames));
            rect.endFrame = newEndFrame;
            currentMarker.style.width = `${(newEndFrame - rect.startFrame) * frameWidth}px`;
        }
    } else {
        const deltaX = e.clientX - startX;
        let newLeft = markerStartLeft + deltaX;
        
        // Snap to frame grid
        const framePosition = Math.round(newLeft / frameWidth);
        newLeft = framePosition * frameWidth;
        
        // Constrain to timeline bounds
        const maxLeft = timelineWidth - currentMarker.offsetWidth;
        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        
        // Update rectangle data
        rect.startFrame = Math.round(newLeft / frameWidth);
        rect.endFrame = rect.startFrame + Math.round(currentMarker.offsetWidth / frameWidth);
        
        currentMarker.style.left = `${newLeft}px`;
    }
});

document.addEventListener('mouseup', () => {
    if (currentMarker) {
        currentMarker.classList.remove('dragging');
    }
    isDragging = false;
    isResizing = false;
    currentMarker = null;
    resizeEdge = null;
});

// Update video preview z-index
videoPreview.style.zIndex = '2';

// Initialize
initWebGL();
initCornerPin();
loadFFmpeg();
updateTransform();

// Add these event listeners
videoPreview.addEventListener('waiting', () => {
    console.log('Video waiting for data...');
});

videoPreview.addEventListener('stalled', () => {
    console.log('Video playback stalled');
});

videoPreview.addEventListener('suspend', () => {
    console.log('Video download suspended');
});

// Add WebM optimization utilities after FFmpeg initialization
const CHUNK_DURATION = 3; // Duration of each chunk in seconds
const BUFFER_AHEAD = 2; // Number of chunks to buffer ahead

class WebMHandler {
    constructor() {
        this.chunks = new Map();
        this.activeChunks = new Set();
        this.isLoading = false;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.pendingOperations = [];
        this.isSourceOpen = false;
        this.bufferQueue = [];
        this.currentUrl = null;
        this.aborted = false;
        this.initializationPromise = null;
        this.usingDirectPlayback = false;
    }

    async cleanup() {
        this.aborted = true;
        
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

        if (this.currentUrl) {
            try {
                URL.revokeObjectURL(this.currentUrl);
            } catch (e) {
                console.warn('Error revoking URL:', e);
            }
            this.currentUrl = null;
        }

        this.mediaSource = null;
        this.isSourceOpen = false;
        this.pendingOperations = [];
        this.bufferQueue = [];
        this.isLoading = false;
    }
}

// Initialize WebMHandler
let currentWebMHandler = new WebMHandler();

// Load FFmpeg
async function loadFFmpeg() {
    try {
        await ffmpeg.load();
        isFFmpegLoaded = true;
        console.log('FFmpeg loaded');
    } catch (error) {
        console.error('Error loading FFmpeg:', error);
    }
}

// Separate export state tracking
let isExporting = false;

// Export function
async function exportTransformedVideo() {
    if (isExporting) {
        console.log('Export already in progress');
        return;
    }
    
    if (!isFFmpegLoaded) {
        alert('Please wait for FFmpeg to load');
        return;
    }
    
    if (!videoPreview.src) {
        alert('Please upload a video first');
        return;
    }
    
    isExporting = true;
    
    // Store original playback state
    const wasPlaying = !videoPreview.paused;
    const originalTime = videoPreview.currentTime;
    const originalLoop = videoPreview.loop;
    
    try {
        // Ensure video is ready
        if (videoPreview.readyState < 2) {
            await new Promise((resolve) => {
                videoPreview.addEventListener('loadeddata', resolve, { once: true });
            });
        }

        // Setup for frame capture
        const frameRate = 30;
        const duration = videoPreview.duration;
        const totalFrames = Math.floor(duration * frameRate);
        const frames = [];
        
        // Reset video position to start
        await new Promise(resolve => {
            const onSeeked = () => {
                videoPreview.removeEventListener('seeked', onSeeked);
                resolve();
            };
            videoPreview.addEventListener('seeked', onSeeked);
            videoPreview.currentTime = 0;
        });

        console.log('Starting frame capture...');
        
        // Capture each frame with improved seeking and state handling
        for (let i = 0; i < totalFrames; i++) {
            try {
                await new Promise((resolve, reject) => {
                    const targetTime = i / frameRate;
                    const onSeeked = () => {
                        try {
                            if (Math.abs(videoPreview.currentTime - targetTime) > 0.01) {
                                videoPreview.currentTime = targetTime;
                                return; // wait for correct frame
                            }
                            
                            videoPreview.removeEventListener('seeked', onSeeked);
                            requestAnimationFrame(() => {
                                updateTransform();
                                gl.viewport(0, 0, canvas.width, canvas.height);
                                gl.bindTexture(gl.TEXTURE_2D, videoTexture);
                                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoPreview);
                                gl.clear(gl.COLOR_BUFFER_BIT);
                                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

                                canvas.toBlob((blob) => {
                                    if (blob) {
                                        frames.push(blob);
                                        progressBarFill.style.width = `${(i / totalFrames) * 50}%`;
                                        resolve();
                                    } else {
                                        reject(new Error('Failed to capture frame'));
                                    }
                                }, 'image/png', 1.0);
                            });
                        } catch (error) {
                            reject(error);
                        }
                    };

                    videoPreview.addEventListener('seeked', onSeeked);
                    videoPreview.currentTime = targetTime;
                });
            } catch (error) {
                console.error(`Error capturing frame ${i}:`, error);
                throw error;
            }
        }

        console.log('Frame capture complete. Processing with FFmpeg...');

        // Remove any existing files from FFmpeg's virtual FS
        const files = await ffmpeg.listFiles('/');
        for (const file of files) {
            await ffmpeg.deleteFile(file.name);
        }

        console.log('Writing frames to FFmpeg...');
        for (let i = 0; i < frames.length; i++) {
            const frameData = await frames[i].arrayBuffer();
            const frameName = `frame${i.toString().padStart(6, '0')}.png`;
            await ffmpeg.writeFile(frameName, new Uint8Array(frameData));
            progressBarFill.style.width = `${50 + (i / frames.length) * 25}%`;
        }

        console.log('Combining frames into video...');
        await ffmpeg.exec([
            '-framerate', frameRate.toString(),
            '-i', 'frame%06d.png',
            '-c:v', 'vp9',
            '-pix_fmt', 'yuva420p',
            '-auto-alt-ref', '0',
            '-b:v', '2M',
            '-crf', '30',
            'output.webm'
        ]);

        progressBarFill.style.width = '100%';

        console.log('Preparing download...');
        const data = await ffmpeg.readFile('output.webm');
        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/webm' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'transformed_video.webm';
        a.click();

        console.log('Cleaning up...');
        progressBar.style.display = 'none';
        const finalFiles = await ffmpeg.listFiles('/');
        for (const file of finalFiles) {
            await ffmpeg.deleteFile(file.name);
        }
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Error exporting video:', error);
        alert('Error exporting video: ' + error.message);
    } finally {
        isExporting = false;
        // Restore the original playback state
        videoPreview.currentTime = originalTime;
        videoPreview.loop = originalLoop;
        if (wasPlaying && videoMetadata.format === 'webm') {
            const buffered = videoPreview.buffered;
            if (buffered.length > 0 && buffered.end(0) >= originalTime + 1) {
                try {
                    await videoPreview.play();
                } catch (e) {
                    console.error('Failed to restore WebM playback:', e);
                }
            } else {
                console.log('Waiting for buffer before resuming WebM playback...');
                await new Promise(resolve => {
                    const checkBuffer = () => {
                        if (videoPreview.buffered.length > 0 && 
                            videoPreview.buffered.end(0) >= originalTime + 1) {
                            videoPreview.play().then(resolve).catch(console.error);
                        } else {
                            setTimeout(checkBuffer, 100);
                        }
                    };
                    checkBuffer();
                });
            }
        } else if (wasPlaying) {
            try {
                await videoPreview.play();
            } catch (e) {
                console.error('Failed to restore playback:', e);
            }
        }
        progressBar.style.display = 'none';
    }
}

// Call loadFFmpeg on startup
loadFFmpeg();

// Add function to update properties panel
function updatePropertiesPanel(rectangle) {
    if (!rectangle) return;

    scaleRange.value = rectangle.transform.scale;
    rotateRange.value = rectangle.transform.rotate;
    distortRange.value = rectangle.transform.distort;
    skewXInput.value = rectangle.transform.skewX;
    skewYInput.value = rectangle.transform.skewY;
    posXInput.value = rectangle.transform.posX;
    posYInput.value = rectangle.transform.posY;

    // Only update corner pin if the rectangle has it enabled
    if (rectangle.hasCornerPin && cornerPinCanvas) {
        cornerPoints = [
            rectangle.cornerPin.topLeft,
            rectangle.cornerPin.topRight,
            rectangle.cornerPin.bottomLeft,
            rectangle.cornerPin.bottomRight
        ];
        drawCornerPinCanvas();
    }

    // Update transform display
    updateTransform();

    // Update luma matte button state
    if (toggleLumaMatteBtn) {
        toggleLumaMatteBtn.classList.toggle('active', rectangle.lumaMatte !== null);
        toggleLumaMatteBtn.textContent = rectangle.lumaMatte ? 'Change Luma Matte' : 'Set Luma Matte';
    }
}

// Add function to draw corner pin canvas
function drawCornerPinCanvas() {
    const ctx = cornerPinCanvas.getContext('2d');
    const width = cornerPinCanvas.width;
    const height = cornerPinCanvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    
    // Draw corner points and lines
    ctx.beginPath();
    ctx.moveTo(cornerPoints[0].x * width, cornerPoints[0].y * height);
    ctx.lineTo(cornerPoints[1].x * width, cornerPoints[1].y * height);
    ctx.lineTo(cornerPoints[3].x * width, cornerPoints[3].y * height);
    ctx.lineTo(cornerPoints[2].x * width, cornerPoints[2].y * height);
    ctx.closePath();
    
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw corner points
    cornerPoints.forEach((point, index) => {
        ctx.beginPath();
        ctx.arc(point.x * width, point.y * height, 5, 0, Math.PI * 2);
        ctx.fillStyle = index === activePoint ? '#FF4444' : '#FFFFFF';
        ctx.fill();
        ctx.stroke();
    });
}

// Update the document click handler
document.addEventListener('click', function(e) {
    // Don't deselect if clicking inside a marker, the luma matte button, or other UI controls
    if (e.target.closest('.thumbnail-marker') || 
        e.target.closest('.action-buttons') || 
        e.target.closest('.properties-panel') ||
        e.target === toggleLumaMatteBtn ||
        e.target === lumaMatteInput) {
        return;
    }
    
    // Deselect if clicking outside
    if (selectedMarker) {
        selectedMarker.classList.remove('selected');
        selectedMarker = null;
        // Force a render to update the display
        console.debug('Marker deselected by document click');
        renderFrame();
    }
});

// Add luma matte toggle handler
toggleLumaMatteBtn.addEventListener('click', (e) => {
    // Prevent event from bubbling up to document
    e.stopPropagation();
    
    if (!selectedMarker) {
        console.warn('No marker selected when clicking luma matte button');
        alert('Please select a layer first');
        return;
    }
    
    const rect = rectangles.find(r => r.id === parseInt(selectedMarker.dataset.id));
    if (!rect) {
        console.error('No rectangle found for selected marker ID:', selectedMarker.dataset.id);
        return;
    }

    // Check for video based on track type
    const hasVideo = rect.isMainTrack ? 
        (videoPreview && videoPreview.readyState > 0) : 
        !!rect.videoElement;

    if (!hasVideo) {
        console.warn('Selected rectangle has no video assigned:', {
            isMainTrack: rect.isMainTrack,
            hasVideoElement: !!rect.videoElement,
            mainVideoState: rect.isMainTrack ? {
                readyState: videoPreview?.readyState,
                src: videoPreview?.src
            } : null
        });
        alert('Please add a video to this layer before setting a luma matte');
        return;
    }
    
    console.debug('Opening luma matte file picker for rectangle:', {
        id: rect.id,
        isMainTrack: rect.isMainTrack,
        hasExistingLumaMatte: !!rect.lumaMatte,
        videoState: rect.isMainTrack ? {
            width: videoPreview.videoWidth,
            height: videoPreview.videoHeight,
            readyState: videoPreview.readyState
        } : {
            width: rect.videoElement.videoWidth,
            height: rect.videoElement.videoHeight,
            readyState: rect.videoElement.readyState
        }
    });
    
    lumaMatteInput.click();
});

// Update luma matte video selection handler
lumaMatteInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file || !selectedMarker) {
        console.warn('No file selected or no marker selected');
        return;
    }

    console.debug('Setting up luma matte:', {
        file: {
            name: file.name,
            type: file.type,
            size: file.size
        },
        selectedMarkerId: selectedMarker.dataset.id
    });

    try {
        const rectId = parseInt(selectedMarker.dataset.id);
        const rect = rectangles.find(r => r.id === rectId);
        if (!rect) {
            console.error('No rectangle found for ID:', rectId);
            return;
        }

        // Clean up existing luma matte if any
        if (rect.lumaMatte) {
            console.debug('Cleaning up existing luma matte');
            rect.lumaMatte.video.pause();
            URL.revokeObjectURL(rect.lumaMatte.source);
            gl.deleteTexture(rect.lumaMatteTexture);
        }

        // Create video element for luma matte
        const lumaVideo = document.createElement('video');
        lumaVideo.muted = true;
        lumaVideo.loop = true;
        lumaVideo.playsInline = true;
        lumaVideo.autoplay = false;
        lumaVideo.crossOrigin = 'anonymous';
        
        // Set up video source
        const url = URL.createObjectURL(file);
        lumaVideo.src = url;

        // Wait for metadata to load
        await new Promise((resolve, reject) => {
            lumaVideo.addEventListener('loadedmetadata', () => {
                console.debug('Luma video metadata loaded:', {
                    size: `${lumaVideo.videoWidth}x${lumaVideo.videoHeight}`,
                    duration: lumaVideo.duration
                });
                resolve();
            }, { once: true });
            lumaVideo.addEventListener('error', (e) => {
                console.error('Luma video load error:', e.target.error);
                reject(e);
            }, { once: true });
        });

        // Create new texture for luma matte
        rect.lumaMatteTexture = createVideoTexture();
        console.debug('Created luma matte texture');

        // Store luma matte info
        rect.lumaMatte = {
            video: lumaVideo,
            source: url,
            texture: rect.lumaMatteTexture
        };

        // Ensure video is ready to play
        await new Promise((resolve, reject) => {
            lumaVideo.addEventListener('canplay', () => {
                console.debug('Luma video can play');
                resolve();
            }, { once: true });
            lumaVideo.addEventListener('error', (e) => {
                console.error('Luma video play error:', e.target.error);
                reject(e);
            }, { once: true });
        });

        // Update UI
        selectedMarker.classList.add('has-luma-matte');
        toggleLumaMatteBtn.textContent = 'Change Luma Matte';
        toggleLumaMatteBtn.classList.add('active');

        // Start playing the luma video if main video is playing
        if (!videoPreview.paused) {
            console.debug('Starting luma video playback');
            lumaVideo.currentTime = videoPreview.currentTime;
            await lumaVideo.play();
        }

        // Update properties panel without affecting corner pin
        updatePropertiesPanel(rect);
        
        // Force a frame render to show changes
        requestAnimationFrame(() => {
            console.debug('Forcing render after luma matte setup:', {
                rectId: rect.id,
                hasLumaMatte: !!rect.lumaMatte,
                lumaMatteReady: rect.lumaMatte?.video?.readyState > 0
            });
            renderFrame();
        });

        console.log('Luma matte setup complete:', {
            videoReady: lumaVideo.readyState,
            duration: lumaVideo.duration,
            size: `${lumaVideo.videoWidth}x${lumaVideo.videoHeight}`,
            currentTime: lumaVideo.currentTime,
            mainVideoTime: videoPreview.currentTime
        });
    } catch (error) {
        console.error('Error setting up luma matte:', error);
        alert('Error setting up luma matte: ' + error.message);
    }
});

// Add this function after initWebGL()
function resizeCanvasToFitVideo() {
    if (!videoPreview || !videoPreview.videoWidth || !videoPreview.videoHeight) {
        console.warn('Video dimensions not available');
        return;
    }
    
    // Get container dimensions
    const container = canvas.parentElement;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    console.log('Resizing canvas:', {
        containerWidth,
        containerHeight,
        videoWidth: videoPreview.videoWidth,
        videoHeight: videoPreview.videoHeight
    });
    
    // Set canvas dimensions to match container
    canvas.width = containerWidth;
    canvas.height = containerHeight;
    
    // Update WebGL viewport to match canvas size
    if (gl) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        
        // Clear the canvas
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        // Force a frame render to show the changes
        renderFrame();
    }
}

// Add window resize handler
window.addEventListener('resize', () => {
    resizeCanvasToFitVideo();
});

// Add video error handler
videoPreview.addEventListener('error', (e) => {
    console.error('Video error:', e.target.error);
});

// Update WebGL viewport when canvas is resized
function updateViewport() {
    if (gl) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        renderFrame();
    }
}

// Add resize observer for the canvas
const resizeObserver = new ResizeObserver(() => {
    updateViewport();
});
resizeObserver.observe(canvas);

// Add composite video input handler
function handleCompositeVideoInput(input, rectangle) {
    const file = input.files[0];
    if (!file) return;

    // Clean up existing video if any
    if (rectangle.videoElement) {
        rectangle.videoElement.pause();
        URL.revokeObjectURL(rectangle.videoSource);
    }

    // Create new video element
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    // Set up video source
    const videoURL = URL.createObjectURL(file);
    video.src = videoURL;

    // Store video info in rectangle
    rectangle.videoElement = video;
    rectangle.videoSource = videoURL;

    // Create texture if needed
    if (!compositeTextures.has(rectangle.id)) {
        compositeTextures.set(rectangle.id, createVideoTexture());
    }

    // Update UI
    const marker = document.querySelector(`.thumbnail-marker[data-id="${rectangle.id}"]`);
    if (marker) {
        const selectButton = marker.querySelector('.select-video-btn');
        if (selectButton) {
            selectButton.textContent = '🎥';
            selectButton.title = 'Change Video';
        }
    }

    // Start playing if main video is playing
    if (!videoPreview.paused) {
        video.play().catch(console.error);
    }
}