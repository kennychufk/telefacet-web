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

// Fragment shader for fast (nearest neighbor) debayering
export const fragmentShaderFast = `
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform vec2 u_textureSize;
uniform vec3 u_awbGains; // R, G, B gains
varying vec2 v_texCoord;

// Unpack 10-bit value from SRGGB10P format
// 4 pixels are packed into 5 bytes: P1[9:2]|P2[9:2]|P3[9:2]|P4[9:2]|P1[1:0],P2[1:0],P3[1:0],P4[1:0]
float unpack10bit(vec2 coord) {
    vec2 texel = coord * u_textureSize;
    float x = texel.x;
    float y = texel.y;
    
    // Calculate which pixel within the 4-pixel group
    int pixelInGroup = int(mod(x, 4.0));
    
    // Calculate byte positions
    float groupStart = floor(x / 4.0) * 5.0;
    float mainByte = groupStart + float(pixelInGroup);
    float sharedByte = groupStart + 4.0;
    
    // Read the bytes (normalized to 0-1)
    vec2 mainCoord = vec2((mainByte + 0.5) / u_textureSize.x, (y + 0.5) / u_textureSize.y);
    vec2 sharedCoord = vec2((sharedByte + 0.5) / u_textureSize.x, (y + 0.5) / u_textureSize.y);
    
    float mainValue = texture2D(u_texture, mainCoord).r * 255.0;
    float sharedValue = texture2D(u_texture, sharedCoord).r * 255.0;
    
    // Extract the 2 LSB bits for this pixel
    float lsb = 0.0;
    if (pixelInGroup == 0) {
        lsb = mod(floor(sharedValue / 64.0), 4.0);
    } else if (pixelInGroup == 1) {
        lsb = mod(floor(sharedValue / 16.0), 4.0);
    } else if (pixelInGroup == 2) {
        lsb = mod(floor(sharedValue / 4.0), 4.0);
    } else {
        lsb = mod(sharedValue, 4.0);
    }
    
    // Combine MSB and LSB to get 10-bit value
    float value10bit = mainValue * 4.0 + lsb;
    
    // Normalize to 0-1 range
    return value10bit / 1023.0;
}

void main() {
    vec2 texel = v_texCoord * u_textureSize;
    
    // Determine Bayer pattern position (RGGB)
    int x = int(mod(texel.x, 2.0));
    int y = int(mod(texel.y, 2.0));
    
    // Get the raw value at this position
    float rawValue = unpack10bit(v_texCoord);
    
    vec3 color;
    
    // Simple nearest neighbor - just replicate the color channels
    if (x == 0 && y == 0) {
        // Red pixel
        color = vec3(rawValue * u_awbGains.r, rawValue * 0.5, rawValue * 0.25);
    } else if (x == 1 && y == 0) {
        // Green pixel (Gr)
        color = vec3(rawValue * 0.5, rawValue * u_awbGains.g, rawValue * 0.5);
    } else if (x == 0 && y == 1) {
        // Green pixel (Gb)
        color = vec3(rawValue * 0.5, rawValue * u_awbGains.g, rawValue * 0.5);
    } else {
        // Blue pixel
        color = vec3(rawValue * 0.25, rawValue * 0.5, rawValue * u_awbGains.b);
    }
    
    gl_FragColor = vec4(color, 1.0);
}
`

