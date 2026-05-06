<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

const stageRef = ref(null)
const videoRef = ref(null)
const keyboardInputRef = ref(null)
const bridgeMissing = ref(false)
const isFullscreen = ref(false)
const statsTimer = ref(null)
const cursorX = ref(0)
const cursorY = ref(0)
const cursorVisible = ref(false)

const status = reactive({
  sessionStatus: 'idle',
  socketStatus: 'idle',
  peerStatus: 'idle',
  connectionState: 'new',
  controlChannelState: 'idle',
  remoteStreamState: 'idle',
  currentStep: 'idle',
  lastError: '',
  screenReady: false,
  canInteract: false,
  sessionId: '',
  deviceId: '',
  hasTouchscreen: false,
})
const stats = reactive({
  fps: null,
  bitrateKbps: null,
  packetsLost: null,
  jitterMs: null,
  roundTripTimeMs: null,
  availableOutgoingBitrateKbps: null,
  frameWidth: null,
  frameHeight: null,
  qualityLabel: 'offline',
  updatedAt: '',
})

const getBridge = () => {
  try {
    return window.opener?.__remoteDesktopSimulatorBridge ?? null
  } catch {
    return null
  }
}

const applySnapshot = () => {
  const bridge = getBridge()
  if (!bridge) {
    bridgeMissing.value = true
    return
  }

  Object.assign(status, bridge.getStatusSnapshot?.() ?? {})
  Object.assign(stats, bridge.getStatsSnapshot?.() ?? {})
  bridgeMissing.value = false
}

const attachViewer = () => {
  const bridge = getBridge()
  if (!bridge || !stageRef.value || !videoRef.value) {
    bridgeMissing.value = true
    return
  }

  bridge.attachViewerElements?.({
    stageElement: stageRef.value,
    videoElement: videoRef.value,
  })
  applySnapshot()
  stageRef.value.focus()
}

const detachViewer = () => {
  const bridge = getBridge()
  bridge?.detachViewerElements?.()
}

const toggleFullscreen = async () => {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen?.()
    return
  }

  await document.exitFullscreen?.()
}

const syncFullscreen = () => {
  isFullscreen.value = Boolean(document.fullscreenElement)
}

const forwardKeyboard = (type, event) => {
  const bridge = getBridge()
  bridge?.handleKeyboard?.(type, event)
}

const forwardMouseMove = (event) => {
  const bridge = getBridge()
  bridge?.handleMouseMove?.(event)
}

const onMouseMove = (event) => {
  const rect = videoRef.value?.getBoundingClientRect()
  if (rect) {
    cursorX.value = event.clientX - rect.left
    cursorY.value = event.clientY - rect.top
    cursorVisible.value = true
  }
  forwardMouseMove(event)
}

const forwardMouseButton = (type, event) => {
  const bridge = getBridge()
  bridge?.handleMouseButton?.(type, event)
}

const forwardWheel = (event) => {
  const bridge = getBridge()
  bridge?.handleWheel?.(event)
}

const forwardTouchStart = (event) => {
  const bridge = getBridge()
  bridge?.handleTouchStart?.(event)
}

const forwardTouchMove = (event) => {
  const bridge = getBridge()
  bridge?.handleTouchMove?.(event)
}

const forwardTouchEnd = (event) => {
  const bridge = getBridge()
  bridge?.handleTouchEnd?.(event)
}

const openKeyboard = () => {
  const bridge = getBridge()
  const typed = window.prompt('Ketik teks untuk dikirim ke perangkat:', '')
  if (typed !== null && typed.length > 0) {
    bridge?.handleTextInput?.(typed)
  }
  stageRef.value?.focus?.()
  keyboardInputRef.value?.focus?.()
}

const forwardKeyboardText = (event) => {
  const bridge = getBridge()
  const value = event?.target?.value ?? ''
  if (!value) {
    return
  }
  bridge?.handleTextInput?.(value)
  event.target.value = ''
  stageRef.value?.focus?.()
}

const closeTab = () => {
  window.close()
}

const qualityBadgeClass = computed(() => {
  if (stats.qualityLabel === 'strong') {
    return 'badge badge--success'
  }

  if (stats.qualityLabel === 'stable') {
    return 'badge badge--info'
  }

  if (stats.qualityLabel === 'warming up') {
    return 'badge badge--muted'
  }

  return 'badge badge--warning'
})

const metricCards = computed(() => [
  ['Quality', stats.qualityLabel || '-'],
  ['FPS', stats.fps ?? '-'],
  ['Bitrate', stats.bitrateKbps ? `${stats.bitrateKbps} kbps` : '-'],
  ['RTT', stats.roundTripTimeMs ? `${stats.roundTripTimeMs} ms` : '-'],
  ['Jitter', stats.jitterMs ? `${stats.jitterMs} ms` : '-'],
  ['Packets lost', stats.packetsLost ?? '-'],
  ['Resolution', stats.frameWidth && stats.frameHeight ? `${stats.frameWidth} x ${stats.frameHeight}` : '-'],
])

