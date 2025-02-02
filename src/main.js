import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

// Initialize FFmpeg
const ffmpeg = new FFmpeg({
    log: true,
});
let isFFmpegLoaded = false;

// WebGL shader sources
const vertexShaderSource = `
    attribute vec2 position;
    varying vec2 vTexCoord;
    uniform mat4 transform;
    uniform vec4 cornerPin;
    uniform vec4 cornerPin2;
    
    vec2 applyCornerPin(vec2 pos) {
        vec2 st = vec2(pos.x * 0.5 + 0.5, pos.y * 0.5 + 0.5);
        
        vec2 tl = vec2(cornerPin.x, cornerPin.y);
        vec2 tr = vec2(cornerPin.z, cornerPin.w);
        vec2 bl = vec2(cornerPin2.x, cornerPin2.y);
        vec2 br = vec2(cornerPin2.z, cornerPin2.w);
        
        vec2 top = mix(tl, tr, st.x);
        vec2 bottom = mix(bl, br, st.x);
        vec2 final = mix(bottom, top, st.y);
        
        return final;
    }
    
    void main() {
        vec2 cornerPinned = applyCornerPin(position);
        vec4 transformedPos = transform * vec4(cornerPinned, 0.0, 1.0);
        gl_Position = transformedPos;
        vTexCoord = vec2(position.x * 0.5 + 0.5, 0.5 - position.y * 0.5);
    }
`;