// Fragment shader for quality (bilinear) debayering
export const fragmentShaderQuality = `
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform vec2 u_textureSize;
uniform vec3 u_awbGains;
varying vec2 v_texCoord;

float unpack10bit(vec2 coord) {
    vec2 texel = coord * u_textureSize;
    float x = texel.x;
    float y = texel.y;
    
    int pixelInGroup = int(mod(x, 4.0));
    float groupStart = floor(x / 4.0) * 5.0;
    float mainByte = groupStart + float(pixelInGroup);
    float sharedByte = groupStart + 4.0;
    
    vec2 mainCoord = vec2((mainByte + 0.5) / u_textureSize.x, (y + 0.5) / u_textureSize.y);
    vec2 sharedCoord = vec2((sharedByte + 0.5) / u_textureSize.x, (y + 0.5) / u_textureSize.y);
    
    float mainValue = texture2D(u_texture, mainCoord).r * 255.0;
    float sharedValue = texture2D(u_texture, sharedCoord).r * 255.0;
    
    float lsb = 0.0;
    if (pixelInGroup == 0) {
        lsb = mod(floor(sharedValue / 64.0), 4.0);
    } else if (pixelInGroup == 1) {
        lsb = mod(floor(sharedValue / 16.0), 4.0);
    } else if (pixelInGroup == 2) {
        lsb = mod(floor(sharedValue / 4.0), 4.0);
    } else {
        lsb = mod(sharedValue, 4.0);
    }
    
    float value10bit = mainValue * 4.0 + lsb;
    return value10bit / 1023.0;
}

// Sample neighboring pixels for interpolation
float samplePixel(vec2 offset) {
    vec2 coord = v_texCoord + offset / u_textureSize;
    return unpack10bit(coord);
}

void main() {
    vec2 texel = v_texCoord * u_textureSize;
    int x = int(mod(texel.x, 2.0));
    int y = int(mod(texel.y, 2.0));
    
    float center = unpack10bit(v_texCoord);
    
    // Sample neighboring pixels
    float top = samplePixel(vec2(0.0, -1.0));
    float bottom = samplePixel(vec2(0.0, 1.0));
    float left = samplePixel(vec2(-1.0, 0.0));
    float right = samplePixel(vec2(1.0, 0.0));
    float topLeft = samplePixel(vec2(-1.0, -1.0));
    float topRight = samplePixel(vec2(1.0, -1.0));
    float bottomLeft = samplePixel(vec2(-1.0, 1.0));
    float bottomRight = samplePixel(vec2(1.0, 1.0));
    
    vec3 color;
    
    if (x == 0 && y == 0) {
        // Red pixel - interpolate green and blue
        float green = (top + bottom + left + right) * 0.25;
        float blue = (topLeft + topRight + bottomLeft + bottomRight) * 0.25;
        color = vec3(center * u_awbGains.r, green * u_awbGains.g, blue * u_awbGains.b);
    } else if (x == 1 && y == 0) {
        // Green pixel (Gr) - interpolate red and blue
        float red = (left + right) * 0.5;
        float blue = (top + bottom) * 0.5;
        color = vec3(red * u_awbGains.r, center * u_awbGains.g, blue * u_awbGains.b);
    } else if (x == 0 && y == 1) {
        // Green pixel (Gb) - interpolate red and blue
        float red = (top + bottom) * 0.5;
        float blue = (left + right) * 0.5;
        color = vec3(red * u_awbGains.r, center * u_awbGains.g, blue * u_awbGains.b);
    } else {
        // Blue pixel - interpolate red and green
        float red = (topLeft + topRight + bottomLeft + bottomRight) * 0.25;
        float green = (top + bottom + left + right) * 0.25;
        color = vec3(red * u_awbGains.r, green * u_awbGains.g, center * u_awbGains.b);
    }
    
    gl_FragColor = vec4(color, 1.0);
}
`

