// src/webgl/Debayer.js

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

// Fragment shader for quality (bilinear) debayering
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
    
    float groupIdx = floor(x / 4.0);
    int pixelInGroup = int(mod(x, 4.0));
    
    float lineOffset = y * u_bytesPerLine;
    float groupOffset = groupIdx * 5.0;
    
    float b0Pos = lineOffset + groupOffset + 0.0;
    float b1Pos = lineOffset + groupOffset + 1.0;
    float b2Pos = lineOffset + groupOffset + 2.0;
    float b3Pos = lineOffset + groupOffset + 3.0;
    float b4Pos = lineOffset + groupOffset + 4.0;
    
    vec2 b0Coord = vec2(mod(b0Pos, u_bytesPerLine) / u_bytesPerLine, floor(b0Pos / u_bytesPerLine) / u_textureSize.y);
    vec2 b1Coord = vec2(mod(b1Pos, u_bytesPerLine) / u_bytesPerLine, floor(b1Pos / u_bytesPerLine) / u_textureSize.y);
    vec2 b2Coord = vec2(mod(b2Pos, u_bytesPerLine) / u_bytesPerLine, floor(b2Pos / u_bytesPerLine) / u_textureSize.y);
    vec2 b3Coord = vec2(mod(b3Pos, u_bytesPerLine) / u_bytesPerLine, floor(b3Pos / u_bytesPerLine) / u_textureSize.y);
    vec2 b4Coord = vec2(mod(b4Pos, u_bytesPerLine) / u_bytesPerLine, floor(b4Pos / u_bytesPerLine) / u_textureSize.y);
    
    float b0 = texture2D(u_texture, b0Coord).r * 255.0;
    float b1 = texture2D(u_texture, b1Coord).r * 255.0;
    float b2 = texture2D(u_texture, b2Coord).r * 255.0;
    float b3 = texture2D(u_texture, b3Coord).r * 255.0;
    float b4 = texture2D(u_texture, b4Coord).r * 255.0;
    
    float value10bit;
    if (pixelInGroup == 0) {
        value10bit = (b0 * 4.0) + floor(b4 / 64.0);
    } else if (pixelInGroup == 1) {
        value10bit = (b1 * 4.0) + floor(mod(b4, 64.0) / 16.0);
    } else if (pixelInGroup == 2) {
        value10bit = (b2 * 4.0) + floor(mod(b4, 16.0) / 4.0);
    } else {
        value10bit = (b3 * 4.0) + mod(b4, 4.0);
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
    
    // Determine Bayer pattern position (BGGR)
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
            // Blue pixel at (0,0)
            float red = (NW + NE + SW + SE) * 0.25;
            float green = (N + S + E + W) * 0.25;
            float blue = C;
            color = vec3(red, green, blue);
        } else {
            // Green pixel in blue row at (1,0)
            float red = (N + S) * 0.5;
            float green = C;
            float blue = (W + E) * 0.5;
            color = vec3(red, green, blue);
        }
    } else {
        if (alternate.x < 0.5) {
            // Green pixel in red row at (0,1)
            float red = (W + E) * 0.5;
            float green = C;
            float blue = (N + S) * 0.5;
            color = vec3(red, green, blue);
        } else {
            // Red pixel at (1,1)
            float red = C;
            float green = (N + S + E + W) * 0.25;
            float blue = (NW + NE + SW + SE) * 0.25;
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
