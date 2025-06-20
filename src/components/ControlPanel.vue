<!-- src/components/ControlPanel.vue -->
<template>
  <div class="control-panel" :class="{ collapsed: !store.showControlPanel }">
    <button 
      class="toggle-button"
      @click="store.toggleControlPanel"
      :title="store.showControlPanel ? 'Hide Panel' : 'Show Panel'"
    >
      <svg width="20" height="20" viewBox="0 0 20 20">
        <path 
          v-if="store.showControlPanel"
          d="M13 10L7 5v10l6-5z"
          fill="currentColor"
        />
        <path 
          v-else
          d="M7 10l6-5v10l-6-5z"
          fill="currentColor"
        />
      </svg>
    </button>
    
    <div class="panel-content" v-show="store.showControlPanel">
      <!-- Configuration Section -->
      <section class="panel-section">
        <h3>Configuration</h3>
        
        <div 
          class="config-drop-zone"
          :class="{ dragover: isDragging }"
          @drop="handleDrop"
          @dragover.prevent="isDragging = true"
          @dragleave="isDragging = false"
        >
          <input
            ref="fileInput"
            type="file"
            accept=".yaml,.yml"
            @change="handleFileSelect"
            style="display: none"
          />
          
          <div v-if="!store.configLoaded" class="drop-message">
            <p>Drop YAML config here or</p>
            <button class="browse-button" @click="$refs.fileInput.click()">
              Browse Files
            </button>
          </div>
          
          <div v-else class="config-loaded">
            <p class="config-status">✓ Configuration Loaded</p>
            <button class="reload-button" @click="$refs.fileInput.click()">
              Load New Config
            </button>
          </div>
        </div>
      </section>
      
      <!-- Server Status Section -->
      <section class="panel-section" v-if="store.servers.length > 0">
        <h3>Server Status</h3>
        <ServerStatus 
          v-for="server in store.servers"
          :key="server.index"
          :server="server"
        />
      </section>
      
      <!-- Camera Controls Section -->
      <section class="panel-section" v-if="store.totalCameras > 0">
        <h3>Camera Controls</h3>
        
        <div class="control-buttons">
          <button 
            class="control-button"
            :disabled="!store.canConfigure"
            @click="configureCameras"
          >
            Configure All
          </button>
          
          <button 
            class="control-button"
            :disabled="!store.canStartCameras"
            @click="startCameras"
          >
            Start All Cameras
          </button>
          
          <button 
            class="control-button stop"
            :disabled="!store.canStopCameras"
            @click="stopCameras"
          >
            Stop All Cameras
          </button>
        </div>
        
        <div class="camera-list">
          <div 
            v-for="camera in store.cameras"
            :key="camera.globalId"
            class="camera-item"
          >
            <button
              class="camera-toggle"
              :class="{ active: camera.streaming }"
              :disabled="!store.camerasRunning"
              @click="toggleCamera(camera.globalId)"
            >
              <span class="camera-id">cam{{ camera.globalId }}</span>
              <span class="camera-fps" v-if="camera.streaming">
                {{ camera.fps }} FPS
              </span>
            </button>
          </div>
        </div>
      </section>
      
      <!-- Settings Section -->
      <section class="panel-section">
        <h3>Settings</h3>
        
        <div class="setting-item">
          <label>Debayer Quality</label>
          <select 
            v-model="store.debayerQuality"
            @change="store.setDebayerQuality($event.target.value)"
            class="quality-select"
          >
            <option value="quality">Quality</option>
          </select>
        </div>
        
        <div class="setting-item" v-if="store.config">
          <label>Frame Saving</label>
          <p class="setting-value">{{ store.config.frame_saving.mode }}</p>
        </div>
      </section>
      
      <!-- Error Display -->
      <div v-if="store.lastError" class="error-message">
        <p>{{ store.lastError }}</p>
        <button @click="store.clearError" class="error-close">×</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useCameraStore } from '../stores/cameraStore'
import ServerStatus from './ServerStatus.vue'