onMounted(() => {
  attachViewer()
  applySnapshot()
  statsTimer.value = window.setInterval(() => {
    applySnapshot()
  }, 1000)
  document.addEventListener('fullscreenchange', syncFullscreen)
})

onBeforeUnmount(() => {
  window.clearInterval(statsTimer.value)
  document.removeEventListener('fullscreenchange', syncFullscreen)
  detachViewer()
})
</script>

<template>
  <main class="viewer-page">
    <section class="viewer-shell">
      <header class="viewer-topbar">
        <div class="viewer-title">
          <p class="viewer-kicker">Remote Screen Viewer</p>
          <h1>{{ status.sessionId || 'Viewer' }}</h1>
          <p class="viewer-subtitle">
            Session {{ status.sessionStatus }} | connection {{ status.connectionState }} | control
            {{ status.controlChannelState }}
          </p>
        </div>

        <div class="viewer-actions">
          <span :class="qualityBadgeClass">{{ stats.qualityLabel || 'offline' }}</span>
          <button class="ghost-button" type="button" @click="openKeyboard">
            Keyboard
          </button>
          <button class="ghost-button" type="button" @click="toggleFullscreen">
            {{ isFullscreen ? 'Exit fullscreen' : 'Fullscreen' }}
          </button>
          <button class="ghost-button" type="button" @click="closeTab">
            Tutup tab
          </button>
        </div>
      </header>

      <div v-if="bridgeMissing" class="viewer-empty">
        <strong>Viewer perlu dibuka dari halaman simulator utama.</strong>
        <p>
          Tab ini tidak menemukan koneksi aktif di `window.opener`, jadi stream tidak bisa dipasang. Jalankan session dari
          halaman utama lalu buka viewer dari tombol `Tampilkan screen di tab baru`.
        </p>
      </div>

      <div v-else class="viewer-layout">
        <section
          ref="stageRef"
          class="viewer-stage"
          tabindex="0"
          @keydown.prevent="forwardKeyboard('keyboard.key_down', $event)"
          @keyup.prevent="forwardKeyboard('keyboard.key_up', $event)"
          @click="stageRef?.focus()"
          @contextmenu.prevent
        >
          <input
            ref="keyboardInputRef"
            class="keyboard-proxy"
            type="text"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            @input="forwardKeyboardText"
          />
          <video
            ref="videoRef"
            autoplay
            playsinline
            muted
            :class="['viewer-video', status.canInteract ? 'viewer-video--interactive' : '']"
            @mousemove="onMouseMove"
            @mouseleave="cursorVisible = false"
            @click="stageRef?.focus()"
            @mousedown.prevent="forwardMouseButton('mouse.down', $event)"
            @mouseup.prevent="forwardMouseButton('mouse.up', $event)"
            @touchstart.prevent="forwardTouchStart"
            @touchmove.prevent="forwardTouchMove"
            @touchend.prevent="forwardTouchEnd"
            @touchcancel.prevent="forwardTouchEnd"
            @wheel.prevent="forwardWheel"
            @contextmenu.prevent
          />

          <div
            v-if="status.canInteract && cursorVisible"
            class="cursor-overlay"
            :class="status.hasTouchscreen ? 'cursor-overlay--touch' : 'cursor-overlay--pointer'"
            :style="{ transform: `translate(${cursorX}px, ${cursorY}px)` }"
            aria-hidden="true"
          />

          <span class="viewer-live-pill">
            {{ status.screenReady ? 'Live' : 'Waiting stream' }}
          </span>
        </section>

        <aside class="viewer-sidebar">
          <article class="metric-panel">
            <p class="viewer-kicker">Health</p>
            <h2>Realtime metrics</h2>

            <dl class="metric-grid">
              <template v-for="[label, value] in metricCards" :key="label">
                <dt>{{ label }}</dt>
                <dd>{{ value }}</dd>
              </template>
            </dl>
          </article>

          <article class="metric-panel">
            <p class="viewer-kicker">Session</p>
            <h2>Transport state</h2>

            <dl class="metric-grid">
              <dt>Socket</dt>
              <dd>{{ status.socketStatus }}</dd>
              <dt>Peer</dt>
              <dd>{{ status.peerStatus }}</dd>
              <dt>Step</dt>
              <dd>{{ status.currentStep }}</dd>
              <dt>Device</dt>
              <dd>{{ status.deviceId || '-' }}</dd>
              <dt>Updated</dt>
              <dd>{{ stats.updatedAt || '-' }}</dd>
            </dl>

            <p v-if="status.lastError" class="error-banner">
              {{ status.lastError }}
            </p>
          </article>
        </aside>
      </div>
    </section>
  </main>