// Fragment shader for high quality (Malvar-He-Cutler) debayering
export const fragmentShaderHighQuality = `
precision highp float;
precision highp int;

uniform sampler2D u_texture;
uniform vec2 u_textureSize;
uniform vec3 u_awbGains;
varying vec2 v_texCoord;

float unpack10bit(vec2 coord) {
    vec2 texel = coord * u_textureSize;
    float x = texel.x;
    float y = texel.y;
    
    int pixelInGroup = int(mod(x, 4.0));
    float groupStart = floor(x / 4.0) * 5.0;
    float mainByte = groupStart + float(pixelInGroup);
    float sharedByte = groupStart + 4.0;
    
    vec2 mainCoord = vec2((mainByte + 0.5) / u_textureSize.x, (y + 0.5) / u_textureSize.y);
    vec2 sharedCoord = vec2((sharedByte + 0.5) / u_textureSize.x, (y + 0.5) / u_textureSize.y);
    
    float mainValue = texture2D(u_texture, mainCoord).r * 255.0;
    float sharedValue = texture2D(u_texture, sharedCoord).r * 255.0;
    
    float lsb = 0.0;
    if (pixelInGroup == 0) {
        lsb = mod(floor(sharedValue / 64.0), 4.0);
    } else if (pixelInGroup == 1) {
        lsb = mod(floor(sharedValue / 16.0), 4.0);
    } else if (pixelInGroup == 2) {
        lsb = mod(floor(sharedValue / 4.0), 4.0);
    } else {
        lsb = mod(sharedValue, 4.0);
    }
    
    float value10bit = mainValue * 4.0 + lsb;
    return value10bit / 1023.0;
}

// Sample with bounds checking
float samplePixel(vec2 offset) {
    vec2 coord = v_texCoord + offset / u_textureSize;
    if (coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0) {
        return 0.0;
    }
    return unpack10bit(coord);
}

void main() {
    vec2 texel = v_texCoord * u_textureSize;
    int x = int(mod(texel.x, 2.0));
    int y = int(mod(texel.y, 2.0));
    
    // Sample 5x5 neighborhood
    float p00 = samplePixel(vec2(-2.0, -2.0));
    float p10 = samplePixel(vec2(-1.0, -2.0));
    float p20 = samplePixel(vec2( 0.0, -2.0));
    float p30 = samplePixel(vec2( 1.0, -2.0));
    float p40 = samplePixel(vec2( 2.0, -2.0));
    
    float p01 = samplePixel(vec2(-2.0, -1.0));
    float p11 = samplePixel(vec2(-1.0, -1.0));
    float p21 = samplePixel(vec2( 0.0, -1.0));
    float p31 = samplePixel(vec2( 1.0, -1.0));
    float p41 = samplePixel(vec2( 2.0, -1.0));
    
    float p02 = samplePixel(vec2(-2.0,  0.0));
    float p12 = samplePixel(vec2(-1.0,  0.0));
    float p22 = samplePixel(vec2( 0.0,  0.0)); // center
    float p32 = samplePixel(vec2( 1.0,  0.0));
    float p42 = samplePixel(vec2( 2.0,  0.0));
    
    float p03 = samplePixel(vec2(-2.0,  1.0));
    float p13 = samplePixel(vec2(-1.0,  1.0));
    float p23 = samplePixel(vec2( 0.0,  1.0));
    float p33 = samplePixel(vec2( 1.0,  1.0));
    float p43 = samplePixel(vec2( 2.0,  1.0));
    
    float p04 = samplePixel(vec2(-2.0,  2.0));
    float p14 = samplePixel(vec2(-1.0,  2.0));
    float p24 = samplePixel(vec2( 0.0,  2.0));
    float p34 = samplePixel(vec2( 1.0,  2.0));
    float p44 = samplePixel(vec2( 2.0,  2.0));
    
    vec3 color;
    
    if (x == 0 && y == 0) {
        // Red pixel
        float red = p22;
        
        // Green uses optimized filter
        float green = (4.0 * p22 + 2.0 * (p12 + p21 + p23 + p32) - 
                      (p02 + p20 + p24 + p42)) / 8.0;
        
        // Blue uses diagonal average
        float blue = (p11 + p13 + p31 + p33) / 4.0;
        
        color = vec3(red * u_awbGains.r, green * u_awbGains.g, blue * u_awbGains.b);
        
    } else if ((x == 1 && y == 0) || (x == 0 && y == 1)) {
        // Green pixel
        float green = p22;
        
        if (x == 1 && y == 0) {
            // Gr - red on sides, blue above/below
            float red = (5.0 * p22 + 4.0 * (p12 + p32) + 
                        0.5 * (p02 + p42) - (p01 + p03 + p11 + p13 + p31 + p33 + p41 + p43)) / 8.0;
            float blue = (5.0 * p22 + 4.0 * (p21 + p23) + 
                         0.5 * (p20 + p24) - (p10 + p11 + p13 + p14 + p30 + p31 + p33 + p34)) / 8.0;
            color = vec3(red * u_awbGains.r, green * u_awbGains.g, blue * u_awbGains.b);
        } else {
            // Gb - blue on sides, red above/below
            float red = (5.0 * p22 + 4.0 * (p21 + p23) + 
                        0.5 * (p20 + p24) - (p10 + p11 + p13 + p14 + p30 + p31 + p33 + p34)) / 8.0;
            float blue = (5.0 * p22 + 4.0 * (p12 + p32) + 
                         0.5 * (p02 + p42) - (p01 + p03 + p11 + p13 + p31 + p33 + p41 + p43)) / 8.0;
            color = vec3(red * u_awbGains.r, green * u_awbGains.g, blue * u_awbGains.b);
        }
        
    } else {
        // Blue pixel
        float blue = p22;
        
        // Green uses optimized filter
        float green = (4.0 * p22 + 2.0 * (p12 + p21 + p23 + p32) - 
                      (p02 + p20 + p24 + p42)) / 8.0;
        
        // Red uses diagonal average
        float red = (p11 + p13 + p31 + p33) / 4.0;
        
        color = vec3(red * u_awbGains.r, green * u_awbGains.g, blue * u_awbGains.b);
    }
    
    // Clamp to valid range
    color = clamp(color, 0.0, 1.0);
    
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
            case 'fast':
                return fragmentShaderFast
            case 'high':
                return fragmentShaderHighQuality
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
        
        // For SRGGB10P, we need to handle the packed format
        // The texture width should be bytesPerLine (not width) to properly read the packed data
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
