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
    varying vec2 vTextureCoord;
    uniform mat4 transform;
    uniform vec4 cornerPin;
    uniform vec4 cornerPin2;
    uniform float useCornerPin;
    
    void main() {
        // Convert position from clip space (-1 to 1) to canvas space (0 to 1)
        vec2 canvasPos = vec2(position.x * 0.5 + 0.5, -position.y * 0.5 + 0.5);
        
        // Base texture coordinates (for sampling the video)
        vec2 texCoord = canvasPos;
        
        if (useCornerPin > 0.5) {
            // Get corner pin points in canvas space (already in pixels)
            vec2 topLeft = vec2(cornerPin.x, cornerPin.y);
            vec2 topRight = vec2(cornerPin.z, cornerPin.w);
            vec2 bottomLeft = vec2(cornerPin2.x, cornerPin2.y);
            vec2 bottomRight = vec2(cornerPin2.z, cornerPin2.w);
            
            // Flip vertically by swapping top and bottom points
            vec2 temp = topLeft;
            topLeft = bottomLeft;
            bottomLeft = temp;
            
            temp = topRight;
            topRight = bottomRight;
            bottomRight = temp;
            
            // Convert canvas position to corner pin space using bilinear interpolation
            vec2 top = mix(topLeft, topRight, canvasPos.x);
            vec2 bottom = mix(bottomLeft, bottomRight, canvasPos.x);
            vec2 finalPos = mix(top, bottom, canvasPos.y);
            
            // Convert back to clip space (-1 to 1)
            gl_Position = vec4(
                (finalPos.x / 3840.0) * 2.0 - 1.0,
                (finalPos.y / 2160.0) * 2.0 - 1.0,
                0.0,
                1.0
            );
        } else {
            gl_Position = vec4(position, 0.0, 1.0);
        }
        
        vTextureCoord = texCoord;
    }
