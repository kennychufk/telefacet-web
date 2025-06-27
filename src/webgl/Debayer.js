// src/webgl/Debayer.js - Fixed version with proper 10-bit unpacking and RGGB pattern

// Vertex shader - shared by all quality levels
export const vertexShaderSource = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
`

// Fragment shader for quality (bilinear) debayering with fixed unpacking - RGGB pattern
export const fragmentShaderQuality = `
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform vec2 u_textureSize;
uniform float u_bytesPerLine;
uniform vec3 u_awbGains;
varying vec2 v_texCoord;

float unpack10bit(vec2 imageCoord) {
    float x = floor(imageCoord.x);
    float y = floor(imageCoord.y);
    
    if (x >= u_textureSize.x || y >= u_textureSize.y || x < 0.0 || y < 0.0) {
        return 0.0;
    }
    
    // Calculate which group of 4 pixels this pixel belongs to
    float groupIdx = floor(x / 4.0);
    int pixelInGroup = int(mod(x, 4.0));
    
    // Calculate byte positions in linear array
    float rowStart = y * u_bytesPerLine;
    float groupStart = groupIdx * 5.0;
    
    // Calculate the 5 byte positions for this group
    float bytePos[5];
    bytePos[0] = rowStart + groupStart;
    bytePos[1] = rowStart + groupStart + 1.0;
    bytePos[2] = rowStart + groupStart + 2.0;
    bytePos[3] = rowStart + groupStart + 3.0;
    bytePos[4] = rowStart + groupStart + 4.0;
    
    // Sample the 5 bytes
    // CRITICAL: Add 0.5 to sample at pixel centers
    float bytes[5];
    for (int i = 0; i < 5; i++) {
        float col = mod(bytePos[i], u_bytesPerLine);
        float row = floor(bytePos[i] / u_bytesPerLine);
        vec2 texCoord = vec2((col + 0.5) / u_bytesPerLine, (row + 0.5) / u_textureSize.y);
        bytes[i] = texture2D(u_texture, texCoord).r * 255.0;
    }
    
    // Unpack based on pixel position in group
    float value10bit;
    if (pixelInGroup == 0) {
        // Pixel 0: bytes[0] has upper 8 bits, bytes[4] bits [7:6] have lower 2 bits
        value10bit = bytes[0] * 4.0 + floor(bytes[4] / 64.0);
    } else if (pixelInGroup == 1) {
        // Pixel 1: bytes[1] has upper 8 bits, bytes[4] bits [5:4] have lower 2 bits  
        value10bit = bytes[1] * 4.0 + floor(mod(bytes[4], 64.0) / 16.0);
    } else if (pixelInGroup == 2) {
        // Pixel 2: bytes[2] has upper 8 bits, bytes[4] bits [3:2] have lower 2 bits
        value10bit = bytes[2] * 4.0 + floor(mod(bytes[4], 16.0) / 4.0);
    } else {
        // Pixel 3: bytes[3] has upper 8 bits, bytes[4] bits [1:0] have lower 2 bits
        value10bit = bytes[3] * 4.0 + mod(bytes[4], 4.0);
    }
    
    return value10bit / 1023.0;
}

// Sample a pixel at given coordinates
float sampleAt(vec2 coord) {
    return unpack10bit(coord);
}

