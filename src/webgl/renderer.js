// WebGL Renderer Module
import { vertexShaderSource, fragmentShaderSource } from './shaders.js';

class WebGLRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = null;
        this.program = null;
        this.videoTexture = null;
        this.lumaTexture = null;
        this.compositeTextures = new Map();
        this.mainVideoElement = null;
        this.maxTextureUnits = null;
        this.textureUnitMap = new Map();
        this.currentViewport = { width: 0, height: 0 };
        this.init();
    }

    init() {
        this.gl = this.canvas.getContext('webgl', {
            alpha: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
            antialias: true,
            powerPreference: 'high-performance'
        });

        if (!this.gl) {
            throw new Error('WebGL not supported');
        }

        // Get max texture units and reserve first two for main video and luma
        this.maxTextureUnits = this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS);
        console.log('Max texture units:', this.maxTextureUnits);

        // Configure WebGL context
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);

        // Create shader program
        this.program = this.createShaderProgram();
        this.gl.useProgram(this.program);

        // Set up vertex buffer
        this.setupVertexBuffer();

        // Create default textures
        this.videoTexture = this.createVideoTexture();
        this.lumaTexture = this.createVideoTexture();
    }

    createShaderProgram() {
        const vertexShader = this.createShader(this.gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this.createShader(this.gl.FRAGMENT_SHADER, fragmentShaderSource);

        const program = this.gl.createProgram();
        this.gl.attachShader(program, vertexShader);
        this.gl.attachShader(program, fragmentShader);
        this.gl.linkProgram(program);

        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
            throw new Error('Shader program link error: ' + this.gl.getProgramInfoLog(program));
        }

        return program;
    }

    createShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);

        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            throw new Error(`Shader compile error: ${this.gl.getShaderInfoLog(shader)}`);
        }

        return shader;
    }

    setupVertexBuffer() {
        const vertices = new Float32Array([
            -1, -1,  // bottom left
            1, -1,   // bottom right
            -1, 1,   // top left
            1, 1     // top right
        ]);

        const vertexBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vertexBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);

        const positionAttribute = this.gl.getAttribLocation(this.program, 'position');
        this.gl.enableVertexAttribArray(positionAttribute);
        this.gl.vertexAttribPointer(positionAttribute, 2, this.gl.FLOAT, false, 0, 0);
    }

    createVideoTexture() {
        const texture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
        
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);

        // Initialize with a 1x1 transparent pixel
        this.gl.texImage2D(
            this.gl.TEXTURE_2D,
            0,
            this.gl.RGBA,
            1, 1,
            0,
            this.gl.RGBA,
            this.gl.UNSIGNED_BYTE,
            new Uint8Array([0, 0, 0, 0])
        );

        return texture;
    }

    resize(width, height) {
        if (this.currentViewport.width === width && this.currentViewport.height === height) {
            return; // Skip if dimensions haven't changed
        }

        this.canvas.width = width;
        this.canvas.height = height;
        this.currentViewport = { width, height };
        this.gl.viewport(0, 0, width, height);

        // Update transform to maintain aspect ratio
        if (this.mainVideoElement) {
            const videoAspect = this.mainVideoElement.videoWidth / this.mainVideoElement.videoHeight;
            const canvasAspect = width / height;
            
            let scaleX = 1;
            let scaleY = 1;
            
            if (videoAspect > canvasAspect) {
                // Video is wider than canvas
                scaleY = canvasAspect / videoAspect;
            } else {
                // Video is taller than canvas
                scaleX = videoAspect / canvasAspect;
            }

            // Update default transform
            this.defaultTransform = new Float32Array([
                scaleX, 0, 0, 0,
                0, scaleY, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ]);
        }
    }

    async initializeWithVideo(videoElement) {
        this.mainVideoElement = videoElement;
        
        // Wait for video metadata if not already loaded
        if (videoElement.readyState < 2) {
            await new Promise(resolve => {
                videoElement.addEventListener('loadeddata', resolve, { once: true });
            });
        }

        // Create main video texture if needed
        if (!this.videoTexture) {
            this.videoTexture = this.createVideoTexture();
        }

        // Set up viewport based on video dimensions
        const containerWidth = this.canvas.clientWidth;
        const containerHeight = this.canvas.clientHeight;
        this.resize(containerWidth, containerHeight);

        // Set initial uniforms
        this.gl.useProgram(this.program);
        const videoTextureLocation = this.gl.getUniformLocation(this.program, 'videoTexture');
        const lumaTextureLocation = this.gl.getUniformLocation(this.program, 'lumaTexture');
        
        this.gl.uniform1i(videoTextureLocation, 0);
        this.gl.uniform1i(lumaTextureLocation, 1);

        // Force initial texture update
        this.updateVideoTexture(this.mainVideoElement, this.videoTexture);
    }

    updateVideoTexture(videoElementOrLayer, texture) {
        const videoElement = videoElementOrLayer.videoElement || videoElementOrLayer;
        const targetTexture = texture || this.videoTexture;

        if (!videoElement || videoElement.readyState < 2) {
            console.warn('Video not ready for texture update');
            return;
        }

        const gl = this.gl;
        
        let textureUnit = 0;
        
        if (videoElementOrLayer.id) {
            if (!this.textureUnitMap.has(videoElementOrLayer.id)) {
                const nextUnit = 2 + this.textureUnitMap.size;
                if (nextUnit >= this.maxTextureUnits) {
                    console.error('No available texture units for layer:', videoElementOrLayer.id);
                    return;
                }
                this.textureUnitMap.set(videoElementOrLayer.id, nextUnit);
            }
            textureUnit = this.textureUnitMap.get(videoElementOrLayer.id);
        }

        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(gl.TEXTURE_2D, targetTexture);
        
        try {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                videoElement
            );
        } catch (error) {
            console.error('Error updating video texture:', error, videoElement);
        }
    }

    render(scene) {
        if (!this.gl || !this.program) {
            console.warn('WebGL context or program not initialized');
            return;
        }

        // Clear the canvas
        this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        // Use shader program
        this.gl.useProgram(this.program);

        // Update viewport if needed
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        if (width !== this.currentViewport.width || height !== this.currentViewport.height) {
            this.resize(width, height);
        }

        // Sort layers by z-index
        const layers = scene.layers.sort((a, b) => a.zIndex - b.zIndex);

        // Render each layer
        layers.forEach(layer => {
            try {
                if (!layer.videoElement || layer.videoElement.readyState < 2) return;

                // Bind appropriate texture
                this.gl.activeTexture(this.gl.TEXTURE0);
                if (layer.isMainTrack) {
                    this.gl.bindTexture(this.gl.TEXTURE_2D, this.videoTexture);
                    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, layer.videoElement);
                } else {
                    const texture = this.compositeTextures.get(layer.id);
                    if (texture) {
                        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
                        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, layer.videoElement);
                    }
                }

                // Update layer-specific uniforms (transform, corner pin, etc.)
                this.updateLayerUniforms(layer);

                // Draw the layer
                this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
            } catch (error) {
                console.error('Error rendering layer:', error, layer);
            }
        });
    }

    updateLayerUniforms(layer) {
        const gl = this.gl;

        // Set transform matrix
        const transformUniform = gl.getUniformLocation(this.program, 'transform');
        gl.uniformMatrix4fv(transformUniform, false, layer.transform || new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]));

        // Set corner pin uniforms if available
        if (layer.hasCornerPin && layer.cornerPin) {
            const cornerPinUniform = gl.getUniformLocation(this.program, 'cornerPin');
            const cornerPin2Uniform = gl.getUniformLocation(this.program, 'cornerPin2');
            
            gl.uniform4f(cornerPinUniform,
                layer.cornerPin.topLeft.x, layer.cornerPin.topLeft.y,
                layer.cornerPin.topRight.x, layer.cornerPin.topRight.y
            );
            
            gl.uniform4f(cornerPin2Uniform,
                layer.cornerPin.bottomLeft.x, layer.cornerPin.bottomLeft.y,
                layer.cornerPin.bottomRight.x, layer.cornerPin.bottomRight.y
            );
        }

        // Set texture uniforms
        const videoTextureUniform = gl.getUniformLocation(this.program, 'videoTexture');
        const lumaTextureUniform = gl.getUniformLocation(this.program, 'lumaTexture');
        const useLumaMatteUniform = gl.getUniformLocation(this.program, 'useLumaMatte');

        gl.uniform1i(videoTextureUniform, 0);
        gl.uniform1i(lumaTextureUniform, 1);
        gl.uniform1f(useLumaMatteUniform, layer.lumaMatte ? 1.0 : 0.0);
    }

    destroy() {
        // Clean up WebGL resources
        if (this.gl) {
            this.gl.deleteTexture(this.videoTexture);
            this.gl.deleteTexture(this.lumaTexture);
            this.compositeTextures.forEach(texture => this.gl.deleteTexture(texture));
            this.gl.deleteProgram(this.program);
        }
    }
}

export default WebGLRenderer; 