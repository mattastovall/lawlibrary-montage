// WebGL Shader Sources
export const vertexShaderSource = `
    attribute vec2 position;
    varying vec2 vTexCoord;
    uniform mat4 transform;
    uniform vec4 cornerPin;
    uniform vec4 cornerPin2;
    
    void main() {
        // Apply transformation matrix first
        vec4 transformedPosition = transform * vec4(position, 0.0, 1.0);
        gl_Position = transformedPosition;
        
        // Calculate texture coordinates
        float x = position.x * 0.5 + 0.5;
        float y = position.y * 0.5 + 0.5;  // Remove the flip
        
        // Apply corner pin transformation if enabled
        if (cornerPin.x != 0.0 || cornerPin.y != 0.0 || 
            cornerPin.z != 1.0 || cornerPin.w != 0.0 ||
            cornerPin2.x != 0.0 || cornerPin2.y != 1.0 || 
            cornerPin2.z != 1.0 || cornerPin2.w != 1.0) {
            
            // Bilinear interpolation for corner pin
            vec2 topPoint = mix(
                vec2(cornerPin.x, cornerPin.y),
                vec2(cornerPin.z, cornerPin.w),
                x
            );
            
            vec2 bottomPoint = mix(
                vec2(cornerPin2.x, cornerPin2.y),
                vec2(cornerPin2.z, cornerPin2.w),
                x
            );
            
            vTexCoord = mix(topPoint, bottomPoint, y);
        } else {
            vTexCoord = vec2(x, y);
        }
    }
`;

export const fragmentShaderSource = `
    precision highp float;
    uniform sampler2D videoTexture;
    uniform sampler2D lumaTexture;
    uniform float useLumaMatte;
    varying vec2 vTexCoord;

    // Improved luminance calculation
    float getLuminance(vec3 color) {
        return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
        // Sample main video texture with proper texture coordinates
        vec2 texCoord = vTexCoord;
        vec4 texColor = texture2D(videoTexture, texCoord);
        
        if (useLumaMatte > 0.5) {
            // Sample and process luma matte
            vec4 lumaColor = texture2D(lumaTexture, texCoord);
            float alpha = getLuminance(lumaColor.rgb);
            
            // Apply luma matte
            gl_FragColor = vec4(texColor.rgb, alpha * texColor.a);
        } else {
            // Pass through original video color
            gl_FragColor = texColor;
        }
    }
`; 