const fragmentShaderSource = `
    precision mediump float;
    uniform sampler2D videoTexture;
    uniform float distortAmount;
    varying vec2 vTexCoord;
    void main() {
        vec2 center = vec2(0.5, 0.5);
        vec2 coord = vTexCoord - center;
        float distance = length(coord);
        float distortion = 1.0 + distance * distortAmount;
        vec2 distortedCoord = coord * distortion + center;
        if(distortedCoord.x < 0.0 || distortedCoord.x > 1.0 || 
           distortedCoord.y < 0.0 || distortedCoord.y > 1.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        } else {
            vec4 texColor = texture2D(videoTexture, distortedCoord);
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

// Add this function to format time in MM:SS format
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
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
    preventLoop: false
};

// Update WebGL initialization
function initWebGL() {
    gl = canvas.getContext('webgl', { 
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
        alpha: true
    });
    if (!gl) {
        alert('WebGL not supported');
        return;
    }

    // Enable alpha blending
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // Create shaders
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexShaderSource);
    gl.compileShader(vertexShader);

    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
        console.error('Vertex shader compile error:', gl.getShaderInfoLog(vertexShader));
    }

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, fragmentShaderSource);
    gl.compileShader(fragmentShader);

    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
        console.error('Fragment shader compile error:', gl.getShaderInfoLog(fragmentShader));
    }

    // Create program
    program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
    }

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

    // Create textures for main video and composites
    videoTexture = createVideoTexture();
    rectangles.forEach(rect => {
        compositeTextures.set(rect.id, createVideoTexture());
    });
    
    // Get uniform locations
    const videoTextureUniform = gl.getUniformLocation(program, 'videoTexture');
    gl.uniform1i(videoTextureUniform, 0);  // Use texture unit 0
    
    // Set initial uniforms
    updateTransform();
}

// Helper function to create a video texture
function createVideoTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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

// Update transform matrix based on controls
function updateTransform() {
    if (!gl || !program) return;

    const scale = parseFloat(scaleRange.value);
    const rotate = parseFloat(rotateRange.value) * Math.PI / 180;
    const distort = parseFloat(distortRange.value);
    const skewX = parseFloat(skewXInput.value);
    const skewY = parseFloat(skewYInput.value);
    const posX = parseFloat(posXInput.value);
    const posY = parseFloat(posYInput.value);

    // Update display values
    scaleValue.textContent = `${scale}x`;
    rotateValue.textContent = `${rotateRange.value}°`;
    distortValue.textContent = distort.toFixed(1);
    skewXValue.textContent = skewX.toFixed(2);
    skewYValue.textContent = skewY.toFixed(2);
    posXValue.textContent = posX.toFixed(2);
    posYValue.textContent = posY.toFixed(2);

    // Get base transform values
    const baseTransform = new Float32Array(transformMatrix);
    
    // Apply user transformations
    const s = Math.sin(rotate);
    const c = Math.cos(rotate);
    
    const finalMatrix = new Float32Array([
        scale * baseTransform[0] * c + skewX * s, 
        scale * baseTransform[0] * s - skewX * c,
        0, 0,
        -scale * baseTransform[5] * s + skewY * c,
        scale * baseTransform[5] * c + skewY * s,
        0, 0,
        0, 0, 1, 0,
        posX, -posY, 0, 1
    ]);

    // Update uniforms
    const transformUniform = gl.getUniformLocation(program, 'transform');
    gl.uniformMatrix4fv(transformUniform, false, finalMatrix);

    const distortUniform = gl.getUniformLocation(program, 'distortAmount');
    gl.uniform1f(distortUniform, distort);

    // Always use 3840x2160 as the base dimensions for normalization
    const baseWidth = 3840;
    const baseHeight = 2160;

    const normTLX = (cornerPoints[0].x / baseWidth) * 2 - 1;
    const normTLY = 1 - (cornerPoints[0].y / baseHeight) * 2;
    const normTRX = (cornerPoints[1].x / baseWidth) * 2 - 1;
    const normTRY = 1 - (cornerPoints[1].y / baseHeight) * 2;
    const normBLX = (cornerPoints[2].x / baseWidth) * 2 - 1;
    const normBLY = 1 - (cornerPoints[2].y / baseHeight) * 2;
    const normBRX = (cornerPoints[3].x / baseWidth) * 2 - 1;
    const normBRY = 1 - (cornerPoints[3].y / baseHeight) * 2;

    // Update corner pin uniforms with normalized coordinates
    const cornerPinUniform = gl.getUniformLocation(program, 'cornerPin');
    gl.uniform4f(cornerPinUniform, normTLX, normTLY, normTRX, normTRY);
    
    const cornerPin2Uniform = gl.getUniformLocation(program, 'cornerPin2');
    gl.uniform4f(cornerPin2Uniform, normBLX, normBLY, normBRX, normBRY);

    renderFrame();
}

// Add this function after initWebGL()
function resizeCanvasToFitVideo() {
    if (!videoPreview.videoWidth || !videoPreview.videoHeight) return;
    
    const container = canvas.parentElement;
    
    // Set fixed canvas dimensions based on 16:9 aspect ratio
    canvas.width = 912.97;
    canvas.height = 513.54;
    
    // Calculate scaling factors to fit the video into the fixed canvas
    const videoAspect = videoPreview.videoWidth / videoPreview.videoHeight;
    const canvasAspect = canvas.width / canvas.height;
    
    let scaleX = 1, scaleY = 1;
    if (videoAspect > canvasAspect) {
        // Video is wider - scale to fit width
        scaleX = 1;
        scaleY = canvasAspect / videoAspect;
    } else {
        // Video is taller - scale to fit height
        scaleX = videoAspect / canvasAspect;
        scaleY = 1;
    }
    
    // Update WebGL viewport to match canvas size
    gl.viewport(0, 0, canvas.width, canvas.height);
    
    // Calculate translation to center the video
    const translateX = (1 - scaleX) / 2;
    const translateY = (1 - scaleY) / 2;
    
    // Set base transform matrix to fit and center video
    transformMatrix = new Float32Array([
        scaleX, 0, 0, 0,
        0, scaleY, 0, 0,
        0, 0, 1, 0,
        translateX * 2, translateY * 2, 0, 1
    ]);
    
    updateTransform();
}

// Update render frame function
function renderFrame() {
    if (!gl || !videoPreview || !videoTexture) return;
    if (!videoPreview.videoWidth || !videoPreview.videoHeight) return;
    
    try {
        // Only update texture if video is actually playing and ready
        const shouldUpdateTexture = !videoPreview.paused && 
                                  videoPreview.readyState >= 3 && 
                                  !videoPreview.seeking;
        
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // First render composite clips (lower z-index)
        rectangles.forEach(rect => {
            if (rect.videoElement && 
                rect.videoElement.readyState >= 3 && 
                !rect.videoElement.seeking) {
                const texture = compositeTextures.get(rect.id);
                if (texture) {
                    const currentFrame = Math.floor(videoPreview.currentTime * 30);
                    if (currentFrame >= rect.startFrame && currentFrame <= rect.endFrame) {
                        // Set clip's video time based on main video time
                        const clipTime = (currentFrame - rect.startFrame) / 30;
                        if (Math.abs(rect.videoElement.currentTime - clipTime) > 0.1) {
                            rect.videoElement.currentTime = clipTime;
                        }

                        // Apply this rectangle's corner pin coordinates
                        const baseWidth = 3840;
                        const baseHeight = 2160;

                        const normTLX = (rect.cornerPin.topLeft.x / baseWidth) * 2 - 1;
                        const normTLY = 1 - (rect.cornerPin.topLeft.y / baseHeight) * 2;
                        const normTRX = (rect.cornerPin.topRight.x / baseWidth) * 2 - 1;
                        const normTRY = 1 - (rect.cornerPin.topRight.y / baseHeight) * 2;
                        const normBLX = (rect.cornerPin.bottomLeft.x / baseWidth) * 2 - 1;
                        const normBLY = 1 - (rect.cornerPin.bottomLeft.y / baseHeight) * 2;
                        const normBRX = (rect.cornerPin.bottomRight.x / baseWidth) * 2 - 1;
                        const normBRY = 1 - (rect.cornerPin.bottomRight.y / baseHeight) * 2;

                        // Update corner pin uniforms with normalized coordinates
                        const cornerPinUniform = gl.getUniformLocation(program, 'cornerPin');
                        gl.uniform4f(cornerPinUniform, normTLX, normTLY, normTRX, normTRY);
                        
                        const cornerPin2Uniform = gl.getUniformLocation(program, 'cornerPin2');
                        gl.uniform4f(cornerPin2Uniform, normBLX, normBLY, normBRX, normBRY);

                        // Bind and update texture only if needed
                        gl.activeTexture(gl.TEXTURE0);
                        gl.bindTexture(gl.TEXTURE_2D, texture);
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, rect.videoElement);
                        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                    }
                }
            }
        });

        // Then render main video (higher z-index)
        if (shouldUpdateTexture) {
            // Reset corner pin for main video
            const cornerPinUniform = gl.getUniformLocation(program, 'cornerPin');
            gl.uniform4f(cornerPinUniform, -1, 1, 1, 1);  // Default corners
            
            const cornerPin2Uniform = gl.getUniformLocation(program, 'cornerPin2');
            gl.uniform4f(cornerPin2Uniform, -1, -1, 1, -1);  // Default corners

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, videoTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoPreview);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
    } catch (error) {
        console.error('Error in renderFrame:', error);
    }
    
    // Use requestAnimationFrame for smoother rendering
    if (!videoPreview.paused) {
        requestAnimationFrame(renderFrame);
    }
}

// Update the video metadata loaded handler
videoPreview.addEventListener('loadedmetadata', () => {
    resizeCanvasToFitVideo();
    // Update duration display
    durationSpan.textContent = formatTime(videoPreview.duration);
    createTimelineGrid();
});

// Update the timeupdate event listener
videoPreview.addEventListener('timeupdate', () => {
    if (videoPreview.paused) {
        updatePlayhead();
    }
    // Update current time display
    currentTimeSpan.textContent = formatTime(videoPreview.currentTime);
});

// Update the timeline click handler
timelineLine.addEventListener('click', (e) => {
    const rect = timelineLine.getBoundingClientRect();
    const clickPosition = e.clientX - rect.left;
    const progress = clickPosition / rect.width;
    videoPreview.currentTime = progress * videoPreview.duration;
    currentTimeSpan.textContent = formatTime(videoPreview.currentTime);
});

// Add window resize handler
window.addEventListener('resize', () => {
    resizeCanvasToFitVideo();
    if (videoPreview.duration) {
        createTimelineGrid();
    }
});

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

// Update export function to prevent interference
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
        
        // Reset video position
        await new Promise(resolve => {
            const onSeeked = () => {
                videoPreview.removeEventListener('seeked', onSeeked);
                resolve();
            };
            videoPreview.addEventListener('seeked', onSeeked);
            videoPreview.currentTime = 0;
        });

        console.log('Starting frame capture...');
        
        // Capture frames with improved state handling
        for (let i = 0; i < totalFrames; i++) {
            try {
                // Use a more reliable seeking method
                await new Promise((resolve, reject) => {
                    const targetTime = i / frameRate;
                    
                    const onSeeked = () => {
                        try {
                            // Ensure we're at the right frame
                            if (Math.abs(videoPreview.currentTime - targetTime) > 0.01) {
                                videoPreview.currentTime = targetTime;
                                return; // Will trigger another 'seeked' event
                            }
                            
                            videoPreview.removeEventListener('seeked', onSeeked);
                            
                            // Wait for the next animation frame to ensure texture is updated
                            requestAnimationFrame(() => {
                                // Apply current transformation
                                updateTransform();
                                
                                // Ensure WebGL state is correct
                                gl.viewport(0, 0, canvas.width, canvas.height);
                                gl.bindTexture(gl.TEXTURE_2D, videoTexture);
                                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoPreview);
                                gl.clear(gl.COLOR_BUFFER_BIT);
                                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

                                // Capture the transformed frame
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

        // Clear any existing files
        const files = await ffmpeg.listFiles('/');
        for (const file of files) {
            await ffmpeg.deleteFile(file.name);
        }

        // Write frames to FFmpeg
        console.log('Writing frames to FFmpeg...');
        for (let i = 0; i < frames.length; i++) {
            const frameData = await frames[i].arrayBuffer();
            const frameName = `frame${i.toString().padStart(6, '0')}.png`;
            await ffmpeg.writeFile(frameName, new Uint8Array(frameData));
            progressBarFill.style.width = `${50 + (i / frames.length) * 25}%`;
        }

        // Combine frames into WebM video with alpha support
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

        // Download the video
        console.log('Preparing download...');
        const data = await ffmpeg.readFile('output.webm');
        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/webm' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'transformed_video.webm';
        a.click();

        // Cleanup
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
        // Restore original playback state
        videoPreview.currentTime = originalTime;
        videoPreview.loop = originalLoop;
        if (wasPlaying && videoMetadata.format === 'webm') {
            // For WebM, ensure we have enough buffer before resuming
            const buffered = videoPreview.buffered;
            if (buffered.length > 0 && buffered.end(0) >= originalTime + 1) {
                try {
                    await videoPreview.play();
                } catch (e) {
                    console.error('Failed to restore WebM playback:', e);
                }
            } else {
                console.log('Waiting for buffer before resuming WebM playback...');
                // Wait for sufficient buffer
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

// Add WebM optimization utilities after FFmpeg initialization
const CHUNK_DURATION = 3; // Duration of each chunk in seconds
const BUFFER_AHEAD = 2; // Number of chunks to buffer ahead

class WebMHandler {
    constructor() {
        this.chunks = new Map(); // Store video chunks
        this.activeChunks = new Set(); // Currently loaded chunks
        this.isLoading = false;
        this.mediaSource = null;
        this.sourceBuffer = null;
    }

    async initializeMediaSource(videoElement, blob) {
        this.mediaSource = new MediaSource();
        videoElement.src = URL.createObjectURL(this.mediaSource);

        await new Promise(resolve => {
            this.mediaSource.addEventListener('sourceopen', () => {
                // Use webm MIME type with codecs
                const mimeType = 'video/webm; codecs="vp8,vorbis"';
                this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
                this.sourceBuffer.mode = 'sequence';
                resolve();
            }, { once: true });
        });

        // Start loading initial chunks
        await this.loadChunks(blob, 0);
    }

    async loadChunks(blob, startTime) {
        if (this.isLoading) return;
        this.isLoading = true;

        try {
            const reader = new FileReader();
            const chunkSize = 1024 * 1024; // 1MB chunks
            let offset = 0;

            while (offset < blob.size) {
                const chunk = blob.slice(offset, offset + chunkSize);
                const buffer = await new Promise((resolve, reject) => {
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsArrayBuffer(chunk);
                });

                if (!this.sourceBuffer.updating) {
                    this.sourceBuffer.appendBuffer(buffer);
                    await new Promise(resolve => {
                        this.sourceBuffer.addEventListener('updateend', resolve, { once: true });
                    });
                }

                offset += chunkSize;
            }

            // Mark loading complete
            this.mediaSource.endOfStream();
        } catch (error) {
            console.error('Error loading WebM chunks:', error);
        } finally {
            this.isLoading = false;
        }
    }

    async seekTo(time) {
        const chunkIndex = Math.floor(time / CHUNK_DURATION);
        if (!this.chunks.has(chunkIndex)) {
            // Load the required chunk and its neighbors
            const startChunk = Math.max(0, chunkIndex - 1);
            const endChunk = chunkIndex + BUFFER_AHEAD;
            await this.loadChunksRange(startChunk, endChunk);
        }
    }

    async loadChunksRange(startChunk, endChunk) {
        // Remove chunks that are too far from current playback
        for (const loadedChunk of this.activeChunks) {
            if (loadedChunk < startChunk - 1 || loadedChunk > endChunk + 1) {
                this.activeChunks.delete(loadedChunk);
            }
        }

        // Load new chunks
        for (let i = startChunk; i <= endChunk; i++) {
            if (!this.activeChunks.has(i)) {
                this.activeChunks.add(i);
            }
        }
    }
}

// Add WebM handler to video input handler
videoInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        const isWebM = file.type === 'video/webm';
        videoMetadata.format = isWebM ? 'webm' : 'h264';
        
        try {
            if (isWebM) {
                console.log('Loading WebM video with optimized chunking');
                const webmHandler = new WebMHandler();
                await webmHandler.initializeMediaSource(videoPreview, file);
                
                // Add enhanced WebM event listeners
                videoPreview.addEventListener('seeking', async () => {
                    await webmHandler.seekTo(videoPreview.currentTime);
                });

                videoPreview.addEventListener('timeupdate', () => {
                    const currentChunk = Math.floor(videoPreview.currentTime / CHUNK_DURATION);
                    const bufferedAhead = videoPreview.buffered.end(0) - videoPreview.currentTime;
                    
                    // Preload next chunks if buffer is running low
                    if (bufferedAhead < CHUNK_DURATION * 2) {
                        webmHandler.loadChunksRange(
                            currentChunk,
                            currentChunk + BUFFER_AHEAD
                        );
                    }
                });
            }

            await new Promise((resolve, reject) => {
                videoPreview.src = url;
                videoPreview.crossOrigin = 'anonymous';
                videoPreview.muted = true;
                videoPreview.playsInline = true;
                videoPreview.preload = 'auto';
                
                // Reset metadata
                videoMetadata = {
                    ...videoMetadata,
                    duration: 0,
                    keyframeIntervals: [],
                    lastBufferCheck: 0,
                    isPlaying: false,
                    hasAttemptedPlay: false,
                    lastTimeUpdate: 0,
                    unexpectedLoops: 0,
                    preventLoop: false
                };

                if (isWebM) {
                    console.log('Loading WebM video with alpha');
                    videoPreview.autoplay = false;
                    
                    // Enhanced buffering progress monitoring
                    const updateBufferProgress = () => {
                        if (videoPreview.buffered.length > 0) {
                            const now = Date.now();
                            const bufferedEnd = videoPreview.buffered.end(0);
                            const duration = videoPreview.duration;
                            const currentTime = videoPreview.currentTime;
                            
                            // Log detailed buffer state
                            console.log(`
                                Buffer State:
                                - Current Time: ${currentTime.toFixed(2)}s
                                - Buffered End: ${bufferedEnd.toFixed(2)}s
                                - Duration: ${duration.toFixed(2)}s
                                - Buffer %: ${(bufferedEnd/duration*100).toFixed(1)}%
                                - Playing: ${!videoPreview.paused}
                                - Ready State: ${videoPreview.readyState}
                                - Network State: ${videoPreview.networkState}
                                - Prevent Loop: ${videoMetadata.preventLoop}
                            `);
                        }
                    };
                    
                    videoPreview.addEventListener('timeupdate', () => {
                        const currentTime = videoPreview.currentTime;
                        const duration = videoPreview.duration;
                        const buffered = videoPreview.buffered;
                        
                        // Detect unexpected time jumps
                        if (videoMetadata.lastTimeUpdate > 0 && 
                            currentTime < videoMetadata.lastTimeUpdate && 
                            videoMetadata.lastTimeUpdate < duration - 0.1) {
                            console.log('Detected unexpected time jump back:', 
                                      videoMetadata.lastTimeUpdate, '->', currentTime);
                            videoMetadata.unexpectedLoops++;
                            
                            // If we detect an unexpected loop, try to restore the position
                            if (!videoMetadata.preventLoop) {
                                videoMetadata.preventLoop = true;
                                videoPreview.currentTime = videoMetadata.lastTimeUpdate;
                            }
                        }
                        
                        // Update last time for next comparison
                        videoMetadata.lastTimeUpdate = currentTime;
                        
                        // Check if we're near the end
                        if (currentTime >= duration - 0.1) {
                            videoPreview.pause();
                            videoMetadata.isPlaying = false;
                            playPauseBtn.textContent = '▶';
                        }
                        
                        console.log(`
                            Playback State:
                            - Time: ${currentTime.toFixed(2)}s
                            - Duration: ${duration.toFixed(2)}s
                            - Playing: ${!videoPreview.paused}
                            - Unexpected Loops: ${videoMetadata.unexpectedLoops}
                            - Prevent Loop: ${videoMetadata.preventLoop}
                        `);
                    });

                    // Handle seeking
                    videoPreview.addEventListener('seeking', () => {
                        console.log('Seeking to:', videoPreview.currentTime);
                    });

                    videoPreview.addEventListener('seeked', () => {
                        console.log('Seeked to:', videoPreview.currentTime);
                        // Reset loop prevention if user manually seeks
                        if (videoMetadata.preventLoop) {
                            videoMetadata.preventLoop = false;
                        }
                    });
                }

                videoPreview.onerror = (e) => {
                    console.error('Video error:', e);
                    console.error('Error code:', videoPreview.error.code);
                    console.error('Error message:', videoPreview.error.message);
                    reject(new Error(`Video loading error: ${videoPreview.error.message}`));
                };

                videoPreview.onloadedmetadata = async () => {
                    console.log('Video metadata loaded');
                    videoMetadata.duration = videoPreview.duration;
                    console.log(`
                        Video Metadata:
                        - Duration: ${videoPreview.duration}s
                        - Size: ${videoPreview.videoWidth}x${videoPreview.videoHeight}
                        - Format: ${videoMetadata.format}
                        - Default Playback Rate: ${videoPreview.defaultPlaybackRate}
                    `);
                    
                    // For WebM, wait for initial buffering
                    if (isWebM) {
                        await new Promise(resolve => {
                            const checkBuffer = () => {
                                if (videoPreview.buffered.length > 0) {
                                    const bufferedEnd = videoPreview.buffered.end(0);
                                    const duration = videoPreview.duration;
                                    
                                    // Wait for at least 1 second of buffering or full video
                                    if (bufferedEnd >= Math.min(1, duration)) {
                                        resolve();
                                        return;
                                    }
                                }
                                setTimeout(checkBuffer, 100);
                            };
                            checkBuffer();
                        });
                    }

                    // Hide dropzone and show canvas
                    dropZone.style.display = 'none';
                    videoPreview.style.display = 'none';
                    canvas.style.display = 'block';
                    
                    // Initialize video
                    resizeCanvasToFitVideo();

                    // Start playback
                    try {
                        videoMetadata.isPlaying = true;
                        await videoPreview.play();
                        playPauseBtn.textContent = '⏸';
                        requestAnimationFrame(renderFrame);
                    } catch (e) {
                        console.error('Playback failed:', e);
                        videoMetadata.isPlaying = false;
                    }
                    resolve();
                };
            });
        } catch (error) {
            console.error('Error during video setup:', error);
            alert('Error loading video. Please try again.');
        }
    }
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
        dropZone.style.display = 'none'; // Hide drop zone
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
            await videoPreview.play();
            playPauseBtn.textContent = '⏸';
            requestAnimationFrame(renderFrame); // Restart render loop
        } else {
            videoPreview.pause();
            playPauseBtn.textContent = '▶';
        }
    } catch (error) {
        console.error('Play/Pause error:', error);
    }
});

// Add better video state handling
videoPreview.addEventListener('play', () => {
    requestAnimationFrame(renderFrame);
});

videoPreview.addEventListener('pause', () => {
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

// Update TimelineRectangle class
class TimelineRectangle {
    constructor(id) {
        this.id = id;
        this.zIndex = 1; // Default z-index for composite clips
        this.startFrame = 0;
        this.endFrame = 30;
        this.videoSource = null; // Store video source
        this.videoElement = null; // Store video element
        this.cornerPin = {
            topLeft: { x: 0, y: 0 },
            topRight: { x: 1, y: 0 },
            bottomLeft: { x: 0, y: 1 },
            bottomRight: { x: 1, y: 1 }
        };
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

// Timeline state
const rectangles = [
    new TimelineRectangle(1),
    new TimelineRectangle(2),
    new TimelineRectangle(3),
    new TimelineRectangle(4),
    new TimelineRectangle(5)
];

// Initialize rectangles with z-indices and positions
rectangles[0].zIndex = 1;
rectangles[1].zIndex = 2;  // New marker with higher z-index
rectangles[2].zIndex = 1;
rectangles[3].zIndex = 1;
rectangles[4].zIndex = 1;

// Set corner pin coordinates for each rectangle
// Rectangle 1
rectangles[0].cornerPin = {
    topLeft: { x: 1974, y: -172 },
    topRight: { x: 3912, y: 1268 },
    bottomLeft: { x: 1944, y: 2424 },
    bottomRight: { x: 4036, y: 2464 }
};

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
    marker.dataset.id = rectangle.id;
    
    const timelineWidth = 742.74;
    const totalFrames = Math.floor(videoPreview.duration * 30);
    const frameWidth = timelineWidth / totalFrames;
    
    // Position based on start frame (horizontal)
    marker.style.left = `${rectangle.startFrame * frameWidth}px`;
    marker.style.width = `${(rectangle.endFrame - rectangle.startFrame) * frameWidth}px`;
    
    // Set both z-index for stacking and vertical position
    marker.style.zIndex = rectangle.zIndex;  // Visual stacking
    const baseOffset = 0;  // Base vertical position
    const verticalSpacing = 70;  // Space between rows
    marker.style.top = `${baseOffset - (rectangle.zIndex - 1) * verticalSpacing}px`;  // Grid position

    // Add video selection button
    const selectButton = document.createElement('button');
    selectButton.className = 'select-video-btn';
    selectButton.textContent = rectangle.videoSource ? '🎥' : '➕';
    selectButton.title = rectangle.videoSource ? 'Change Video' : 'Add Video';
    
    // Add video input
    const compositeVideoInput = document.createElement('input');
    compositeVideoInput.type = 'file';
    compositeVideoInput.accept = 'video/*';
    compositeVideoInput.style.display = 'none';
    
    // Handle video selection for composite clips
    compositeVideoInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            const url = URL.createObjectURL(file);
            const isWebM = file.type === 'video/webm';
            
            // Create and set up video element for this clip
            const video = document.createElement('video');
            video.src = url;
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.loop = true;
            video.crossOrigin = 'anonymous';
            
            try {
                // Wait for video metadata to load
                await new Promise((resolve) => {
                    video.onloadedmetadata = resolve;
                });

                // For WebM, ensure proper buffering
                if (isWebM) {
                    await new Promise(resolve => {
                        const checkBuffer = () => {
                            if (video.buffered.length > 0) {
                                const bufferedEnd = video.buffered.end(0);
                                if (bufferedEnd >= video.duration) {
                                    resolve();
                                    return;
                                }
                            }
                            setTimeout(checkBuffer, 100);
                        };
                        checkBuffer();
                    });

                    // Ensure we start from the beginning
                    video.currentTime = 0;
                    await new Promise(resolve => {
                        video.onseeked = resolve;
                    });
                }
                
                // Update rectangle data
                rectangle.videoSource = url;
                rectangle.videoElement = video;
                rectangle.isWebM = isWebM;
                
                // Start playing the video
                await video.play();
                
                // Update button appearance
                selectButton.textContent = '🎥';
                selectButton.title = 'Change Video';
                
                // Add video thumbnail
                const canvas = document.createElement('canvas');
                canvas.width = 50;
                canvas.height = 50;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, 50, 50);
                marker.style.backgroundImage = `url(${canvas.toDataURL()})`;
                marker.classList.add('has-video');
            } catch (error) {
                console.error('Error setting up composite video:', error);
            }
        }
    });
    
    // Add resize handles
    const leftHandle = document.createElement('div');
    leftHandle.className = 'resize-handle left';
    const rightHandle = document.createElement('div');
    rightHandle.className = 'resize-handle right';
    
    selectButton.addEventListener('click', () => {
        compositeVideoInput.click();
    });
    
    marker.appendChild(selectButton);
    marker.appendChild(compositeVideoInput);
    marker.appendChild(leftHandle);
    marker.appendChild(rightHandle);
    thumbnailMarkers.appendChild(marker);

    // Mouse down handler for dragging
    marker.addEventListener('mousedown', (e) => {
        if (e.target === selectButton || e.target === compositeVideoInput) {
            return; // Don't start drag on button click
        }
        
        if (e.target.classList.contains('resize-handle')) {
            isResizing = true;
            resizeEdge = e.target.classList.contains('left') ? 'left' : 'right';
            currentMarker = marker;
            startX = e.clientX;
            e.stopPropagation();
        } else {
            isDragging = true;
            currentMarker = marker;
            startX = e.clientX;
            markerStartLeft = parseFloat(marker.style.left);
        }
        marker.classList.add('dragging');
    });
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