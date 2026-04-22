// src/webgl/Debayer.js - YUV420 → RGB renderer with BT.601 conversion and 180° rotation

const vertexShaderSource = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    // Rotate 180° by inverting both texture coordinates
    v_texCoord = vec2(1.0 - a_texCoord.x, 1.0 - a_texCoord.y);
}
`

// BT.601 full-range YCbCr → RGB. Three separate LUMINANCE textures (Y, U, V).
// u_widthRatio corrects for stride padding in the Y plane.
// U/V textures are half-res; WebGL bilinear upsamples them automatically.
const fragmentShaderSource = `
precision mediump float;

uniform sampler2D u_textureY;
uniform sampler2D u_textureU;
uniform sampler2D u_textureV;
uniform float u_widthRatio;

varying vec2 v_texCoord;

void main() {
    vec2 tc = vec2(v_texCoord.x * u_widthRatio, v_texCoord.y);

    float y = texture2D(u_textureY, tc).r;
    float u = texture2D(u_textureU, tc).r - 0.5;
    float v = texture2D(u_textureV, tc).r - 0.5;

    float r = y + 1.402 * v;
    float g = y - 0.344136 * u - 0.714136 * v;
    float b = y + 1.772 * u;

    gl_FragColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}
`

export class Debayer {
    constructor(canvas) {
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

        this.program = null
        this.yTexture = null
        this.uTexture = null
        this.vTexture = null
        this.vertexBuffer = null
        this.locations = {}

        this._initWebGL()
    }

    _initWebGL() {
        const gl = this.gl

        const vert = this._compileShader(gl.VERTEX_SHADER, vertexShaderSource)
        const frag = this._compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource)

        this.program = gl.createProgram()
        gl.attachShader(this.program, vert)
        gl.attachShader(this.program, frag)
        gl.linkProgram(this.program)

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            throw new Error('Shader link failed: ' + gl.getProgramInfoLog(this.program))
        }

        this.locations = {
            aPosition:  gl.getAttribLocation(this.program, 'a_position'),
            aTexCoord:  gl.getAttribLocation(this.program, 'a_texCoord'),
            uTextureY:  gl.getUniformLocation(this.program, 'u_textureY'),
            uTextureU:  gl.getUniformLocation(this.program, 'u_textureU'),
            uTextureV:  gl.getUniformLocation(this.program, 'u_textureV'),
            uWidthRatio: gl.getUniformLocation(this.program, 'u_widthRatio')
        }

        // Full-screen quad: [position.xy, texCoord.xy] interleaved
        const vertices = new Float32Array([
            -1, -1,  0, 1,
             1, -1,  1, 1,
            -1,  1,  0, 0,
             1,  1,  1, 0
        ])
        this.vertexBuffer = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)

        this.yTexture = this._makeTexture()
        this.uTexture = this._makeTexture()
        this.vTexture = this._makeTexture()

        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    }

    _makeTexture() {
        const gl = this.gl
        const tex = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        return tex
    }

    _compileShader(type, source) {
        const gl = this.gl
        const shader = gl.createShader(type)
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader))
        }
        return shader
    }

    // No-ops retained so call sites that still set quality/AWB don't throw
    setQuality() {}
    setAWBGains() {}
    setFrameAWBGains() {}

    processFrame(frameData, width, height, bytesPerLine) {
        const gl = this.gl

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width
            this.canvas.height = height
            gl.viewport(0, 0, width, height)
        }

        const uvStride = bytesPerLine >> 1
        const uvHeight = height >> 1
        const ySize    = bytesPerLine * height
        const uvSize   = uvStride * uvHeight

        // Zero-copy slices into the received ArrayBuffer
        const yData = new Uint8Array(frameData.buffer, frameData.byteOffset, ySize)
        const uData = new Uint8Array(frameData.buffer, frameData.byteOffset + ySize, uvSize)
        const vData = new Uint8Array(frameData.buffer, frameData.byteOffset + ySize + uvSize, uvSize)

        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        gl.useProgram(this.program)

        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.yTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, bytesPerLine, height, 0,
                      gl.LUMINANCE, gl.UNSIGNED_BYTE, yData)

        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, this.uTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, uvStride, uvHeight, 0,
                      gl.LUMINANCE, gl.UNSIGNED_BYTE, uData)

        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, this.vTexture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, uvStride, uvHeight, 0,
                      gl.LUMINANCE, gl.UNSIGNED_BYTE, vData)

        gl.uniform1i(this.locations.uTextureY, 0)
        gl.uniform1i(this.locations.uTextureU, 1)
        gl.uniform1i(this.locations.uTextureV, 2)
        gl.uniform1f(this.locations.uWidthRatio, width / bytesPerLine)

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
        gl.enableVertexAttribArray(this.locations.aPosition)
        gl.vertexAttribPointer(this.locations.aPosition, 2, gl.FLOAT, false, 16, 0)
        gl.enableVertexAttribArray(this.locations.aTexCoord)
        gl.vertexAttribPointer(this.locations.aTexCoord, 2, gl.FLOAT, false, 16, 8)

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    destroy() {
        const gl = this.gl
        if (this.program)      gl.deleteProgram(this.program)
        if (this.yTexture)     gl.deleteTexture(this.yTexture)
        if (this.uTexture)     gl.deleteTexture(this.uTexture)
        if (this.vTexture)     gl.deleteTexture(this.vTexture)
        if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer)
    }
}