`;

const fragmentShaderSource = `
    precision mediump float;
    
    uniform sampler2D videoTexture;
    uniform sampler2D lumaTexture;
    uniform float useLumaMatte;
    uniform float useCornerPin;
    
    varying vec2 vTextureCoord;
    
    float getLuminance(vec3 color) {
        return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }
    
    void main() {
        vec4 videoColor = texture2D(videoTexture, vTextureCoord);
        
        if (useLumaMatte > 0.5) {
            vec4 lumaColor = texture2D(lumaTexture, vTextureCoord);
            float luminance = getLuminance(lumaColor.rgb);
            
            // Apply gamma correction to luminance
            float gamma = 2.2;
            luminance = pow(luminance, 1.0/gamma);
            
            // Invert luminance for alpha (bright areas become transparent)
            float alpha = 1.0 - luminance;
            
            // Apply alpha to video color
            gl_FragColor = vec4(videoColor.rgb, videoColor.a * alpha);
        } else {
            gl_FragColor = videoColor;
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
    const targetTime = progress * videoPreview.duration;
    const targetFrame = Math.round(targetTime * 30); // Assuming 30fps
    
    seekToFrame(targetFrame);
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
let lumaTexture;
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
        return '0:00.000';
    }
    
    const minutes = Math.floor(Math.max(0, seconds) / 60);
    const remainingSeconds = Math.max(0, seconds % 60);
    const milliseconds = Math.floor((remainingSeconds % 1) * 1000);
    
    return `${minutes}:${Math.floor(remainingSeconds).toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
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

// Add uniform locations as global variables
let videoTextureUniform;
let lumaTextureUniform;
let useLumaMatteUniform;
let useCornerPinUniform;

// Constants
const BASE_WIDTH = 3840;
const BASE_HEIGHT = 2160;
const TIMELINE_WIDTH = 742.74;
const DEFAULT_FPS = 30;
const FRAME_DURATION = 1000 / DEFAULT_FPS;
const HIT_RADIUS_MULTIPLIER = 0.02; // 2% of base size for corner pin hit radius
const LUMA_SYNC_THRESHOLD = 0.033; // 33ms threshold for luma sync (1 frame at 30fps)

// Update initWebGL to store uniform locations and clean up shaders
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

    // Configure alpha blending for pre-multiplied alpha
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
        gl.ONE, gl.ONE_MINUS_SRC_ALPHA,  // RGB channels
        gl.ONE, gl.ONE_MINUS_SRC_ALPHA   // Alpha channel
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // Create and compile vertex shader
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexShaderSource);
    gl.compileShader(vertexShader);

    // Check vertex shader compilation
    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(vertexShader);
        console.error('Vertex shader compile error:', error);
        gl.deleteShader(vertexShader);
        return;
    }
    console.log('Vertex shader compiled successfully');

    // Create and compile fragment shader
    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, fragmentShaderSource);
    gl.compileShader(fragmentShader);

    // Check fragment shader compilation
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(fragmentShader);
        console.error('Fragment shader compile error:', error);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        return;
    }
    console.log('Fragment shader compiled successfully');

    // Create and link program
    program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    // Check program linking
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const error = gl.getProgramInfoLog(program);
        console.error('Program link error:', error);
        gl.deleteProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        return;
    }
    console.log('Program linked successfully');

    // Use the program
    gl.useProgram(program);

    // Create vertex buffer
    const vertices = new Float32Array([
        -1, -1,   // bottom left
        1, -1,    // bottom right
        -1, 1,    // top left
        1, 1      // top right
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
    useCornerPinUniform = gl.getUniformLocation(program, 'useCornerPin');
    
    // Check uniform locations
    if (!videoTextureUniform || !lumaTextureUniform || !useLumaMatteUniform || !useCornerPinUniform) {
        console.error('Failed to get uniform locations:', {
            videoTextureUniform,
            lumaTextureUniform,
            useLumaMatteUniform,
            useCornerPinUniform
        });
        return;
    }
    
    // Set initial uniform values
    gl.uniform1i(videoTextureUniform, 0);  // Use texture unit 0
    gl.uniform1i(lumaTextureUniform, 1);   // Use texture unit 1
    gl.uniform1f(useLumaMatteUniform, 0.0);
    gl.uniform1f(useCornerPinUniform, 0.0);
    
    // Set initial viewport
    gl.viewport(0, 0, canvas.width, canvas.height);
    
    // Set initial uniforms
    updateTransform();
    
    // Clear canvas with transparent background
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    // Clean up shaders (moved to the end, after all checks)
    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    
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
        const baseWidth = BASE_WIDTH;
        const baseHeight = BASE_HEIGHT;
        
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
        const videoWidth = videoPreview.videoWidth || BASE_WIDTH;
        const videoHeight = videoPreview.videoHeight || BASE_HEIGHT;
        
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
    const hitRadius = Math.min(BASE_WIDTH, BASE_HEIGHT) * HIT_RADIUS_MULTIPLIER; // Increased hit area for better interaction

    function getMousePos(e) {
        const rect = cornerPinCanvas.getBoundingClientRect();
        // Always use 3840x2160 coordinate system
        const baseWidth = BASE_WIDTH;
        const baseHeight = BASE_HEIGHT;
        
        // Convert mouse position to our fixed coordinate system
        return {
            x: (e.clientX - rect.left) * (baseWidth / cornerPinCanvas.width),
            y: (e.clientY - rect.top) * (baseHeight / cornerPinCanvas.height)
        };
    }

    function findClosestPoint(pos) {
        const hitRadius = Math.min(BASE_WIDTH, BASE_HEIGHT) * HIT_RADIUS_MULTIPLIER;
        const baseWidth = BASE_WIDTH;
        const baseHeight = BASE_HEIGHT;
        
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

// Update renderFrame function
function renderFrame() {
    if (!gl || !videoPreview || !videoTexture) return;

    try {
        // 1. Reduce state changes
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        
        // 2. Use a single clear call
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // 3. Pre-sort rectangles by z-index and cache the result
        if (!window.sortedRectanglesCache) {
            window.sortedRectanglesCache = [...rectangles].sort((a, b) => a.zIndex - b.zIndex);
        }

        // 4. Batch similar operations
        gl.activeTexture(gl.TEXTURE0);
        
        for (const rect of window.sortedRectanglesCache) {
            if (!rect.isMainTrack && !rect.videoElement) continue;
            
            const video = rect.isMainTrack ? videoPreview : rect.videoElement;
            if (!video || video.readyState < 2) continue;

            // 5. Minimize uniform updates
            if (rect.lastUniformState !== rect.isMainTrack) {
                gl.uniform1f(useCornerPinUniform, rect.isMainTrack ? 0.0 : 1.0);
                rect.lastUniformState = rect.isMainTrack;
            }

            // 6. Optimize texture updates
            const mainTexture = rect.isMainTrack ? videoTexture : compositeTextures.get(rect.id);
            gl.bindTexture(gl.TEXTURE_2D, mainTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

            // 7. Handle luma matte more efficiently
            if (rect.lumaMatte?.video?.readyState >= 2) {
                // Use the tighter sync threshold
                const timeDiff = Math.abs(rect.lumaMatte.video.currentTime - video.currentTime);
                if (timeDiff > LUMA_SYNC_THRESHOLD) {
                    rect.lumaMatte.video.currentTime = video.currentTime;
                }
                
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, rect.lumaMatteTexture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rect.lumaMatte.video);
                gl.uniform1i(lumaTextureUniform, 1);
                gl.uniform1f(useLumaMatteUniform, 1.0);
                gl.activeTexture(gl.TEXTURE0);
            } else {
                gl.uniform1f(useLumaMatteUniform, 0.0);
            }

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        // 8. Use RAF more efficiently
        if (!videoPreview.paused) {
            window.rafId = requestAnimationFrame(renderFrame);
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

    // Add these optimizations to the video loading process
    videoPreview.addEventListener('loadedmetadata', () => {
        // 1. Enable hardware acceleration
        videoPreview.style.transform = 'translateZ(0)';
        
        // 2. Optimize video buffering
        videoPreview.preload = 'auto';
        videoPreview.autobuffer = true;
        
        // 3. Set optimal video quality
        if (videoPreview.videoWidth > 1920) {
            canvas.width = 1920;
            canvas.height = Math.floor(1920 * (videoPreview.videoHeight / videoPreview.videoWidth));
        }
        
        // 4. Enable WebGL optimizations
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    });

    // Add video playback optimization
    optimizeVideoPlayback();
});

// Add video playback optimization
function optimizeVideoPlayback() {
    // Set video element properties for better performance
    videoPreview.style.backfaceVisibility = 'hidden';
    videoPreview.style.transform = 'translateZ(0)'; // Hardware acceleration
    videoPreview.style.willChange = 'transform';
    
    // Optimize buffering strategy
    videoPreview.preload = 'auto';
    videoPreview.autobuffer = true;
    
    // Set playback quality
    if ('fastSeek' in videoPreview) {
        videoPreview.preservesPitch = false; // Reduce processing overhead
    }
    
    // Reduce memory usage
    videoPreview.removeAttribute('poster');
    
    // Set optimal buffer size
    const bufferSize = 2; // Buffer 2 seconds ahead
    videoPreview.addEventListener('progress', () => {
        if (videoPreview.buffered.length > 0) {
            const currentBuffer = videoPreview.buffered.end(videoPreview.buffered.length - 1);
            if (currentBuffer - videoPreview.currentTime > bufferSize) {
                // Enough buffer, pause loading
                videoPreview.preload = 'none';
            } else {
                // Need more buffer
                videoPreview.preload = 'auto';
            }
        }
    });
}

// Call this when video is loaded
videoPreview.addEventListener('loadedmetadata', () => {
    optimizeVideoPlayback();
    // ... rest of your loadedmetadata code ...
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

// Add progress bar for transcoding
const transcodingProgress = document.createElement('div');
transcodingProgress.className = 'transcoding-progress';
transcodingProgress.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.8);
    padding: 20px;
    border-radius: 8px;
    color: white;
    display: none;
    z-index: 1000;
`;
transcodingProgress.innerHTML = `
    <div>Transcoding video...</div>
    <div class="progress-bar" style="width: 200px; height: 10px; background: #333; margin-top: 10px;">
        <div class="progress-fill" style="width: 0%; height: 100%; background: #4CAF50; transition: width 0.3s;"></div>
    </div>
`;
document.body.appendChild(transcodingProgress);

// Update video input handler
videoInput.addEventListener('change', async (event) => {
    try {
        const file = event.target.files[0];
        if (!file) {
            console.warn('No file selected');
            return;
        }

        console.log('Loading video file:', {
            name: file.name,
            type: file.type,
            size: file.size
        });

        // Reset video state
        if (!videoPreview.paused) {
            await videoPreview.pause();
        }
        videoPreview.currentTime = 0;

        // Show transcoding progress
        transcodingProgress.style.display = 'block';
        const progressFill = transcodingProgress.querySelector('.progress-fill');
        
        // Set up progress callback
        segmentManager.setProgressCallback((progress) => {
            progressFill.style.width = `${progress * 100}%`;
            console.log('Transcoding progress:', Math.round(progress * 100) + '%');
        });
        
        // Set up video element properties
        videoPreview.muted = true;
        videoPreview.playsInline = true;
        videoPreview.loop = true;
        videoPreview.crossOrigin = 'anonymous';
        videoPreview.preload = 'auto';

        // Make sure video and canvas are visible
        videoPreview.style.display = 'block';
        canvas.style.display = 'block';

        try {
            // Initialize FFmpeg if needed
            if (!segmentManager.isLoaded) {
                console.log('Initializing FFmpeg...');
                await segmentManager.initialize();
            }

            // Initialize adaptive streaming
            console.log('Initializing adaptive streaming...');
            await adaptiveStreamingManager.initialize(videoPreview);
            
            // Start loading initial segments
            const videoBlob = new Blob([file], { type: file.type });
            const initialQuality = adaptiveStreamingManager.getCurrentQuality();
            
            console.log('Starting transcoding with quality:', initialQuality);
            
            // Generate and append initial segments
            const segments = await segmentManager.generateSegments(videoBlob, initialQuality);
            
            if (!segments || segments.length === 0) {
                throw new Error('No segments generated');
            }
            
            console.log(`Generated ${segments.length} segments`);
            
            // First append initialization segment
            const initSegment = segments.find(s => s.isInit);
            if (!initSegment) {
                throw new Error('No initialization segment found');
            }

            console.log('Appending initialization segment...');
            const initSuccess = await adaptiveStreamingManager.appendSegment(initSegment.data, true);
            if (!initSuccess) {
                throw new Error('Failed to append initialization segment');
            }
            
            // Then append media segments
            console.log('Appending media segments...');
            for (const segment of segments.filter(s => !s.isInit)) {
                const success = await adaptiveStreamingManager.appendSegment(segment.data, false);
                if (!success) {
                    console.warn('Failed to append media segment');
                }
            }

            // Hide transcoding progress
            transcodingProgress.style.display = 'none';

            // Add quality change listener
            videoPreview.addEventListener('qualitychange', async (e) => {
                const newQuality = e.detail;
                console.log('Quality changing to:', newQuality.name);
                
                // Show transcoding progress for quality change
                transcodingProgress.style.display = 'block';
                progressFill.style.width = '0%';
                
                try {
                    // Generate segments for new quality
                    const currentTime = videoPreview.currentTime;
                    const segmentIndex = Math.floor(currentTime / segmentManager.segmentDuration);
                    const nextSegments = await segmentManager.generateSegments(
                        videoBlob,
                        newQuality,
                        segmentIndex * segmentManager.segmentDuration
                    );
                    
                    // First append initialization segment for new quality
                    const newInitSegment = nextSegments.find(s => s.isInit);
                    if (!newInitSegment) {
                        throw new Error('No initialization segment found for quality change');
                    }
                    await adaptiveStreamingManager.appendSegment(newInitSegment.data, true);
                    
                    // Then append media segments
                    for (const segment of nextSegments.filter(s => !s.isInit)) {
                        await adaptiveStreamingManager.appendSegment(segment.data, false);
                    }
                } finally {
                    // Hide transcoding progress
                    transcodingProgress.style.display = 'none';
                }
            });

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

            // Wait for video to be ready
            await new Promise((resolve, reject) => {
                const onCanPlay = () => {
                    videoPreview.removeEventListener('canplay', onCanPlay);
                    videoPreview.removeEventListener('error', onError);
                    resolve();
                };
                const onError = (error) => {
                    videoPreview.removeEventListener('canplay', onCanPlay);
                    videoPreview.removeEventListener('error', onError);
                    reject(error);
                };
                
                if (videoPreview.readyState >= 3) {
                    resolve();
                } else {
                    videoPreview.addEventListener('canplay', onCanPlay);
                    videoPreview.addEventListener('error', onError);
                }
            });

            // Resize canvas to fit video
            console.log('Resizing canvas...');
            resizeCanvasToFitVideo();

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
                requestAnimationFrame(renderFrame);
                
                console.log('Playback started successfully');
            } catch (playError) {
                console.error('Error starting playback:', playError);
                playPauseBtn.textContent = '▶';
            }
        } catch (error) {
            console.error('Error in video processing:', error);
            transcodingProgress.style.display = 'none';
            // *** IMPORTANT: Cleanup on error ***
            await cleanupVideoResources(); // Call cleanup here
            throw error; // Re-throw to be caught by outer catch
        }

    } catch (error) {
        console.error('Error setting up video:', error);
        alert('Error loading video: ' + error.message);
        transcodingProgress.style.display = 'none';
    }
});