void main() {
    vec2 imageCoord = v_texCoord * u_textureSize;
    vec2 pixelCoord = floor(imageCoord);
    
    // Determine Bayer pattern position (RGGB)
    vec2 alternate = mod(pixelCoord, 2.0);
    
    float C = sampleAt(pixelCoord);
    
    // Sample neighbors
    float N = sampleAt(pixelCoord + vec2(0.0, -1.0));
    float S = sampleAt(pixelCoord + vec2(0.0, 1.0));
    float E = sampleAt(pixelCoord + vec2(1.0, 0.0));
    float W = sampleAt(pixelCoord + vec2(-1.0, 0.0));
    float NE = sampleAt(pixelCoord + vec2(1.0, -1.0));
    float NW = sampleAt(pixelCoord + vec2(-1.0, -1.0));
    float SE = sampleAt(pixelCoord + vec2(1.0, 1.0));
    float SW = sampleAt(pixelCoord + vec2(-1.0, 1.0));
    
    vec3 color;
    
    if (alternate.y < 0.5) {
        if (alternate.x < 0.5) {
            // Red pixel at (0,0)
            float red = C;
            float green = (N + S + E + W) * 0.25;
            float blue = (NW + NE + SW + SE) * 0.25;
            color = vec3(red, green, blue);
        } else {
            // Green pixel in red row at (1,0)
            float red = (W + E) * 0.5;
            float green = C;
            float blue = (N + S) * 0.5;
            color = vec3(red, green, blue);
        }
    } else {
        if (alternate.x < 0.5) {
            // Green pixel in blue row at (0,1)
            float red = (N + S) * 0.5;
            float green = C;
            float blue = (W + E) * 0.5;
            color = vec3(red, green, blue);
        } else {
            // Blue pixel at (1,1)
            float red = (NW + NE + SW + SE) * 0.25;
            float green = (N + S + E + W) * 0.25;
            float blue = C;
            color = vec3(red, green, blue);
        }
    }
    
    // Apply AWB gains
    color *= u_awbGains;
    
    gl_FragColor = vec4(color, 1.0);
}
`

export class Debayer {
    constructor(canvas, quality = 'quality') {
        this.canvas = canvas
        this.gl = canvas.getContext('webgl', {
            preserveDrawingBuffer: false,
            antialias: false,
            depth: false,
            stencil: false,
            alpha: false
        })
        
        if (!this.gl) {
            throw new Error('WebGL not supported')
        }
        
        this.quality = quality
        this.program = null
        this.texture = null
        this.framebuffer = null
        this.width = 0
        this.height = 0
        this.awbGains = { r: 1.0, g: 1.0, b: 1.0 }
        
        this.initializeWebGL()
    }
    
    initializeWebGL() {
        const gl = this.gl
        
        // Create and compile shaders
        const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexShaderSource)
        const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, this.getFragmentShader())
        
        // Create program
        this.program = gl.createProgram()
        gl.attachShader(this.program, vertexShader)
        gl.attachShader(this.program, fragmentShader)
        gl.linkProgram(this.program)
        
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            throw new Error('Failed to link shader program: ' + gl.getProgramInfoLog(this.program))
        }
        
        // Get attribute and uniform locations
        this.locations = {
            aPosition: gl.getAttribLocation(this.program, 'a_position'),
            aTexCoord: gl.getAttribLocation(this.program, 'a_texCoord'),
            uTexture: gl.getUniformLocation(this.program, 'u_texture'),
            uTextureSize: gl.getUniformLocation(this.program, 'u_textureSize'),
            uBytesPerLine: gl.getUniformLocation(this.program, 'u_bytesPerLine'),
            uAwbGains: gl.getUniformLocation(this.program, 'u_awbGains')
        }
        
        // Create vertex buffer
        const vertices = new Float32Array([
            -1, -1,  0, 1,  // bottom left
             1, -1,  1, 1,  // bottom right
            -1,  1,  0, 0,  // top left
             1,  1,  1, 0   // top right
        ])
        
        this.vertexBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
        
        // Create texture
        this.texture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, this.texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        
        // Set pixel store parameter for byte-aligned data
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    }
    
    createShader(type, source) {
        const gl = this.gl
        const shader = gl.createShader(type)
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error('Failed to compile shader: ' + gl.getShaderInfoLog(shader))
        }
        
        return shader
    }
    
    getFragmentShader() {
        switch (this.quality) {
            default:
                return fragmentShaderQuality
        }
    }
    
    setQuality(quality) {
        if (quality !== this.quality) {
            this.quality = quality
            // Recreate program with new fragment shader
            this.initializeWebGL()
        }
    }
    
    setAWBGains(gains) {
        this.awbGains = gains
    }
    
    processFrame(frameData, width, height, bytesPerLine) {
        const gl = this.gl
        
        // Update canvas size if needed
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width
            this.canvas.height = height
            gl.viewport(0, 0, width, height)
        }
        
        // Use program
        gl.useProgram(this.program)
        
        // Update texture with frame data
        gl.bindTexture(gl.TEXTURE_2D, this.texture)
        
        // Upload texture with bytesPerLine as width
        // IMPORTANT: Make sure pixel unpack alignment is set to 1
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE,
            bytesPerLine,
            height,
            0,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            frameData
        )
        
        // Set uniforms
        gl.uniform1i(this.locations.uTexture, 0)
        gl.uniform2f(this.locations.uTextureSize, width, height)
        gl.uniform1f(this.locations.uBytesPerLine, bytesPerLine)
        gl.uniform3f(this.locations.uAwbGains, this.awbGains.r, this.awbGains.g, this.awbGains.b)
        
        // Set up vertex attributes
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
        gl.enableVertexAttribArray(this.locations.aPosition)
        gl.vertexAttribPointer(this.locations.aPosition, 2, gl.FLOAT, false, 16, 0)
        gl.enableVertexAttribArray(this.locations.aTexCoord)
        gl.vertexAttribPointer(this.locations.aTexCoord, 2, gl.FLOAT, false, 16, 8)
        
        // Draw
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    
    destroy() {
        const gl = this.gl
        if (this.program) gl.deleteProgram(this.program)
        if (this.texture) gl.deleteTexture(this.texture)
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer)
    }
}