const store = useCameraStore()
const isDragging = ref(false)
const fileInput = ref(null)

async function handleDrop(event) {
  event.preventDefault()
  isDragging.value = false
  
  const file = event.dataTransfer.files[0]
  if (file && (file.name.endsWith('.yaml') || file.name.endsWith('.yml'))) {
    await store.loadConfig(file)
  }
}

async function handleFileSelect(event) {
  const file = event.target.files[0]
  if (file) {
    await store.loadConfig(file)
  }
}

async function configureCameras() {
  await store.configureAllCameras()
}

async function startCameras() {
  await store.startAllCameras()
}

async function stopCameras() {
  await store.stopAllCameras()
}

function toggleCamera(globalId) {
  store.toggleCameraStream(globalId)
}
</script>

<style scoped>
.control-panel {
  position: relative;
  width: 320px;
  height: 100%;
  background: #1a1a1a;
  border-right: 1px solid #333;
  transition: margin-left 0.3s ease;
  overflow-y: auto;
  overflow-x: hidden;
}

.control-panel.collapsed {
  margin-left: -320px;
}

.toggle-button {
  position: absolute;
  right: -32px;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
  height: 64px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-left: none;
  border-radius: 0 4px 4px 0;
  color: #888;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.toggle-button:hover {
  background: #222;
  color: #aaa;
}

.panel-content {
  padding: 20px;
}

.panel-section {
  margin-bottom: 24px;
}

.panel-section h3 {
  margin: 0 0 12px 0;
  color: #ddd;
  font-size: 16px;
  font-weight: 600;
}

/* Configuration Drop Zone */
.config-drop-zone {
  border: 2px dashed #444;
  border-radius: 8px;
  padding: 24px;
  text-align: center;
  transition: all 0.2s;
}

.config-drop-zone.dragover {
  border-color: #4a9eff;
  background: rgba(74, 158, 255, 0.1);
}

.drop-message p {
  color: #888;
  margin-bottom: 12px;
}

.browse-button,
.reload-button {
  background: #4a9eff;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.2s;
}

.browse-button:hover,
.reload-button:hover {
  background: #357abd;
}

.config-loaded {
  color: #4ade80;
}

.config-status {
  margin-bottom: 12px;
  font-weight: 500;
}

/* Control Buttons */
.control-buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.control-button {
  background: #333;
  color: #ddd;
  border: 1px solid #444;
  padding: 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.control-button:hover:not(:disabled) {
  background: #444;
  border-color: #555;
}

.control-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.control-button.stop {
  background: #dc2626;
  border-color: #991b1b;
}

.control-button.stop:hover:not(:disabled) {
  background: #991b1b;
}

/* Camera List */
.camera-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.camera-toggle {
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.camera-toggle:hover:not(:disabled) {
  background: #333;
  border-color: #555;
}

.camera-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.camera-toggle.active {
  background: #10b981;
  border-color: #059669;
  color: white;
}

.camera-id {
  font-weight: 600;
  font-size: 14px;
}

.camera-fps {
  font-size: 12px;
  color: #ccc;
}

.camera-toggle.active .camera-fps {
  color: white;
}

/* Settings */
.setting-item {
  margin-bottom: 12px;
}

.setting-item label {
  display: block;
  color: #888;
  font-size: 13px;
  margin-bottom: 4px;
}

.quality-select {
  width: 100%;
  background: #2a2a2a;
  color: #ddd;
  border: 1px solid #444;
  padding: 8px;
  border-radius: 4px;
  font-size: 14px;
}

.setting-value {
  color: #ddd;
  font-size: 14px;
  margin: 0;
}

/* Error Message */
.error-message {
  background: #dc2626;
  color: white;
  padding: 12px;
  border-radius: 4px;
  margin-top: 16px;
  position: relative;
}

.error-message p {
  margin: 0;
  padding-right: 24px;
  font-size: 13px;
}

.error-close {
  position: absolute;
  top: 8px;
  right: 8px;
  background: none;
  border: none;
  color: white;
  font-size: 20px;
  cursor: pointer;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