// Update video event listeners
videoPreview.addEventListener('waiting', () => {
    console.log('Video waiting for data...', {
        currentTime: videoPreview.currentTime,
        readyState: videoPreview.readyState,
        networkState: videoPreview.networkState,
        buffered: Array.from(videoPreview.buffered).map(i => ({
            start: videoPreview.buffered.start(i),
            end: videoPreview.buffered.end(i)
        }))
    });
});

videoPreview.addEventListener('stalled', () => {
    console.log('Video playback stalled', {
        currentTime: videoPreview.currentTime,
        readyState: videoPreview.readyState,
        networkState: videoPreview.networkState
    });
});

videoPreview.addEventListener('suspend', () => {
    console.log('Video download suspended', {
        currentTime: videoPreview.currentTime,
        readyState: videoPreview.readyState,
        networkState: videoPreview.networkState
    });
});

videoPreview.addEventListener('play', () => {
    console.log('Video started playing', {
        currentTime: videoPreview.currentTime,
        readyState: videoPreview.readyState
    });
    videoMetadata.isPlaying = true;
    
    // Start render loop with error handling
    function animate() {
        try {
            renderFrame();
            if (!videoPreview.paused) {
                requestAnimationFrame(animate);
            }
        } catch (error) {
            console.error('Error in render loop:', error);
        }
    }
    requestAnimationFrame(animate);
});

// Add buffer monitoring
setInterval(() => {
    if (videoPreview && videoPreview.readyState > 0) {
        const buffered = [];
        for (let i = 0; i < videoPreview.buffered.length; i++) {
            buffered.push({
                start: videoPreview.buffered.start(i),
                end: videoPreview.buffered.end(i)
            });
        }
        console.debug('Buffer state:', {
            currentTime: videoPreview.currentTime,
            readyState: videoPreview.readyState,
            buffered,
            duration: videoPreview.duration
        });
    }
}, 1000);

// ... existing code ...

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

// Update export button initialization
if (!exportVideoBtn) {
    console.error('Export button not found in DOM');
} else {
    console.log('Export button found and initialized');
    exportVideoBtn.addEventListener('click', () => {
        console.log('Export button clicked');
        exportTransformedVideo();
    });
}

// Play/Pause functionality
playPauseBtn.addEventListener('click', async () => {
    try {
        if (videoPreview.paused) {
            videoMetadata.wasPlaying = true;
            // Start all videos
            const playPromises = rectangles
                .filter(rect => rect.videoElement && rect.videoElement.readyState >= 2)
                .map(rect => {
                    rect.videoElement.currentTime = videoPreview.currentTime;
                    return rect.videoElement.play();
                });
            
            playPromises.push(videoPreview.play());
            
            await Promise.all(playPromises);
            playPauseBtn.textContent = '⏸';
            requestAnimationFrame(renderFrame);
        } else {
            videoMetadata.wasPlaying = false;
            // Pause all videos
            rectangles
                .filter(rect => rect.videoElement)
                .forEach(rect => rect.videoElement.pause());
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
    new TimelineRectangle(5),
    new TimelineRectangle(6)
];

// Set main track properties
rectangles[0].isMainTrack = true;
rectangles[0].zIndex = 0; // Main track on bottom

// Initialize rectangles with z-indices and positions
rectangles[1].zIndex = 1;  // ID 2
rectangles[2].zIndex = 2;  // ID 3 - one level higher
rectangles[3].zIndex = 1;  // ID 4
rectangles[4].zIndex = 1;  // ID 5
rectangles[5].zIndex = 1;  // ID 6

// Set frame ranges
rectangles[0].startFrame = 0;
rectangles[0].endFrame = 240;  // Full duration

rectangles[1].startFrame = 0;   // ID 2
rectangles[1].endFrame = 67;

rectangles[2].startFrame = 0;   // ID 3
rectangles[2].endFrame = 67;

rectangles[3].startFrame = 68;  // ID 4
rectangles[3].endFrame = 152;

rectangles[4].startFrame = 153; // ID 5
rectangles[4].endFrame = 208;

rectangles[5].startFrame = 209; // ID 6
rectangles[5].endFrame = 240;

// Set corner pin coordinates for each rectangle (skip main track)
// Rectangle 2 (ID 2)
rectangles[1].cornerPin = {
    topLeft: { x: 1974, y: 0 },      // Clamped -172 to 0
    topRight: { x: 3840, y: 1268 },  // Clamped 3912 to 3840
    bottomLeft: { x: 1944, y: 2160 }, // Clamped 2424 to 2160
    bottomRight: { x: 3840, y: 2160 } // Clamped 4036,2464 to 3840,2160
};

// Rectangle 3 (ID 3)
rectangles[2].cornerPin = {
    topLeft: { x: 0, y: 1164 },     // Clamped -72 to 0
    topRight: { x: 1920, y: 0 },    // Clamped -188 to 0
    bottomLeft: { x: 0, y: 2160 },  // Clamped -336,2560 to 0,2160
    bottomRight: { x: 1916, y: 1956 }
};

// Rectangle 4 (ID 4)
rectangles[3].cornerPin = {
    topLeft: { x: 96, y: 0 },
    topRight: { x: 3720, y: 8 },
    bottomLeft: { x: 288, y: 2088 },
    bottomRight: { x: 3704, y: 1976 }
};

// Rectangle 5 (ID 5)
rectangles[4].cornerPin = {
    topLeft: { x: 544, y: 64 },
    topRight: { x: 3824, y: 64 },
    bottomLeft: { x: 544, y: 2160 }, // Clamped 2216 to 2160
    bottomRight: { x: 3824, y: 2160 } // Clamped 2192 to 2160
};

// Rectangle 6 (ID 6)
rectangles[5].cornerPin = {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 3840, y: 0 },
    bottomLeft: { x: 0, y: 2160 },
    bottomRight: { x: 3840, y: 2160 }
};

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
    const fps = DEFAULT_FPS; // Frames per second
    const duration = videoPreview.duration || 0;
    const totalFrames = Math.floor(duration * fps);
    const timelineWidth = TIMELINE_WIDTH; // Match the timeline-line width
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
    // Skip creating marker for main track
    if (rectangle.isMainTrack) {
        return;
    }

    const marker = document.createElement('div');
    marker.className = 'thumbnail-marker';
    marker.dataset.id = rectangle.id;
    
    const timelineWidth = TIMELINE_WIDTH;
    const totalFrames = Math.floor(videoPreview.duration * DEFAULT_FPS);
    const frameWidth = timelineWidth / totalFrames;
    
    marker.style.left = `${rectangle.startFrame * frameWidth}px`;
    marker.style.width = `${(rectangle.endFrame - rectangle.startFrame) * frameWidth}px`;
    marker.style.zIndex = rectangle.zIndex;
    
    // Calculate vertical position based on z-index
    const markerHeight = 40; // Height of the marker
    const baseOffset = -70; // Moved down to be closer to timeline line
    const verticalSpacing = 60; // Keep the same spacing between markers
    marker.style.top = `${baseOffset + (rectangle.zIndex - 1) * verticalSpacing}px`;
    
    // Add video selection button
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
        e.stopPropagation();
        compositeVideoInput.click();
    });
    
    marker.appendChild(selectButton);
    marker.appendChild(compositeVideoInput);

    // Rest of the marker setup code...
    // ... existing event listeners and functionality ...

    thumbnailMarkers.appendChild(marker);
    return marker;
}