</template>

<style scoped>
.viewer-page {
  height: 100dvh;
  padding: clamp(8px, 1.6vw, 18px);
  box-sizing: border-box;
}

.viewer-shell {
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 18px;
  border: 1px solid var(--line);
  border-radius: 28px;
  background:
    radial-gradient(circle at top left, rgba(76, 154, 255, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(239, 246, 255, 0.98));
  box-shadow: var(--shadow);
  padding: 18px;
}

.viewer-topbar,
.metric-panel,
.viewer-empty {
  border: 1px solid var(--line);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.86);
}

.viewer-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 20px;
}

.viewer-title h1,
.metric-panel h2 {
  margin: 0;
}

.viewer-kicker {
  margin: 0 0 6px;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.76rem;
  color: var(--accent);
}

.viewer-subtitle,
.viewer-empty p {
  margin: 8px 0 0;
  color: var(--muted);
}

.viewer-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.viewer-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) 340px;
  grid-template-rows: minmax(0, 1fr);
  gap: 18px;
  min-height: 0;
  overflow: hidden;
}

.viewer-stage {
  position: relative;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 24px;
  background:
    linear-gradient(180deg, rgba(247, 251, 255, 0.96), rgba(227, 238, 250, 0.94)),
    radial-gradient(circle at center, rgba(76, 154, 255, 0.12), transparent 60%);
  outline: none;
  touch-action: none;
}

.viewer-stage:focus {
  border-color: var(--line-strong);
  box-shadow: 0 0 0 3px rgba(76, 154, 255, 0.18);
}

.viewer-video {
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
  display: block;
  background: #dfeaf7;
  touch-action: none;
}

.keyboard-proxy {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  top: -100px;
  left: -100px;
}

.viewer-video--interactive {
  cursor: none;
}

.cursor-overlay {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 10;
  will-change: transform;
}

.cursor-overlay--touch {
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 179, 71, 0.9);
  background: rgba(255, 179, 71, 0.15);
  box-shadow: 0 0 0 4px rgba(255, 179, 71, 0.12);
}

.cursor-overlay--pointer {
  width: 18px;
  height: 18px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'%3E%3Cpath d='M2 2l5.5 13 2-5.5L15 7.5z' fill='white' stroke='%23333' stroke-width='1'/%3E%3C/svg%3E") no-repeat top left / contain;
}

.viewer-live-pill,
.metric-grid dt {
  color: var(--muted);
}

.viewer-live-pill {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 9;
  pointer-events: none;
  border: 1px solid rgba(46, 108, 181, 0.16);
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 0.76rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.84);
}

.viewer-sidebar {
  display: grid;
  gap: 18px;
  align-content: start;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}

.metric-panel {
  padding: 18px;
}

.metric-grid {
  display: grid;
  grid-template-columns: minmax(0, 110px) 1fr;
  gap: 10px 14px;
  margin: 16px 0 0;
}

.metric-grid dt,
.metric-grid dd {
  margin: 0;
}

.metric-grid dd {
  word-break: break-word;
}

.badge {
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 0.84rem;
}

.badge--success {
  background: rgba(14, 159, 110, 0.12);
  color: #074734;
}

.badge--info {
  background: rgba(76, 154, 255, 0.14);
  color: #0d376d;
}

.badge--warning {
  background: rgba(216, 138, 22, 0.14);
  color: #5e3a00;
}

.badge--muted {
  background: rgba(223, 234, 248, 0.9);
  color: var(--muted);
}

.ghost-button {
  border-radius: 999px;
  padding: 12px 18px;
  background: rgba(226, 238, 252, 0.9);
  color: var(--text);
  border: 1px solid rgba(46, 108, 181, 0.12);
}

.error-banner {
  margin: 16px 0 0;
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(204, 65, 93, 0.1);
  color: #5f1324;
}

.viewer-empty {
  padding: 22px;
}

@media (max-width: 1100px) {
  .viewer-layout {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .viewer-topbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .viewer-stage {
    height: auto;
    aspect-ratio: 16 / 9;
    max-height: min(56dvh, 560px);
  }

  .viewer-sidebar {
    overflow: visible;
    padding-right: 0;
  }
}

@media (max-width: 760px), (max-height: 760px) {
  .viewer-shell {
    border-radius: 18px;
    padding: 12px;
    gap: 12px;
  }

  .viewer-topbar {
    padding: 14px;
    border-radius: 16px;
    gap: 10px;
  }

  .viewer-stage {
    border-radius: 16px;
    max-height: min(50dvh, 420px);
  }

  .viewer-actions {
    width: 100%;
  }

  .ghost-button {
    padding: 10px 14px;
  }
}
</style>