// Update mouse event listeners for dragging and resizing
document.addEventListener('mousemove', (e) => {
    if (!isDragging && !isResizing || !currentMarker) return;

    const timelineWidth = TIMELINE_WIDTH; // Match the timeline-line width
    const totalFrames = Math.floor(videoPreview.duration * DEFAULT_FPS);
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
        console.log('Starting FFmpeg load...');
        await ffmpeg.load();
        isFFmpegLoaded = true;
        console.log('FFmpeg loaded successfully');
        // Enable export button once FFmpeg is loaded
        if (exportVideoBtn) {
            exportVideoBtn.disabled = false;
            console.log('Export button enabled');
        } else {
            console.error('Export button not found in DOM');
        }
    } catch (error) {
        console.error('Error loading FFmpeg:', error);
        isFFmpegLoaded = false;
        if (exportVideoBtn) {
            exportVideoBtn.disabled = true;
        }
    }
}

// Separate export state tracking
let isExporting = false;

// Update export function to create high-quality MP4 with audio
async function exportTransformedVideo() {
    console.log('Export function called');
    
    if (isExporting) {
        console.log('Export already in progress');
        return;
    }
    
    if (!isFFmpegLoaded) {
        console.error('FFmpeg not loaded, cannot export');
        alert('Please wait for FFmpeg to load');
        return;
    }
    
    if (!videoPreview.src) {
        console.error('No video loaded, cannot export');
        alert('Please upload a video first');
        return;
    }
    
    console.log('Starting export process');
    isExporting = true;
    progressBar.style.display = 'block';
    
    // Store original playback state
    const wasPlaying = !videoPreview.paused;
    const originalTime = videoPreview.currentTime;
    const originalLoop = videoPreview.loop;
    
    try {
        // Extract audio from main track
        const mainVideoResponse = await fetch(videoPreview.src);
        const mainVideoBlob = await mainVideoResponse.blob();
        await ffmpeg.writeFile('main_video.mp4', new Uint8Array(await mainVideoBlob.arrayBuffer()));
        
        // Extract audio to separate file
        await ffmpeg.exec([
            '-i', 'main_video.mp4',
            '-vn', '-acodec', 'copy',
            'audio.aac'
        ]);

        // Ensure all videos are ready
        const videosToSync = rectangles
            .filter(rect => rect.videoElement && rect.videoElement.readyState < 2)
            .map(rect => new Promise((resolve, reject) => { // Add reject
                rect.videoElement.addEventListener('loadeddata', resolve, { once: true });
                rect.videoElement.addEventListener('error', reject, { once: true }); // Add error listener
            }));
        
        if (videosToSync.length > 0) {
            console.log('Waiting for all videos to be ready...');
            await Promise.all(videosToSync);
        }

        // Calculate framerate and total frames
        const frameRate = 30;
        const duration = videoPreview.duration;
        const totalFrames = Math.floor(duration * frameRate);
        
        console.log('Export settings:', {
            frameRate,
            duration,
            totalFrames,
            mainTrackWidth: videoPreview.videoWidth,
            mainTrackHeight: videoPreview.videoHeight
        });

        // Create temporary canvas for frame capture
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');

        // Process frames
        console.log('Starting frame capture...');
        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            const targetTime = frameIndex / frameRate;
            
            // Sync all videos to target time
            const seekPromises = [
                new Promise(resolve => {
                    const onSeeked = () => {
                        if (Math.abs(videoPreview.currentTime - targetTime) <= 0.001) {
                            videoPreview.removeEventListener('seeked', onSeeked);
                            resolve();
                        } else {
                            videoPreview.currentTime = targetTime;
                        }
                    };
                    videoPreview.addEventListener('seeked', onSeeked);
                    videoPreview.currentTime = targetTime;
                }),
                ...rectangles
                    .filter(rect => rect.videoElement)
                    .map(rect => new Promise(resolve => {
                        const onSeeked = () => {
                            if (Math.abs(rect.videoElement.currentTime - targetTime) <= 0.001) {
                                rect.videoElement.removeEventListener('seeked', onSeeked);
                                resolve();
                            } else {
                                rect.videoElement.currentTime = targetTime;
                            }
                        };
                        rect.videoElement.addEventListener('seeked', onSeeked);
                        rect.videoElement.currentTime = targetTime;
                    }))
            ];

            await Promise.all(seekPromises);

            // Render and capture frame
            await new Promise((resolve, reject) => {
                requestAnimationFrame(async () => {
                    try {
                        // Render the frame
                        renderFrame();
                        
                        // Copy WebGL canvas to temporary canvas
                        tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
                        tempCtx.drawImage(canvas, 0, 0);
                        
                        // Convert to blob and save
                        const blob = await new Promise(resolve => tempCanvas.toBlob(resolve, 'image/png'));
                        const frameData = await blob.arrayBuffer();
                        const frameName = `frame_${frameIndex.toString().padStart(6, '0')}.png`;
                        await ffmpeg.writeFile(frameName, new Uint8Array(frameData));
                        
                        progressBarFill.style.width = `${(frameIndex / totalFrames) * 75}%`;
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            });
        }

        console.log('Frame capture complete. Encoding video...');
        progressBarFill.style.width = '80%';

        // Encode video with FFmpeg
        await ffmpeg.exec([
            '-framerate', frameRate.toString(),
            '-i', 'frame_%06d.png',
            '-i', 'audio.aac',
            '-c:v', 'libx264',
            '-preset', 'slow',
            '-crf', '18',
            '-profile:v', 'high',
            '-tune', 'film',
            '-movflags', '+faststart',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '320k',
            '-y',
            'output.mp4'
        ]);

        console.log('Video encoding complete. Preparing download...');
        progressBarFill.style.width = '95%';

        // Prepare download
        const data = await ffmpeg.readFile('output.mp4');
        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'transformed_video.mp4';
        a.click();

        // Cleanup
        progressBar.style.display = 'none';
        URL.revokeObjectURL(url);
        
        // Clean up FFmpeg state and temporary files
        try {
            // Clean up frame files
            for (let i = 0; i < totalFrames; i++) {
                const frameName = `frame_${i.toString().padStart(6, '0')}.png`;
                await ffmpeg.deleteFile(frameName);
            }
            await ffmpeg.deleteFile('main_video.mp4');
            await ffmpeg.deleteFile('audio.aac');
            await ffmpeg.deleteFile('output.mp4');
            await ffmpeg.exec(['-y']);
        } catch (e) {
            console.warn('FFmpeg cleanup error:', e);
        }
        
        progressBarFill.style.width = '100%';
    } catch (error) {
        console.error('Error exporting video:', error);
        alert('Error exporting video: ' + error.message);
    } finally {
        isExporting = false;
        // Restore original state
        videoPreview.currentTime = originalTime;
        videoPreview.loop = originalLoop;
        rectangles.forEach(rect => {
            if (rect.videoElement) {
                rect.videoElement.currentTime = originalTime;
            }
            if (rect.lumaMatte?.video) {
                rect.lumaMatte.video.currentTime = originalTime;
            }
        });
        
        if (wasPlaying) {
            try {
                const playPromises = rectangles
                    .filter(rect => rect.videoElement)
                    .map(rect => rect.videoElement.play());
                playPromises.push(videoPreview.play());
                await Promise.all(playPromises);
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
            safeRevokeObjectURL(rect.lumaMatte.source); // Use safe revoke
            if (rect.lumaMatteTexture) {
                gl.deleteTexture(rect.lumaMatteTexture);
            }
            // Remove luma matte from sync worker
            videoSyncWorker.postMessage({ type: 'remove', videoId: 'luma' });
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

        // Create new texture for luma matte
        const lumaTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, lumaTexture);
        
        // Set texture parameters for video
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        // Wait for metadata and video to be ready
        await new Promise((resolve, reject) => {
            const onError = (e) => {
                console.error('Luma video error:', e);
                reject(new Error('Failed to load luma matte video'));
            };

            lumaVideo.addEventListener('loadedmetadata', () => {
                console.debug('Luma video metadata loaded:', {
                    width: lumaVideo.videoWidth,
                    height: lumaVideo.videoHeight,
                    duration: lumaVideo.duration
                });
            });

            lumaVideo.addEventListener('canplay', () => {
                console.debug('Luma video can play');
                resolve();
            }, { once: true });

            lumaVideo.addEventListener('error', onError, { once: true });
        });

        // Store luma matte info
        rect.lumaMatteTexture = lumaTexture;
        rect.lumaMatte = {
            video: lumaVideo,
            source: url,
            texture: lumaTexture
        };

        // Sync with main video
        lumaVideo.currentTime = videoPreview.currentTime;
        if (!videoPreview.paused) {
            await lumaVideo.play();
        }

        // Update UI
        toggleLumaMatteBtn.textContent = 'Change Luma Matte';
        toggleLumaMatteBtn.classList.add('active');

        // Force a frame render
        requestAnimationFrame(renderFrame);

        console.log('Luma matte setup complete');

        // Initialize luma video in sync worker
        videoSyncWorker.postMessage({
            type: 'init',
            videoId: 'luma'
        });

        // Add frame update handler
        lumaVideo.addEventListener('timeupdate', () => {
            if (!videoPreview.paused) {
                videoSyncWorker.postMessage({
                    type: 'frame',
                    videoId: 'luma',
                    mediaTime: lumaVideo.currentTime,
                    timestamp: performance.now(),
                    expectedDisplay: lumaVideo.currentTime + (1 / DEFAULT_FPS) // Use constant
                });
            }
        });

    } catch (error) {
        console.error('Error setting up luma matte:', error);
        alert('Error setting up luma matte: ' + error.message);
        // *** IMPORTANT: Cleanup luma matte resources on error ***
        if (rect.lumaMatte) {
            rect.lumaMatte.video.pause();
            safeRevokeObjectURL(rect.lumaMatte.source);
            if (rect.lumaMatteTexture) {
                gl.deleteTexture(rect.lumaMatteTexture);
            }
            rect.lumaMatte = null;
            rect.lumaMatteTexture = null;
        }
    }
});

// Add this function to continuously monitor and sync luma matte videos
function monitorLumaMatteSync() {
    const selectedRect = selectedMarker ? 
        rectangles.find(r => r.id === parseInt(selectedMarker.dataset.id)) : 
        null;

    if (selectedRect && selectedRect.lumaMatte && selectedRect.lumaMatte.video) {
        const lumaVideo = selectedRect.lumaMatte.video;
        const mainVideo = selectedRect.isMainTrack ? videoPreview : selectedRect.videoElement;
        
        // Check for significant drift only (increased threshold)
        const drift = Math.abs(lumaVideo.currentTime - mainVideo.currentTime);
        if (drift > 0.1) { // Increased to 100ms threshold
            // Smoothly adjust time instead of hard sync
            const adjustment = drift * 0.5; // 50% adjustment
            lumaVideo.currentTime = mainVideo.currentTime - adjustment;
        }

        // Only adjust playback state if really needed
        if (!mainVideo.paused && lumaVideo.paused) {
            lumaVideo.play().catch(console.error);
        } else if (mainVideo.paused && !lumaVideo.paused) {
            lumaVideo.pause();
        }
    }
}

// Add throttled sync monitor
let syncMonitorId = null;
let lastSyncTime = 0;
const SYNC_INTERVAL = 100; // Check every 100ms instead of every frame

function startSyncMonitor() {
    function monitor(timestamp) {
        if (!lastSyncTime || timestamp - lastSyncTime >= SYNC_INTERVAL) {
            monitorLumaMatteSync();
            lastSyncTime = timestamp;
        }
        syncMonitorId = requestAnimationFrame(monitor);
    }
    syncMonitorId = requestAnimationFrame(monitor);
}

function stopSyncMonitor() {
    if (syncMonitorId) {
        cancelAnimationFrame(syncMonitorId);
        syncMonitorId = null;
    }
}

// Update video play/pause handlers to start/stop sync monitoring
videoPreview.addEventListener('play', () => {
    startSyncMonitor();
    updatePlayhead();
});

videoPreview.addEventListener('pause', () => {
    stopSyncMonitor();
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

    console.log('Loading composite video for rectangle:', rectangle.id);

    // Clean up existing video if any
    if (rectangle.videoElement) {
        rectangle.videoElement.pause();
        safeRevokeObjectURL(rectangle.videoSource); // Use safe revoke
        if (compositeTextures.has(rectangle.id)) {
            gl.deleteTexture(compositeTextures.get(rectangle.id));
            compositeTextures.delete(rectangle.id);
        }
        // Remove from sync worker (if you extend it to handle composite videos)
        // videoSyncWorker.postMessage({ type: 'remove', videoId: `composite_${rectangle.id}` });
    }

    // Create new video element
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto'; // Add preload
    
    // Add timeupdate listener for debugging
    video.addEventListener('timeupdate', () => {
        console.log(`Composite video ${rectangle.id} time:`, {
            currentTime: video.currentTime,
            mainTime: videoPreview.currentTime,
            readyState: video.readyState,
            playing: !video.paused
        });
    });

    // Add error listener
    video.addEventListener('error', (e) => {
        console.error(`Composite video ${rectangle.id} error:`, e.target.error);
    });

    // Add stalled/waiting listeners
    video.addEventListener('stalled', () => {
        console.warn(`Composite video ${rectangle.id} stalled`);
    });
    
    video.addEventListener('waiting', () => {
        console.warn(`Composite video ${rectangle.id} waiting for data`);
    });

    // Set up video source
    const videoURL = URL.createObjectURL(file);
    video.src = videoURL;

    // Create texture for this composite layer
    const texture = createVideoTexture();
    compositeTextures.set(rectangle.id, texture);
    console.log('Created new texture for composite layer:', rectangle.id);

    // Store video info in rectangle
    rectangle.videoElement = video;
    rectangle.videoSource = videoURL;

    // Update UI
    const marker = document.querySelector(`.thumbnail-marker[data-id="${rectangle.id}"]`);
    if (marker) {
        const selectButton = marker.querySelector('.select-video-btn');
        if (selectButton) {
            selectButton.textContent = '🎥';
            selectButton.title = 'Change Video';
        }
    }

    // Wait for video to be ready before starting playback
    let loadingTimeout;
    const loadPromise = new Promise((resolve, reject) => {
        loadingTimeout = setTimeout(() => {
            reject(new Error('Video load timeout'));
        }, 10000); // 10 second timeout

        video.addEventListener('loadeddata', () => {
            clearTimeout(loadingTimeout);
            console.log('Composite video loaded:', {
                id: rectangle.id,
                width: video.videoWidth,
                height: video.videoHeight,
                duration: video.duration,
                readyState: video.readyState
            });
            resolve();
        }, { once: true });

        video.addEventListener('error', (e) => {
            clearTimeout(loadingTimeout);
            reject(new Error(`Video load error: ${e.target.error.message}`));
        }, { once: true });
    });

    loadPromise.then(() => {
        console.log(`Video loaded for rectangle ${rectangle.id}`);
        if (!videoPreview.paused) {
            video.currentTime = videoPreview.currentTime;
            return video.play().catch(error => {
                console.warn('Failed to start composite video playback:', error);
            });
        }
    }).catch(error => {
        console.error(`Error loading video for rectangle ${rectangle.id}:`, error);
        // *** IMPORTANT: Cleanup on error ***
        rectangle.videoElement.pause();
        safeRevokeObjectURL(rectangle.videoSource);
        if (compositeTextures.has(rectangle.id)) {
            gl.deleteTexture(compositeTextures.get(rectangle.id));
            compositeTextures.delete(rectangle.id);
        }
        rectangle.videoElement = null;
        rectangle.videoSource = null;
    }).finally(() => {
        // Force a render frame update
        requestAnimationFrame(renderFrame);
    });
}

// Add auto-loading functionality for main video and luma matte
window.addEventListener('load', async () => {
    console.log('Starting auto-load process...');
    
    // Initialize FFmpeg first
    try {
        if (!isFFmpegLoaded) {
            console.log('Loading FFmpeg...');
            await ffmpeg.load();
            isFFmpegLoaded = true;
            console.log('FFmpeg loaded successfully');
        }
    } catch (error) {
        console.error('Failed to load FFmpeg:', error);
        throw new Error('Failed to initialize FFmpeg: ' + error.message);
    }

    try {
        // Initialize segment manager
        if (!segmentManager.isLoaded) {
            console.log('Initializing segment manager...');
            await segmentManager.initialize();
            console.log('Segment manager initialized');
        }

        // Load main video
        console.log('Fetching main video...');
        const mainVideoResponse = await fetch('/Intro - Montage TopLayer.mp4');
        if (!mainVideoResponse.ok) {
            throw new Error(`Failed to fetch main video: ${mainVideoResponse.status} ${mainVideoResponse.statusText}`);
        }
        
        console.log('Converting main video to blob...');
        const mainVideoBlob = await mainVideoResponse.blob();
        console.log('Main video blob size:', mainVideoBlob.size);
        
        const mainVideoFile = new File([mainVideoBlob], 'Intro - Montage TopLayer.mp4', { type: 'video/mp4' });
        
        // Initialize adaptive streaming
        console.log('Initializing adaptive streaming...');
        await adaptiveStreamingManager.initialize(videoPreview);
        console.log('Adaptive streaming initialized');
        
        // Set up video input
        console.log('Setting up video input...');
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(mainVideoFile);
        videoInput.files = dataTransfer.files;
        
        // Set up progress callback
        segmentManager.setProgressCallback((progress) => {
            console.log('Transcoding progress:', Math.round(progress * 100) + '%');
            const progressFill = transcodingProgress.querySelector('.progress-fill');
            if (progressFill) {
                progressFill.style.width = `${progress * 100}%`;
            }
        });

        console.log('Dispatching change event...');
        videoInput.dispatchEvent(new Event('change', { bubbles: true }));

        // Wait for video to be loaded with timeout and progress checks
        console.log('Waiting for video to be ready...');
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const state = {
                    readyState: videoPreview.readyState,
                    error: videoPreview.error,
                    networkState: videoPreview.networkState,
                    src: videoPreview.src,
                    currentSrc: videoPreview.currentSrc,
                    paused: videoPreview.paused,
                    seeking: videoPreview.seeking,
                    ended: videoPreview.ended,
                    muted: videoPreview.muted,
                    duration: videoPreview.duration,
                    buffered: videoPreview.buffered.length > 0 ? {
                        start: videoPreview.buffered.start(0),
                        end: videoPreview.buffered.end(0)
                    } : null
                };
                console.error('Video load timeout. Current state:', state);
                reject(new Error('Video load timeout after 30 seconds. Video state: ' + JSON.stringify(state)));
            }, 30000);

            let lastProgress = 0;
            const progressInterval = setInterval(() => {
                if (videoPreview.buffered.length > 0) {
                    const progress = (videoPreview.buffered.end(0) / videoPreview.duration) * 100;
                    if (progress !== lastProgress) {
                        console.log(`Loading progress: ${Math.round(progress)}%`);
                        lastProgress = progress;
                    }
                }
            }, 500);

            const checkVideo = () => {
                console.log('Checking video state:', {
                    readyState: videoPreview.readyState,
                    error: videoPreview.error,
                    networkState: videoPreview.networkState,
                    src: videoPreview.src,
                    currentSrc: videoPreview.currentSrc,
                    buffered: videoPreview.buffered.length > 0 ? {
                        start: videoPreview.buffered.start(0),
                        end: videoPreview.buffered.end(0)
                    } : null
                });
                
                if (videoPreview.error) {
                    clearTimeout(timeout);
                    clearInterval(progressInterval);
                    reject(new Error(`Video error: ${videoPreview.error.message}`));
                } else if (videoPreview.readyState >= 2) {
                    clearTimeout(timeout);
                    clearInterval(progressInterval);
                    resolve();
                } else {
                    setTimeout(checkVideo, 500);
                }
            };
            checkVideo();

            // Add event listeners for debugging
            videoPreview.addEventListener('loadstart', () => console.log('Video loadstart event fired'));
            videoPreview.addEventListener('durationchange', () => console.log('Video durationchange event fired'));
            videoPreview.addEventListener('loadedmetadata', () => console.log('Video loadedmetadata event fired'));
            videoPreview.addEventListener('loadeddata', () => console.log('Video loadeddata event fired'));
            videoPreview.addEventListener('progress', () => console.log('Video progress event fired'));
            videoPreview.addEventListener('canplay', () => console.log('Video canplay event fired'));
            videoPreview.addEventListener('canplaythrough', () => console.log('Video canplaythrough event fired'));
            videoPreview.addEventListener('error', (e) => console.error('Video error event:', e.target.error));
        });

        console.log('Video loaded successfully');

        // Rest of the auto-loading process...
        // ... existing code for luma matte loading ...

    } catch (error) {
        console.error('Error in auto-loading process:', error);
        // Show error to user with more details
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 20px;
            border-radius: 8px;
            z-index: 1000;
            max-width: 80%;
            text-align: center;
            font-family: monospace;
        `;
        errorDiv.innerHTML = `
            <h3>Error Loading Video</h3>
            <p style="color: #ff6b6b;">${error.message}</p>
            <pre style="text-align: left; margin: 10px 0; padding: 10px; background: rgba(255,255,255,0.1);">
Video State:
- Ready State: ${videoPreview.readyState}
- Network State: ${videoPreview.networkState}
- Error: ${videoPreview.error ? videoPreview.error.message : 'None'}
- Source: ${videoPreview.currentSrc || 'Not set'}
            </pre>
            <button onclick="this.parentElement.remove()" style="margin-top: 10px; padding: 5px 10px; background: #4a4a4a; border: none; color: white; border-radius: 4px; cursor: pointer;">Close</button>
        `;
        document.body.appendChild(errorDiv);

        // Cleanup on error
        try {
            await cleanupVideoResources();
        } catch (cleanupError) {
            console.warn('Error during cleanup:', cleanupError);
        }
    }
});

// Create video sync worker
const videoSyncWorker = new Worker('/src/video/videoSyncWorker.js');

// Initialize sync worker for main video and luma matte
videoSyncWorker.onmessage = (e) => {
    const { type, videoId, adjustment } = e.data;
    
    if (type === 'sync') {
        // Find the video that needs adjustment
        let videoToAdjust = null;
        if (videoId === 'luma') {
            const selectedRect = selectedMarker ? 
                rectangles.find(r => r.id === parseInt(selectedMarker.dataset.id)) : 
                null;
            if (selectedRect?.lumaMatte?.video) {
                videoToAdjust = selectedRect.lumaMatte.video;
            }
        }
        
        // Apply sync adjustment if needed
        if (videoToAdjust && !videoToAdjust.paused) {
            videoToAdjust.currentTime = videoToAdjust.currentTime + adjustment;
        }
    } else if (type === 'stats') {
        console.debug('Sync stats:', e.data.stats);
    } else if (type === 'error') {
        console.error('Sync worker error:', e.data.error);
    }
};

// Update luma matte setup to use worker
lumaMatteInput.addEventListener('change', async (event) => {
    // ... existing setup code ...

    // Initialize luma video in sync worker
    videoSyncWorker.postMessage({
        type: 'init',
        videoId: 'luma'
    });

    // Add frame update handler
    lumaVideo.addEventListener('timeupdate', () => {
        if (!videoPreview.paused) {
            videoSyncWorker.postMessage({
                type: 'frame',
                videoId: 'luma',
                mediaTime: lumaVideo.currentTime,
                timestamp: performance.now(),
                expectedDisplay: lumaVideo.currentTime + (1 / DEFAULT_FPS) // Use constant
            });
        }
    });

    // ... rest of existing setup code ...
});

// Update video preview event handlers
videoPreview.addEventListener('play', () => {
    videoSyncWorker.postMessage({
        type: 'play',
        masterTime: videoPreview.currentTime
    });
    updatePlayhead();
});

videoPreview.addEventListener('pause', () => {
    videoSyncWorker.postMessage({ type: 'pause' });
});

videoPreview.addEventListener('seeking', () => {
    videoSyncWorker.postMessage({
        type: 'seek',
        time: videoPreview.currentTime
    });
});

// Initialize main video in sync worker
videoPreview.addEventListener('loadedmetadata', () => {
    videoSyncWorker.postMessage({
        type: 'init',
        videoId: 'master'
    });
    
    // Add frame update handler
    videoPreview.addEventListener('timeupdate', () => {
        if (!videoPreview.paused) {
            videoSyncWorker.postMessage({
                type: 'frame',
                videoId: 'master',
                mediaTime: videoPreview.currentTime,
                timestamp: performance.now(),
                expectedDisplay: videoPreview.currentTime + (1 / DEFAULT_FPS) // Use constant
            });
        }
    });
});

// Remove the old sync monitoring code
if (typeof monitorLumaMatteSync === 'function') {
    stopSyncMonitor();
}

// Add panel toggle functionality
const controlsPanel = document.querySelector('.controls-panel');
const mainContent = document.querySelector('.main-content');
const togglePanelBtn = document.querySelector('.toggle-panel-btn');

togglePanelBtn.addEventListener('click', () => {
    controlsPanel.classList.toggle('visible');
    mainContent.classList.toggle('with-panel');
});

// Add performance monitoring
let lastFrameTime = 0;
let frameCount = 0;
const fpsThreshold = 30;

function monitorPerformance(timestamp) {
    if (!lastFrameTime) {
        lastFrameTime = timestamp;
        frameCount = 0;
        return;
    }

    frameCount++;
    const elapsed = timestamp - lastFrameTime;
    
    if (elapsed >= 1000) {
        const fps = Math.round((frameCount * 1000) / elapsed);
        console.debug('Render Performance:', { fps, frameCount, elapsed });
        
        // Adjust quality if needed
        if (fps < fpsThreshold) {
            reduceQuality();
        }
        
        frameCount = 0;
        lastFrameTime = timestamp;
    }
}

function reduceQuality() {
    // Reduce canvas size
    if (canvas.width > 1280) {
        canvas.width = 1280;
        canvas.height = Math.floor(1280 * (videoPreview.videoHeight / videoPreview.videoWidth));
        gl.viewport(0, 0, canvas.width, canvas.height);
    }
    
    // Reduce texture quality
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
}

// Add cleanup function
async function cleanupVideoResources() {
    console.log('Cleaning up video resources...');

    // Clear WebGL resources
    if (gl) {
        if (videoTexture) {
            gl.deleteTexture(videoTexture);
            videoTexture = null; // Set to null after deleting
        }
        compositeTextures.forEach((texture, id) => {
            gl.deleteTexture(texture);
        });
        compositeTextures.clear();

        rectangles.forEach(rect => {
            if (rect.lumaMatteTexture) {
                gl.deleteTexture(rect.lumaMatteTexture);
                rect.lumaMatteTexture = null;
            }
        });

        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.useProgram(null);
        // if program exists, delete it
        if (program) {
            gl.deleteProgram(program);
            program = null;
        }
    }

    // Clear video resources
    rectangles.forEach(rect => {
        if (rect.videoElement) {
            rect.videoElement.pause();
            safeRevokeObjectURL(rect.videoSource); // Use safe revoke
            rect.videoElement.removeAttribute('src'); // Remove src attribute
            rect.videoElement.load();
            rect.videoElement = null; // Set to null
        }
        if (rect.lumaMatte?.video) {
            rect.lumaMatte.video.pause();
            safeRevokeObjectURL(rect.lumaMatte.source);
            rect.lumaMatte.video.removeAttribute('src');
            rect.lumaMatte.video.load();
            rect.lumaMatte.video = null; // Set to null
            rect.lumaMatte = null; // Set lumaMatte to null
        }
    });

    // Clear main video
    if (videoPreview) {
        videoPreview.pause();
        safeRevokeObjectURL(videoPreview.src);
        videoPreview.removeAttribute('src');
        videoPreview.load();
    }

    // Clear adaptive streaming resources
    if (adaptiveStreamingManager) {
        try {
            await adaptiveStreamingManager.cleanup();
        } catch (e) {
            console.warn('Error cleaning up adaptive streaming:', e);
        }
    }

    // Terminate segment manager
    if (segmentManager) {
        try {
            await segmentManager.terminate();
        } catch (e) {
            console.warn('Error terminating segment manager:', e);
        }
    }

    // Terminate workers
    try {
        videoWorker.terminate();
        videoSyncWorker.terminate();
    } catch (e) {
        console.warn('Error terminating workers:', e);
    }

    // Clear any pending timeouts/intervals (add if you have any)
    // clearTimeout(myTimeout);
    // clearInterval(myInterval);

    console.log('Video resources cleaned up');
}

// Optimize event listeners
function optimizeEventListeners() {
    // Throttle resize handler
    let resizeTimeout;
    window.addEventListener('resize', () => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            resizeCanvasToFitVideo();
        }, 150);
    });
    
    // Debounce timeline updates
    let timeUpdateTimeout;
    videoPreview.addEventListener('timeupdate', () => {
        if (timeUpdateTimeout) clearTimeout(timeUpdateTimeout);
        timeUpdateTimeout = setTimeout(() => {
            updatePlayhead();
        }, 33); // ~30fps
    });
}

// Simplified and optimized playhead sync
function createPlayheadSync() {
    let rafId = null;
    const FPS = 30; // Match video frame rate
    const FRAME_DURATION = 1000 / FPS;
    let lastUpdateTime = 0;

    function updatePlayhead(timestamp) {
        if (!videoPreview || !timelineLine) {
            cancelAnimationFrame(rafId);
            return;
        }

        // Only update if enough time has passed (match video frame rate)
        if (timestamp - lastUpdateTime >= FRAME_DURATION) {
            const currentTime = videoPreview.currentTime;
            const progress = currentTime / videoPreview.duration;
            const timelineWidth = timelineLine.offsetWidth;
            
            // Use transform for better performance
            playheadMarker.style.transform = `translateX(${progress * timelineWidth}px)`;
            currentTimeSpan.textContent = formatTime(currentTime);
            
            lastUpdateTime = timestamp;
        }

        // Continue animation only if video is playing
        if (!videoPreview.paused) {
            rafId = requestAnimationFrame(updatePlayhead);
        }
    }

    return {
        start() {
            if (rafId) cancelAnimationFrame(rafId);
            lastUpdateTime = 0;
            rafId = requestAnimationFrame(updatePlayhead);
        },
        stop() {
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        }
    };
}

// Create single instance of playhead sync
const playheadSync = createPlayheadSync();

// Update video event listeners
videoPreview.addEventListener('play', () => {
    // Clear any existing animation
    playheadSync.stop();
    // Start new animation
    playheadSync.start();
});

videoPreview.addEventListener('pause', () => {
    playheadSync.stop();
    // Update one last time to ensure accuracy
    const progress = videoPreview.currentTime / videoPreview.duration;
    const timelineWidth = timelineLine.offsetWidth;
    playheadMarker.style.transform = `translateX(${progress * timelineWidth}px)`;
    currentTimeSpan.textContent = formatTime(videoPreview.currentTime);
});

// Optimize seeking behavior
videoPreview.addEventListener('seeking', () => {
    // Update immediately on seek
    const progress = videoPreview.currentTime / videoPreview.duration;
    const timelineWidth = timelineLine.offsetWidth;
    playheadMarker.style.transform = `translateX(${progress * timelineWidth}px)`;
    currentTimeSpan.textContent = formatTime(videoPreview.currentTime);
});

// Remove old timeupdate listeners that might conflict
videoPreview.removeEventListener('timeupdate', updatePlayhead);
videoPreview.removeEventListener('timeupdate', onTimeUpdate);

// Add sync performance monitoring
let syncStats = {
    lastUpdate: 0,
    updateCount: 0,
    syncErrors: 0,
    maxError: 0
};

function monitorSyncPerformance() {
    const currentTime = videoPreview.currentTime;
    const displayTime = parseFloat(currentTimeSpan.textContent.split(':').join(''));
    const syncError = Math.abs(currentTime - displayTime);
    
    syncStats.updateCount++;
    if (syncError > 0.016) { // More than 1 frame at 60fps
        syncStats.syncErrors++;
        syncStats.maxError = Math.max(syncStats.maxError, syncError);
    }
    
    // Log stats every 5 seconds
    if (Date.now() - syncStats.lastUpdate > 5000) {
        console.debug('Sync Performance:', {
            updates: syncStats.updateCount,
            errors: syncStats.syncErrors,
            maxError: syncStats.maxError.toFixed(3) + 'ms',
            errorRate: ((syncStats.syncErrors / syncStats.updateCount) * 100).toFixed(1) + '%'
        });
        
        // Reset stats
        syncStats = {
            lastUpdate: Date.now(),
            updateCount: 0,
            syncErrors: 0,
            maxError: 0
        };
    }
}

// Add performance monitoring
let playbackStats = {
    droppedFrames: 0,
    totalFrames: 0,
    lastTime: 0,
    frameTimings: []
};

function monitorPlaybackPerformance() {
    if (videoPreview.paused) return;
    
    const now = performance.now();
    const timeDiff = now - playbackStats.lastTime;
    
    if (playbackStats.lastTime !== 0) {
        playbackStats.totalFrames++;
        playbackStats.frameTimings.push(timeDiff);
        
        // Keep only last 60 frames of timing data
        if (playbackStats.frameTimings.length > 60) {
            playbackStats.frameTimings.shift();
        }
        
        // Check for dropped frames (assuming 30fps)
        if (timeDiff > (1000 / 30) * 1.5) {
            playbackStats.droppedFrames++;
        }
        
        // Log performance every 60 frames
        if (playbackStats.totalFrames % 60 === 0) {
            const avgFrameTime = playbackStats.frameTimings.reduce((a, b) => a + b, 0) / playbackStats.frameTimings.length;
            console.debug('Playback Performance:', {
                droppedFrames: playbackStats.droppedFrames,
                dropRate: ((playbackStats.droppedFrames / playbackStats.totalFrames) * 100).toFixed(1) + '%',
                avgFrameTime: avgFrameTime.toFixed(1) + 'ms',
                currentFPS: (1000 / avgFrameTime).toFixed(1)
            });
        }
    }
    
    playbackStats.lastTime = now;
    requestAnimationFrame(monitorPlaybackPerformance);
}

// Start monitoring when video plays
videoPreview.addEventListener('play', () => {
    playbackStats = {
        droppedFrames: 0,
        totalFrames: 0,
        lastTime: 0,
        frameTimings: []
    };
    requestAnimationFrame(monitorPlaybackPerformance);
});

import AdaptiveStreamingManager from './video/adaptiveStreaming.js';
import VideoSegmentManager from './video/segmentManager.js';

// Add adaptive streaming managers
const adaptiveStreamingManager = new AdaptiveStreamingManager();
const segmentManager = new VideoSegmentManager();

// Helper function to safely revoke a URL
function safeRevokeObjectURL(url) {
    if (url) {
        try {
            URL.revokeObjectURL(url);
        } catch (e) {
            console.warn('Error revoking URL:', e);
        }
    }
}