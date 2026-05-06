import { computed, onBeforeUnmount, proxyRefs, reactive, ref, watch } from 'vue'

const TERMINAL_SESSION_STATUSES = new Set([
  'rejected',
  'failed',
  'terminated',
  'expired',
  'ended',
])

const SESSION_EVENT_TO_STATUS = {
  'remote.desktop.session.requested': 'requested',
  'remote.desktop.session.accepted': 'accepted',
  'remote.desktop.session.rejected': 'rejected',
  'remote.desktop.session.failed': 'failed',
  'remote.desktop.session.terminated': 'terminated',
  'remote.desktop.session.expired': 'expired',
}

const EXPECTED_TRANSPORT_TYPE = 'webrtc'

const SIGNALING_EVENT_NAMES = new Set([
  'remote.desktop.signaling.message',
  'remote.desktop.signaling',
  'remote_signaling',
  'remote_signaling.answer',
  'remote_signaling.ice_candidate',
  'remote-signaling',
])

function resolveEnvelope(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  return payload.data ?? payload
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function toIsoTime(date = new Date()) {
  return date.toISOString()
}

function normalizeSessionDescriptionSdp(sdp) {
  if (typeof sdp !== 'string') {
    return ''
  }

  const normalized = sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n')
  return normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`
}

function normalizeSocketPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  if (typeof payload.event === 'string') {
    return {
      event: payload.event,
      data: payload.data ?? {},
    }
  }

  const directSignalType = payload.data?.signal_type ?? payload.signal_type
  if (typeof directSignalType === 'string') {
    return {
      event: 'remote.desktop.signaling.message',
      data: payload.data?.signal_type ? payload.data : payload,
    }
  }

  const directStatus = payload.data?.status ?? payload.status
  const directConnectionState = payload.data?.connection_state ?? payload.connection_state
  if (typeof directStatus === 'string' || typeof directConnectionState === 'string') {
    return {
      event: 'remote.desktop.session.connection_state',
      data: payload.data?.status || payload.data?.connection_state ? payload.data : payload,
    }
  }

  return null
}

function summarizeSocketPayloadShape(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      kind: typeof payload,
      keys: [],
    }
  }

  return {
    kind: Array.isArray(payload) ? 'array' : 'object',
    keys: Object.keys(payload).slice(0, 12),
    hasEvent: typeof payload.event === 'string',
    hasDataObject: Boolean(payload.data && typeof payload.data === 'object'),
    signalType: payload.data?.signal_type ?? payload.signal_type ?? null,
    sessionId: payload.data?.session_id ?? payload.session_id ?? null,
  }
}

function createLogEntry(level, message, detail) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    message,
    detail,
    createdAt: toIsoTime(),
  }
}

function buildUrl(base, path) {
  if (!base) {
    return new URL(path, window.location.origin)
  }

  if (/^https?:\/\//i.test(base)) {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`
    return url
  }

  return new URL(base.startsWith('/') ? `${base.replace(/\/$/, '')}${path}` : path, window.location.origin)
}

function buildSocketUrl(path, sessionId, token) {
  const isAbsolute = /^wss?:\/\//i.test(path)
  const origin = isAbsolute
    ? new URL(path)
    : new URL(path.startsWith('/') ? path : `/${path}`, window.location.origin)

  if (!isAbsolute) {
    origin.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  }

  origin.searchParams.set('session_id', sessionId)
  if (token) {
    origin.searchParams.set('token', token)
  }

  return origin.toString()
}

export function useRemoteDesktopSimulator() {
  const config = reactive({
    apiBaseUrl: 'https://apidms.sentuhdigital.id/api/v1',
    wsPath: 'wss://apidms.sentuhdigital.id/ws/remote-desktop',
    accessToken: '',
    refreshToken: '',
    loginEmail: 'superadmin@sentuh.id',
    loginPassword: '12345678',
    deviceId: '',
    sessionId: '',
    timeoutSeconds: 1000,
    metadataSource: 'web',
    metadataPage: 'device-detail',
    reconnectSocket: true,
    autoConnectSocket: true,
    autoCreatePeerOnAccept: true,
    autoCreatePeerAfterSocketOpen: true,
    autoCreateOfferOnPeerReady: true,
    iceTransportPolicy: 'relay',
    iceServersJson: JSON.stringify([{ urls: 'stun:stun.l.google.com:19302' }], null, 2),
    turnUrlsJson: JSON.stringify(
      ['turn:turn-client.sentuhdigital.id:3478?transport=udp', 'turn:turn-client.sentuhdigital.id:3478?transport=tcp'],
      null,
      2,
    ),
    turnUsername: '',
    turnCredential: '',
    turnExpiresAt: '',
  })

  const status = reactive({
    currentStep: 'idle',
    sessionStatus: 'idle',
    transportType: '',
    socketStatus: 'idle',
    socketSessionId: '',
    peerStatus: 'idle',
    connectionState: 'new',
    signalingState: 'stable',
    iceGatheringState: 'new',
    controlChannelState: 'idle',
    requestState: 'idle',
    remoteStreamState: 'idle',
    hasRemoteDescription: false,
    pendingRemoteIceCount: 0,
    lastSignalType: '',
    turnRelayUsed: null,
    lastError: '',
    requestId: '',
    latestAnswerAt: '',
    latestOfferAt: '',
    wsMessageCount: 0,
    lastWsEventAt: '',
    lastWsRawPreview: '',
    authState: 'idle',
    devicesState: 'idle',
    turnState: 'idle',
    deleteSessionState: 'idle',
  })

  const session = ref(null)
  const logs = ref([])
  const remoteStageElement = ref(null)
  const remoteVideoElement = ref(null)
  const remoteStream = ref(null)
  const eventHistory = ref([])
  const socketRef = ref(null)
  const peerRef = ref(null)
  const controlChannelRef = ref(null)
  const reconnectTimer = ref(null)
  const lastMouseMoveSentAt = ref(0)
  const pendingRemoteIceCandidates = ref([])
  const activeSocketConnectPromise = ref(null)
  const signalingWatchdogTimer = ref(null)
  const videoTransceiverRef = ref(null)
  const statsPollTimer = ref(null)
  const previousInboundVideoStats = ref({
    bytesReceived: 0,
    framesDecoded: 0,
    timestamp: 0,
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
  const devices = ref([])

  const optimizeVideoElementForRealtimePlayback = (element) => {
    if (!element) {
      return
    }

    element.autoplay = true
    element.playsInline = true
    element.muted = true

    if ('disableRemotePlayback' in element) {
      element.disableRemotePlayback = true
    }
  }

  const optimizeReceiverForLowLatency = (receiver) => {
    if (!receiver) {
      return
    }

    try {
      if ('playoutDelayHint' in receiver) {
        receiver.playoutDelayHint = 0
      }
    } catch { }

    try {
      if ('jitterBufferTarget' in receiver) {
        receiver.jitterBufferTarget = 0
      }
    } catch { }
  }

  const optimizeTrackForRealtimePlayback = (track) => {
    if (!track) {
      return
    }

    try {
      if ('contentHint' in track) {
        track.contentHint = 'motion'
      }
    } catch { }
  }

  const addLog = (level, message, detail = null) => {
    logs.value = [createLogEntry(level, message, detail), ...logs.value].slice(0, 120)
  }

  const setError = (message, detail = null) => {
    status.lastError = message
    addLog('error', message, detail)
  }

  const clearError = () => {
    status.lastError = ''
  }

  const hasSession = computed(() => Boolean(config.sessionId))
  const isTerminal = computed(() => TERMINAL_SESSION_STATUSES.has(status.sessionStatus))
  const controlReady = computed(() => status.controlChannelState === 'open')
  const sessionPhase = computed(() => {
    if (isTerminal.value) {
      return status.sessionStatus
    }

    if (status.connectionState === 'connected' || status.sessionStatus === 'connected') {
      return 'connected'
    }

    if (
      status.connectionState === 'checking' ||
      status.currentStep === 'answer_received' ||
      status.currentStep === 'offer_sent' ||
      status.hasRemoteDescription
    ) {
      return 'connecting'
    }

    if (status.latestOfferAt || status.latestAnswerAt || status.currentStep === 'creating_peer') {
      return 'signaling'
    }

    if (status.sessionStatus === 'accepted') {
      return 'accepted'
    }

    return status.sessionStatus
  })
  const viewerReady = computed(() => {
    const transportReady =
      status.connectionState === 'connected' || status.sessionStatus === 'connected'

    return controlReady.value && transportReady
  })
  const canInteract = computed(() => viewerReady.value && status.remoteStreamState === 'active')
  const screenReady = computed(() => canInteract.value)
  const parsedIceServers = computed(() => parseIceServers())
  const iceConfigSummary = computed(() => {
    const servers = parsedIceServers.value
    const urls = servers.flatMap((server) => {
      if (!server || typeof server !== 'object') {
        return []
      }

      const value = server.urls
      if (Array.isArray(value)) {
        return value.filter((url) => typeof url === 'string')
      }

      return typeof value === 'string' ? [value] : []
    })

    const hasTurn = urls.some((url) => /^turns?:/i.test(url))
    const hasStun = urls.some((url) => /^stuns?:/i.test(url))

    return {
      serverCount: servers.length,
      urlCount: urls.length,
      hasTurn,
      hasStun,
      mode: hasTurn ? 'stun+turn' : hasStun ? 'stun-only' : 'custom',
    }
  })

  watch(remoteVideoElement, (element) => {
    if (!element) {
      return
    }

    optimizeVideoElementForRealtimePlayback(element)
    element.srcObject = remoteStream.value
    if (remoteStream.value) {
      element.play().catch(() => { })
    }
  })

  watch(remoteStream, (stream) => {
    if (!remoteVideoElement.value) {
      return
    }

    optimizeVideoElementForRealtimePlayback(remoteVideoElement.value)
    remoteVideoElement.value.srcObject = stream
    if (stream) {
      remoteVideoElement.value.play().catch(() => { })
    }
  })

  const syncSession = (payload) => {
    if (!payload) {
      return
    }

    const next = {
      ...(session.value ?? {}),
      ...payload,
    }

    session.value = next
    config.sessionId = next.session_id ?? next.sessionId ?? config.sessionId
    status.sessionStatus = next.status ?? status.sessionStatus
    status.transportType = next.metadata?.transport_type ?? next.transport_type ?? status.transportType
  }

  const ensureWebRtcTransport = (payload, { strict = false } = {}) => {
    const transportType = payload?.metadata?.transport_type ?? payload?.transport_type ?? status.transportType ?? ''

    if (!transportType) {
      if (strict) {
        addLog('warning', 'Response session belum menyertakan metadata.transport_type.', {
          expectedTransportType: EXPECTED_TRANSPORT_TYPE,
        })
      }
      return
    }

    if (transportType !== EXPECTED_TRANSPORT_TYPE) {
      throw new Error(
        `Simulator ini hanya mendukung transport ${EXPECTED_TRANSPORT_TYPE}, tetapi backend mengembalikan ${transportType}.`,
      )
    }
  }

  const parseIceServers = () => {
    const parsed = parseJson(config.iceServersJson, [])
    return Array.isArray(parsed) ? parsed : []
  }

  const normalizeDeviceOptions = (items) => {
    if (!Array.isArray(items)) {
      return []
    }

    return items
      .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        name: item.name ?? item.hostname ?? item.serial_number ?? item.id,
        status: item.status ?? 'unknown',
        deviceType: item.device_type ?? '-',
        tenantId: item.tenant_id ?? '-',
        ipAddress: item.ip_address ?? item.health?.ip_address ?? '-',
        signalStrengthPercent: item.health?.signal_strength_percent ?? null,
        networkType: item.health?.network_type ?? null,
        hasTouchscreen: item.has_touchscreen === true,
        raw: item,
      }))
  }

  const hasTouchscreenForSelectedDevice = () => {
    const device = devices.value.find((d) => d.id === config.deviceId)
    return device?.hasTouchscreen ?? false
  }

  const normalizeIceTransportPolicy = () => {
    const value = typeof config.iceTransportPolicy === 'string' ? config.iceTransportPolicy.trim().toLowerCase() : '';
    return value === 'all' ? 'all' : 'relay';
  }
  const buildStunOnlyIceServers = () => [{ urls: 'stun:stun.l.google.com:19302' }]

  const applyStunOnlyPreset = () => {
    config.iceServersJson = JSON.stringify(buildStunOnlyIceServers(), null, 2);
    config.iceTransportPolicy = 'all';
    addLog('info', 'Preset ICE STUN-only diterapkan ke simulator.', {
      mode: 'stun-only',
      iceTransportPolicy: config.iceTransportPolicy,
    });
  }

  const applyTurnPreset = () => {
    const turnUrls = parseJson(config.turnUrlsJson, []);
    const urls = Array.isArray(turnUrls) ? turnUrls.filter((url) => typeof url === 'string' && url.trim()) : [];

    if (urls.length === 0) {
      setError('TURN URLs JSON belum valid. Isi array URL TURN dulu.');
      return;
    }

    if (!config.turnUsername || !config.turnCredential) {
      setError('TURN username dan credential wajib diisi sebelum menerapkan preset TURN.');
      return;
    }

    config.iceServersJson = JSON.stringify(
      [
        ...buildStunOnlyIceServers(),
        {
          urls,
          username: config.turnUsername,
          credential: config.turnCredential,
        },
      ],
      null,
      2,
    );
    config.iceTransportPolicy = 'relay';

    addLog('info', 'Preset ICE STUN + TURN diterapkan ke simulator.', {
      mode: 'stun+turn',
      turnUrlCount: urls.length,
      turnExpiresAt: config.turnExpiresAt || null,
      iceTransportPolicy: config.iceTransportPolicy,
    });
  }
  const syncRemoteDescriptionFlag = () => {
    status.hasRemoteDescription = Boolean(peerRef.value?.remoteDescription)
  }

  const updatePendingRemoteIceCount = () => {
    status.pendingRemoteIceCount = pendingRemoteIceCandidates.value.length
  }

  const clearSignalingWatchdog = () => {
    window.clearTimeout(signalingWatchdogTimer.value)
    signalingWatchdogTimer.value = null
  }

  const resetStats = () => {
    previousInboundVideoStats.value = {
      bytesReceived: 0,
      framesDecoded: 0,
      timestamp: 0,
    }
    stats.fps = null
    stats.bitrateKbps = null
    stats.packetsLost = null
    stats.jitterMs = null
    stats.roundTripTimeMs = null
    stats.availableOutgoingBitrateKbps = null
    stats.frameWidth = null
    stats.frameHeight = null
    stats.qualityLabel = 'offline'
    stats.updatedAt = ''
  }

  const generateAccessToken = async () => {
    clearError()
    status.authState = 'loading'

    try {
      const url = buildUrl(config.apiBaseUrl, '/auth/login')
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: config.loginEmail,
          password: config.loginPassword,
        }),
      })

      const payload = await response.json().catch(() => ({}))
      status.requestId = payload?.request_id ?? status.requestId

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Gagal login untuk generate access token.')
      }

      const data = resolveEnvelope(payload)
      const accessToken = data?.access_Token ?? data?.access_token ?? ''
      const refreshToken = data?.refresh_token ?? ''

      if (!accessToken) {
        throw new Error('Response login tidak mengandung access token.')
      }

      config.accessToken = accessToken
      config.refreshToken = refreshToken
      status.authState = 'success'
      addLog('success', 'Access token berhasil di-generate dari API login.', {
        email: config.loginEmail,
        hasRefreshToken: Boolean(refreshToken),
      })

      await loadDevices()
      return accessToken
    } catch (error) {
      status.authState = 'error'
      setError(error.message, { requestId: status.requestId })
      return null
    }
  }

  const loadDevices = async () => {
    clearError()

    if (!config.accessToken) {
      status.devicesState = 'error'
      setError('Generate access token dulu sebelum mengambil daftar device.')
      return []
    }

    status.devicesState = 'loading'

    try {
      const url = buildUrl(config.apiBaseUrl, '/devices/')
      url.searchParams.set('limit', '100')
      url.searchParams.set('offset', '0')

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
        },
      })

      const payload = await response.json().catch(() => ({}))
      status.requestId = payload?.request_id ?? status.requestId

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Gagal mengambil daftar device.')
      }

      const items = normalizeDeviceOptions(resolveEnvelope(payload))
      devices.value = items
      status.devicesState = 'success'

      if (!config.deviceId && items.length > 0) {
        config.deviceId = items[0].id
      }

      addLog('success', 'Daftar device berhasil dimuat.', {
        count: items.length,
      })
      return items
    } catch (error) {
      status.devicesState = 'error'
      devices.value = []
      setError(error.message, { requestId: status.requestId })
      return []
    }
  }

  const loadTurnCredentials = async () => {
    clearError()

    if (!config.accessToken) {
      status.turnState = 'error'
      setError('Generate access token dulu sebelum mengambil credential TURN.')
      return null
    }

    status.turnState = 'loading'

    try {
      const url = buildUrl(config.apiBaseUrl, '/remote-desktop/ice-servers')
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.accessToken}`,
        },
      })

      const payload = await response.json().catch(() => ({}))
      status.requestId = payload?.request_id ?? status.requestId

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Gagal mengambil credential TURN.')
      }

      const data = resolveEnvelope(payload)
      const firstTurnServer = Array.isArray(data?.ice_servers) ? data.ice_servers[0] : null
      const turnUrls = Array.isArray(firstTurnServer?.urls) ? firstTurnServer.urls : []

      if (turnUrls.length === 0 || !firstTurnServer?.username || !firstTurnServer?.credential) {
        throw new Error('Response ICE server tidak lengkap untuk credential TURN.')
      }

      config.turnUrlsJson = JSON.stringify(turnUrls, null, 2)
      config.turnUsername = firstTurnServer.username
      config.turnCredential = firstTurnServer.credential
      config.turnExpiresAt = data?.expires_at ?? ''
      status.turnState = 'success'

      console.log('[remote-desktop] TURN credentials loaded:', {
        urls: turnUrls,
        username: config.turnUsername,
        credential: config.turnCredential,
        expiresAt: config.turnExpiresAt || null,
      })

      addLog('success', 'Credential TURN berhasil dimuat dari backend.', {
        turnUrlCount: turnUrls.length,
        turnExpiresAt: config.turnExpiresAt || null,
      })

      return {
        urls: turnUrls,
        username: firstTurnServer.username,
        credential: firstTurnServer.credential,
        expiresAt: config.turnExpiresAt,
      }
    } catch (error) {
      status.turnState = 'error'
      setError(error.message, { requestId: status.requestId })
      return null
    }
  }

  const classifyQualityLabel = () => {
    if (!screenReady.value) {
      return status.connectionState === 'connected' ? 'warming up' : 'offline'
    }

    const fps = stats.fps ?? 0
    const rtt = stats.roundTripTimeMs ?? 0
    const bitrate = stats.bitrateKbps ?? 0

    if (fps >= 20 && rtt > 0 && rtt <= 120 && bitrate >= 1800) {
      return 'strong'
    }

    if (fps >= 10 && rtt <= 250 && bitrate >= 700) {
      return 'stable'
    }

    return 'weak'
  }

  const stopStatsPolling = () => {
    window.clearInterval(statsPollTimer.value)
    statsPollTimer.value = null
  }

  const collectPeerStats = async () => {
    const peer = peerRef.value
    if (!peer || typeof peer.getStats !== 'function') {
      resetStats()
      return
    }

    try {
      const reports = await peer.getStats()
      let inboundVideoReport = null
      let trackReport = null
      let selectedCandidatePair = null

      reports.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          inboundVideoReport = report
        }

        if (report.type === 'track' && report.kind === 'video') {
          trackReport = report
        }

        if (report.type === 'candidate-pair' && (report.nominated || report.selected)) {
          selectedCandidatePair = report
        }
      })

      if (inboundVideoReport) {
        const previous = previousInboundVideoStats.value
        const elapsedMs = previous.timestamp ? inboundVideoReport.timestamp - previous.timestamp : 0
        const bytesDelta = inboundVideoReport.bytesReceived - previous.bytesReceived
        const framesDelta = inboundVideoReport.framesDecoded - previous.framesDecoded

        if (elapsedMs > 0) {
          stats.bitrateKbps = Number((((bytesDelta * 8) / elapsedMs) * 1000 / 1024).toFixed(1))
          stats.fps = Number(((framesDelta * 1000) / elapsedMs).toFixed(1))
        } else {
          stats.bitrateKbps = typeof inboundVideoReport.bytesReceived === 'number' ? 0 : null
          stats.fps = typeof inboundVideoReport.framesPerSecond === 'number'
            ? Number(inboundVideoReport.framesPerSecond.toFixed(1))
            : null
        }

        stats.packetsLost = inboundVideoReport.packetsLost ?? null
        stats.jitterMs = typeof inboundVideoReport.jitter === 'number'
          ? Number((inboundVideoReport.jitter * 1000).toFixed(1))
          : null

        previousInboundVideoStats.value = {
          bytesReceived: inboundVideoReport.bytesReceived ?? 0,
          framesDecoded: inboundVideoReport.framesDecoded ?? 0,
          timestamp: inboundVideoReport.timestamp ?? 0,
        }
      }

      if (trackReport) {
        stats.frameWidth = trackReport.frameWidth ?? null
        stats.frameHeight = trackReport.frameHeight ?? null
      }

      if (selectedCandidatePair) {
        stats.roundTripTimeMs = typeof selectedCandidatePair.currentRoundTripTime === 'number'
          ? Number((selectedCandidatePair.currentRoundTripTime * 1000).toFixed(1))
          : null
        stats.availableOutgoingBitrateKbps = typeof selectedCandidatePair.availableOutgoingBitrate === 'number'
          ? Number((selectedCandidatePair.availableOutgoingBitrate / 1024).toFixed(1))
          : null
      }

      stats.updatedAt = toIsoTime()
      stats.qualityLabel = classifyQualityLabel()
    } catch (error) {
      addLog('warning', 'Gagal mengambil statistik peer.', { message: error.message })
    }
  }

  const startStatsPolling = () => {
    if (statsPollTimer.value) {
      return
    }

    collectPeerStats()
    statsPollTimer.value = window.setInterval(() => {
      collectPeerStats()
    }, 1000)
  }

  const getStatsSnapshot = () => ({
    fps: stats.fps,
    bitrateKbps: stats.bitrateKbps,
    packetsLost: stats.packetsLost,
    jitterMs: stats.jitterMs,
    roundTripTimeMs: stats.roundTripTimeMs,
    availableOutgoingBitrateKbps: stats.availableOutgoingBitrateKbps,
    frameWidth: stats.frameWidth,
    frameHeight: stats.frameHeight,
    qualityLabel: stats.qualityLabel,
    updatedAt: stats.updatedAt,
  })

  const getStatusSnapshot = () => ({
    sessionStatus: status.sessionStatus,
    socketStatus: status.socketStatus,
    peerStatus: status.peerStatus,
    connectionState: status.connectionState,
    controlChannelState: status.controlChannelState,
    remoteStreamState: status.remoteStreamState,
    currentStep: status.currentStep,
    lastError: status.lastError,
    viewerReady: viewerReady.value,
    screenReady: screenReady.value,
    canInteract: canInteract.value,
    sessionId: config.sessionId,
    deviceId: config.deviceId,
    hasTouchscreen: hasTouchscreenForSelectedDevice(),
  })

  const attachViewerElements = ({ stageElement = null, videoElement = null } = {}) => {
    remoteStageElement.value = stageElement
    remoteVideoElement.value = videoElement

    if (videoElement && remoteStream.value) {
      optimizeVideoElementForRealtimePlayback(videoElement)
      videoElement.srcObject = remoteStream.value
      videoElement.play().catch(() => { })
    }
  }

  const detachViewerElements = () => {
    if (remoteVideoElement.value) {
      remoteVideoElement.value.srcObject = null
    }

    remoteStageElement.value = null
    remoteVideoElement.value = null
  }

  const registerWindowBridge = () => {
    window.__remoteDesktopSimulatorBridge = {
      attachViewerElements,
      detachViewerElements,
      focusRemoteStage,
      handleKeyboard,
      handleTextInput,
      handleMouseButton,
      handleMouseMove,
      handleTouchStart,
      handleTouchMove,
      handleTouchEnd,
      handleWheel,
      getStatsSnapshot,
      getStatusSnapshot,
      getRemoteStream: () => remoteStream.value,
    }
  }

  const armSignalingWatchdog = (context = {}) => {
    clearSignalingWatchdog()

    signalingWatchdogTimer.value = window.setTimeout(() => {
      if (status.latestAnswerAt) {
        return
      }

      addLog('warning', 'Session sudah accepted, tapi signaling answer/ICE belum terlihat di FE.', {
        sessionId: config.sessionId,
        currentStep: status.currentStep,
        lastSignalType: status.lastSignalType,
        wsMessageCount: status.wsMessageCount,
        lastWsEventAt: status.lastWsEventAt,
        lastWsRawPreview: status.lastWsRawPreview,
        context,
      })
    }, 5000)
  }

  const queueRemoteIceCandidate = (candidate) => {
    pendingRemoteIceCandidates.value = [...pendingRemoteIceCandidates.value, candidate].slice(-40)
    updatePendingRemoteIceCount()
    addLog('warning', 'Remote ICE candidate disimpan dulu sampai answer terpasang.', {
      pendingCount: pendingRemoteIceCandidates.value.length,
      candidate,
    })
  }

  const flushPendingRemoteIceCandidates = async () => {
    if (!peerRef.value?.remoteDescription || pendingRemoteIceCandidates.value.length === 0) {
      return
    }

    const queuedCandidates = [...pendingRemoteIceCandidates.value]
    pendingRemoteIceCandidates.value = []
    updatePendingRemoteIceCount()
    addLog('info', 'Memproses remote ICE candidate yang sempat tertunda.', {
      count: queuedCandidates.length,
    })

    for (const candidate of queuedCandidates) {
      await handleIncomingIceCandidate(candidate)
    }
  }

  const resetSessionRuntimeState = ({ preserveSessionId = false } = {}) => {
    clearSignalingWatchdog()
    pendingRemoteIceCandidates.value = []
    updatePendingRemoteIceCount()
    status.hasRemoteDescription = false
    status.lastSignalType = ''
    status.latestOfferAt = ''
    status.latestAnswerAt = ''
    status.turnRelayUsed = null
    if (!preserveSessionId) {
      status.socketSessionId = ''
      config.sessionId = ''
      session.value = null
    }
  }

  const sendSocketEvent = (event, data) => {
    if (!socketRef.value || socketRef.value.readyState !== WebSocket.OPEN) {
      setError('WebSocket belum terhubung, event belum bisa dikirim.', { event, data })
      return false
    }

    socketRef.value.send(
      JSON.stringify({
        event,
        data,
      }),
    )
    addLog('out', `WS -> ${event}`, data)
    return true
  }

  const sendControlEvent = (payload) => {
    if (!controlChannelRef.value || controlChannelRef.value.readyState !== 'open') {
      return false
    }

    controlChannelRef.value.send(JSON.stringify(payload))
    addLog('control', `DC -> ${payload.type}`, payload)
    return true
  }

  const focusRemoteStage = () => {
    remoteStageElement.value?.focus?.()
  }

  const handleIncomingIceCandidate = async (candidate) => {
    if (!peerRef.value || !candidate) {
      return
    }

    if (!peerRef.value.remoteDescription) {
      queueRemoteIceCandidate(candidate)
      return
    }

    try {
      await peerRef.value.addIceCandidate(
        new RTCIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdp_mid ?? candidate.sdpMid,
          sdpMLineIndex: candidate.sdp_mline_index ?? candidate.sdpMLineIndex,
        }),
      )
      addLog('info', 'Remote ICE candidate berhasil ditambahkan.', candidate)
    } catch (error) {
      setError('Gagal menambahkan remote ICE candidate.', {
        message: error.message,
        candidate,
      })
    }
  }

  const handleIncomingAnswer = async (sdp) => {
    if (!peerRef.value || !sdp) {
      return
    }

    const peer = peerRef.value
    const normalizedSdp = normalizeSessionDescriptionSdp(sdp)
    const remoteDescription = peer.remoteDescription

    console.log('[remote-desktop] incoming answer SDP (raw):', sdp)
    console.log('[remote-desktop] incoming answer SDP (normalized):', normalizedSdp)
    console.log('[remote-desktop] incoming answer SDP meta (raw):', {
      length: sdp.length,
      hasTrailingCrlf: sdp.endsWith('\r\n'),
    })
    console.log('[remote-desktop] incoming answer SDP meta (normalized):', {
      length: normalizedSdp.length,
      hasTrailingCrlf: normalizedSdp.endsWith('\r\n'),
    })

    if (remoteDescription?.type === 'answer' && remoteDescription.sdp === normalizedSdp) {
      addLog('warning', 'Answer duplikat diterima, pemasangan ulang dilewati.')
      return
    }

    try {
      if (peer.signalingState !== 'have-local-offer') {
        addLog('warning', 'Answer datang saat peer belum siap menerima answer.', {
          signalingState: peer.signalingState,
          hasLocalDescription: Boolean(peer.localDescription),
          hasRemoteDescription: Boolean(peer.remoteDescription),
        })
      }

      if (normalizedSdp !== sdp) {
        addLog('info', 'SDP answer dinormalisasi sebelum dipasang ke peer connection.', {
          rawLength: sdp.length,
          normalizedLength: normalizedSdp.length,
          hadTrailingCrlf: sdp.endsWith('\r\n'),
        })
      }

      await peer.setRemoteDescription(
        new RTCSessionDescription({
          type: 'answer',
          sdp: normalizedSdp,
        }),
      )
      status.latestAnswerAt = toIsoTime()
      status.currentStep = 'answer_received'
      syncRemoteDescriptionFlag()
      addLog('info', 'Remote answer berhasil dipasang ke peer connection.')
      await flushPendingRemoteIceCandidates()
    } catch (error) {
      setError('Gagal memasang remote answer.', {
        message: error.message,
        signalingState: peer.signalingState,
        localDescriptionType: peer.localDescription?.type ?? null,
        remoteDescriptionType: peer.remoteDescription?.type ?? null,
        sdpLength: typeof sdp === 'string' ? sdp.length : null,
        normalizedSdpLength: normalizedSdp.length,
        hadTrailingCrlf: typeof sdp === 'string' ? sdp.endsWith('\r\n') : null,
      })
    }
  }

  const updatePeerState = () => {
    const peer = peerRef.value
    if (!peer) {
      return
    }

    status.connectionState = peer.connectionState
    status.signalingState = peer.signalingState
    status.iceGatheringState = peer.iceGatheringState
    syncRemoteDescriptionFlag()
  }

  const attachDataChannel = (channel, { role = 'control', replaceExisting = true } = {}) => {
    if (!channel) {
      return
    }

    if (
      !replaceExisting &&
      controlChannelRef.value &&
      controlChannelRef.value !== channel &&
      controlChannelRef.value.readyState !== 'closed'
    ) {
      addLog('info', 'Datachannel tambahan diterima, binding channel aktif dipertahankan.', {
        label: channel.label,
        role,
        existingLabel: controlChannelRef.value.label,
        existingReadyState: controlChannelRef.value.readyState,
      })
      return
    }

    controlChannelRef.value = channel
    status.controlChannelState = channel.readyState
    addLog('info', 'Binding datachannel control.', {
      label: channel.label,
      readyState: channel.readyState,
      role,
    })

    channel.onopen = () => {
      status.controlChannelState = channel.readyState
      addLog('success', 'Datachannel control terbuka.')
      sendControlEvent({
        type: 'control.ready',
        timestamp: Date.now(),
      })
    }

    channel.onclose = () => {
      status.controlChannelState = channel.readyState
      addLog('warning', 'Datachannel control tertutup.')
    }

    channel.onerror = (event) => {
      status.controlChannelState = channel.readyState
      setError('Datachannel control error.', event)
    }

    channel.onmessage = (event) => {
      addLog('in', 'DC <- message', event.data)
    }
  }

  const createPeerConnection = async () => {
    if (peerRef.value) {
      addLog('info', 'Peer connection sudah ada, setup dilewati.')
      return peerRef.value
    }

    clearError()
    status.peerStatus = 'creating'
    status.currentStep = 'creating_peer'

    try {
      console.log('[remote-desktop] creating peer with ICE servers:', parseIceServers())
      console.log('[remote-desktop] current TURN fields:', {
        username: config.turnUsername,
        credential: config.turnCredential,
        expiresAt: config.turnExpiresAt || null,
      })

      const peer = new RTCPeerConnection({
        iceServers: parseIceServers(),
        iceTransportPolicy: normalizeIceTransportPolicy(),
      })

      addLog('info', 'Peer connection dibuat dengan konfigurasi ICE.', {
        iceTransportPolicy: normalizeIceTransportPolicy(),
        iceServerCount: parseIceServers().length,
      })

      if (typeof peer.addTransceiver === 'function') {
        videoTransceiverRef.value = peer.addTransceiver('video', {
          direction: 'recvonly',
        })
        addLog('info', 'Transceiver video recvonly ditambahkan ke peer connection.')
      }

      peer.onicecandidate = (event) => {
        if (!event.candidate) {
          addLog('info', 'ICE gathering selesai.')
          return
        }

        sendSocketEvent('remote_signaling.ice_candidate', {
          session_id: config.sessionId,
          device_id: config.deviceId,
          candidate: {
            candidate: event.candidate.candidate,
            sdp_mid: event.candidate.sdpMid,
            sdp_mline_index: event.candidate.sdpMLineIndex,
          },
        })
      }

      peer.ontrack = (event) => {
        optimizeTrackForRealtimePlayback(event.track)
        optimizeReceiverForLowLatency(event.receiver)
        remoteStream.value = event.streams[0] ?? new MediaStream([event.track])
        status.remoteStreamState = event.track.muted ? 'pending_media' : 'active'
        status.currentStep = event.track.muted ? 'track_received' : 'screen_live'
        addLog('success', 'Remote track diterima dan dipasang ke elemen video.', {
          kind: event.track.kind,
          streamId: remoteStream.value?.id,
          muted: event.track.muted,
          contentHint: event.track.contentHint ?? null,
          playoutDelayHint: event.receiver?.playoutDelayHint ?? null,
        })

        event.track.onunmute = () => {
          status.remoteStreamState = 'active'
          status.currentStep = 'screen_live'
          addLog('success', 'Track video mulai mengalir dan frame pertama siap dirender.', {
            kind: event.track.kind,
            streamId: remoteStream.value?.id,
          })
        }

        event.track.onmute = () => {
          status.remoteStreamState = 'pending_media'
          addLog('warning', 'Track remote sedang mute, frame video berhenti sementara.', {
            kind: event.track.kind,
            streamId: remoteStream.value?.id,
          })
        }

        event.track.onended = () => {
          status.remoteStreamState = 'ended'
          addLog('warning', 'Track remote berakhir.', {
            kind: event.track.kind,
            streamId: remoteStream.value?.id,
          })
        }
      }

      peer.onconnectionstatechange = () => {
        updatePeerState()
        addLog('info', `Peer connection state -> ${peer.connectionState}`)
        if (peer.connectionState === 'connected') {
          status.sessionStatus = 'connected'
        }
      }

      peer.onsignalingstatechange = () => {
        updatePeerState()
        addLog('info', `Signaling state -> ${peer.signalingState}`)
      }

      peer.onicegatheringstatechange = () => {
        updatePeerState()
      }

      peer.ondatachannel = (event) => {
        const isPrimaryControlChannel =
          event.channel.label === 'control' &&
          (!controlChannelRef.value || controlChannelRef.value.readyState === 'closed')

        addLog(
          'info',
          isPrimaryControlChannel
            ? `Remote datachannel control diterima: ${event.channel.label}`
            : `Remote datachannel tambahan diterima: ${event.channel.label}`,
        )
        attachDataChannel(event.channel, {
          role: isPrimaryControlChannel ? 'remote-primary' : 'remote-secondary',
          replaceExisting: isPrimaryControlChannel,
        })
      }

      // FE owns the primary control datachannel per protocol contract.
      const controlChannel = peer.createDataChannel('control', {
        ordered: true,
      })
      attachDataChannel(controlChannel, {
        role: 'local-primary',
      })

      peerRef.value = peer
      startStatsPolling()
      updatePeerState()
      status.peerStatus = 'ready'
      addLog('success', 'Peer connection berhasil dibuat.')

      if (config.autoCreateOfferOnPeerReady) {
        await createAndSendOffer()
      }

      return peer
    } catch (error) {
      status.peerStatus = 'failed'
      setError('Gagal membuat RTCPeerConnection.', { message: error.message })
      return null
    }
  }

  const createAndSendOffer = async () => {
    clearError()

    if (!peerRef.value) {
      await createPeerConnection()
    }

    if (!peerRef.value) {
      return
    }

    try {
      status.currentStep = 'creating_offer'
      const offer = await peerRef.value.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: true,
      })

      await peerRef.value.setLocalDescription(offer)
      status.latestOfferAt = toIsoTime()
      addLog('success', 'Offer berhasil dibuat.', offer.sdp)
      console.log('[remote-desktop] local offer SDP:', offer.sdp)
      console.log('[remote-desktop] localDescription SDP:', peerRef.value.localDescription?.sdp ?? null)
      console.log('[remote-desktop] local offer SDP meta:', {
        length: offer.sdp?.length ?? 0,
        hasTrailingCrlf: offer.sdp?.endsWith('\r\n') ?? false,
      })
      console.log('[remote-desktop] localDescription SDP meta:', {
        length: peerRef.value.localDescription?.sdp?.length ?? 0,
        hasTrailingCrlf: peerRef.value.localDescription?.sdp?.endsWith('\r\n') ?? false,
      })

      sendSocketEvent('remote_signaling.offer', {
        session_id: config.sessionId,
        device_id: config.deviceId,
        sdp: offer.sdp,
      })

      status.currentStep = 'offer_sent'
    } catch (error) {
      setError('Gagal membuat atau mengirim offer.', { message: error.message })
    }
  }

  const routeSocketEvent = async (payload) => {
    const eventName = payload?.event
    const data = payload?.data ?? {}
    if (!eventName) {
      return
    }

    eventHistory.value = [{ event: eventName, data, at: toIsoTime() }, ...eventHistory.value].slice(0, 80)
    addLog('in', `WS <- ${eventName}`, data)
    status.lastSignalType = data.signal_type ?? eventName
    addLog('info', 'Event WebSocket masuk ke router.', {
      eventName,
      signalType: data.signal_type ?? null,
      sessionId: data.session_id ?? config.sessionId,
    })

    if (SESSION_EVENT_TO_STATUS[eventName]) {
      status.sessionStatus = SESSION_EVENT_TO_STATUS[eventName]
    }

    if (eventName === 'remote.desktop.session.accepted') {
      syncSession({ ...data, status: 'accepted' })
      status.currentStep = 'session_accepted'
      armSignalingWatchdog({
        source: 'session.accepted',
        acceptedAt: data.accepted_at ?? null,
      })
      if (config.autoCreatePeerOnAccept) {
        await createPeerConnection()
      }
      return
    }

    if (SIGNALING_EVENT_NAMES.has(eventName) || typeof data.signal_type === 'string') {
      addLog('info', 'Pesan signaling terdeteksi di WebSocket.', {
        eventName,
        signalType: data.signal_type ?? null,
        sessionId: data.session_id ?? null,
      })

      if (data.signal_type === 'answer' || data.signal_type === 'ice_candidate') {
        clearSignalingWatchdog()
      }

      if (data.signal_type === 'answer') {
        await handleIncomingAnswer(data.sdp)
      }

      if (data.signal_type === 'ice_candidate') {
        await handleIncomingIceCandidate(data.candidate)
      }
      return
    }

    if (eventName === 'remote.desktop.session.connection_state') {
      status.sessionStatus = data.status ?? status.sessionStatus
      status.connectionState = data.connection_state ?? status.connectionState
      status.signalingState = data.signaling_state ?? status.signalingState
      status.turnRelayUsed = data.turn_relay_used ?? status.turnRelayUsed
      return
    }

    if (eventName === 'remote.desktop.session.requested') {
      syncSession({ ...data, status: 'requested' })
      return
    }

    if (eventName === 'remote.desktop.session.rejected' || eventName === 'remote.desktop.session.failed') {
      setError(data.reason ?? `Session berakhir dengan status ${status.sessionStatus}.`, data)
      cleanupPeerConnection()
      return
    }

    if (eventName === 'remote.desktop.session.terminated' || eventName === 'remote.desktop.session.expired') {
      cleanupPeerConnection()
    }
  }

  const cleanupSocket = (options = {}) => {
    window.clearTimeout(reconnectTimer.value)
    reconnectTimer.value = null
    clearSignalingWatchdog()

    const socket = socketRef.value
    socketRef.value = null
    activeSocketConnectPromise.value = null

    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(options.code ?? 1000, options.reason ?? 'cleanup')
      }
    }

    status.socketStatus = 'closed'
    status.socketSessionId = ''
  }

  const cleanupPeerConnection = () => {
    stopStatsPolling()
    resetStats()

    if (controlChannelRef.value) {
      controlChannelRef.value.onopen = null
      controlChannelRef.value.onclose = null
      controlChannelRef.value.onerror = null
      controlChannelRef.value.onmessage = null
      if (controlChannelRef.value.readyState === 'open') {
        controlChannelRef.value.close()
      }
      controlChannelRef.value = null
    }

    if (peerRef.value) {
      peerRef.value.onicecandidate = null
      peerRef.value.ontrack = null
      peerRef.value.onconnectionstatechange = null
      peerRef.value.onsignalingstatechange = null
      peerRef.value.ondatachannel = null
      peerRef.value.close()
      peerRef.value = null
    }

    videoTransceiverRef.value = null

    status.peerStatus = 'idle'
    status.connectionState = 'closed'
    status.signalingState = 'closed'
    status.iceGatheringState = 'complete'
    status.controlChannelState = 'closed'
    status.remoteStreamState = remoteStream.value ? 'paused' : 'idle'
    syncRemoteDescriptionFlag()
    pendingRemoteIceCandidates.value = []
    updatePendingRemoteIceCount()

    if (remoteStream.value) {
      remoteStream.value.getTracks().forEach((track) => track.stop())
      remoteStream.value = null
    }
  }

  const cleanupAll = () => {
    clearSignalingWatchdog()
    cleanupPeerConnection()
    cleanupSocket()
  }

  const connectSocket = () => {
    clearError()
    if (!config.sessionId) {
      setError('Session ID belum ada. Buat session atau isi session ID manual dulu.')
      return Promise.resolve(false)
    }

    if (socketRef.value?.readyState === WebSocket.OPEN && status.socketSessionId === config.sessionId) {
      addLog('info', 'WebSocket sudah aktif untuk session ini, connect ulang dilewati.', {
        sessionId: config.sessionId,
      })
      return Promise.resolve(true)
    }

    if (activeSocketConnectPromise.value && status.socketSessionId === config.sessionId) {
      addLog('info', 'Koneksi WebSocket untuk session ini sedang berlangsung, menunggu hasil yang sama.', {
        sessionId: config.sessionId,
      })
      return activeSocketConnectPromise.value
    }

    cleanupSocket()

    status.socketStatus = 'connecting'
    status.currentStep = 'connecting_socket'

    const socketUrl = buildSocketUrl(config.wsPath, config.sessionId, config.accessToken)
    const socket = new WebSocket(socketUrl)
    const targetSessionId = config.sessionId
    socketRef.value = socket
    status.socketSessionId = targetSessionId
    let connectSettled = false
    let resolveSocketConnect = null
    addLog('info', 'Mencoba connect WebSocket remote desktop.', {
      socketUrl,
      sessionId: targetSessionId,
    })

    const finishSocketConnect = (value) => {
      if (connectSettled) {
        return
      }

      connectSettled = true
      activeSocketConnectPromise.value = null
      resolveSocketConnect?.(value)
    }

    activeSocketConnectPromise.value = new Promise((resolve) => {
      resolveSocketConnect = resolve

      socket.onopen = () => {
        status.socketStatus = 'open'
        status.currentStep = 'socket_connected'
        addLog('success', 'WebSocket remote desktop terhubung.', {
          sessionId: targetSessionId,
        })

        if (config.autoCreatePeerAfterSocketOpen && !peerRef.value) {
          addLog(
            'info',
            'Melanjutkan setup peer setelah socket open. Ini jadi fallback kalau event accepted belum datang.',
            { sessionId: targetSessionId },
          )
          createPeerConnection()
        }

        finishSocketConnect(true)
      }
    })

    socket.onmessage = async (event) => {
      const rawMessage = typeof event.data === 'string' ? event.data : String(event.data)
      status.wsMessageCount += 1
      status.lastWsEventAt = toIsoTime()
      status.lastWsRawPreview = rawMessage.slice(0, 240)
      addLog('ws', 'WS frame diterima dari backend.', {
        sessionId: targetSessionId,
        messageIndex: status.wsMessageCount,
        rawPreview: rawMessage.slice(0, 400),
      })

      const payload = parseJson(event.data, null)
      if (!payload) {
        addLog('warning', 'Pesan WebSocket tidak valid JSON.', {
          sessionId: targetSessionId,
          rawPreview: rawMessage.slice(0, 400),
        })
        return
      }

      const normalizedPayload = normalizeSocketPayload(payload)
      const payloadShape = summarizeSocketPayloadShape(payload)
      addLog('ws', 'WS frame berhasil di-parse.', {
        sessionId: targetSessionId,
        payloadShape,
      })
      console.log('[remote-desktop] WS raw payload:', payload)
      console.log('[remote-desktop] WS raw payload shape:', payloadShape)
      console.log('[remote-desktop] WS normalized payload:', normalizedPayload)

      if (!normalizedPayload) {
        addLog('warning', 'Pesan WebSocket tidak dikenali bentuknya.', {
          sessionId: targetSessionId,
          payloadShape,
          payload,
        })
        return
      }

      await routeSocketEvent(normalizedPayload)
    }

    socket.onerror = (event) => {
      setError('WebSocket mengalami error.', {
        sessionId: targetSessionId,
        event,
      })
      finishSocketConnect(false)
    }

    socket.onclose = (event) => {
      status.socketStatus = 'closed'
      addLog('warning', 'WebSocket tertutup.', {
        code: event.code,
        reason: event.reason,
        sessionId: targetSessionId,
      })
      if (socketRef.value === socket) {
        status.socketSessionId = ''
      }

      if (config.reconnectSocket && !isTerminal.value) {
        addLog('info', 'Menjadwalkan reconnect WebSocket.', {
          sessionId: targetSessionId,
          delayMs: 1500,
        })
        reconnectTimer.value = window.setTimeout(() => {
          connectSocket()
        }, 1500)
      }

      finishSocketConnect(false)
    }

    return activeSocketConnectPromise.value
  }

  const createSession = async () => {
    clearError()
    cleanupAll()
    resetSessionRuntimeState()
    eventHistory.value = []
    status.requestState = 'loading'
    status.currentStep = 'creating_session'

    try {
      const url = buildUrl(config.apiBaseUrl, `/devices/${config.deviceId}/remote-desktop/sessions/`)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}),
        },
        body: JSON.stringify({
          timeout_seconds: Number(config.timeoutSeconds),
          transport_type: 'webrtc',
          metadata: {
            source: config.metadataSource,
            page: config.metadataPage,
          },
        }),
      })

      const payload = await response.json().catch(() => ({}))
      status.requestId = payload?.request_id ?? ''

      if (!response.ok) {
        const message =
          response.status === 409
            ? 'Device sedang dipakai operator lain.'
            : response.status === 403
              ? 'Kamu tidak punya akses ke device ini.'
              : response.status === 401
                ? 'Token tidak valid atau sudah expired.'
                : payload?.message ?? 'Gagal membuat session remote desktop.'

        throw new Error(message)
      }

      const data = resolveEnvelope(payload)
      ensureWebRtcTransport(data, { strict: true })
      syncSession(data)
      status.requestState = 'success'
      status.sessionStatus = data.status ?? 'requested'
      status.currentStep = 'session_created'
      addLog('success', 'Session remote desktop berhasil dibuat.', data)

      if (config.autoConnectSocket) {
        const socketConnected = await connectSocket()

        if (socketConnected) {
          addLog('info', 'Resync detail session setelah WebSocket open untuk menutup gap race condition awal.', {
            sessionId: config.sessionId,
          })
          await loadSessionDetail({
            silentIfRequested: true,
            preserveCurrentStep: true,
          })

          if (status.sessionStatus === 'accepted' && config.autoCreatePeerOnAccept && !peerRef.value) {
            addLog(
              'info',
              'Session ternyata sudah accepted saat resync HTTP, jadi setup peer dilanjutkan tanpa menunggu event WS awal.',
              { sessionId: config.sessionId },
            )
            await createPeerConnection()
          }
        }
      }
    } catch (error) {
      status.requestState = 'error'
      setError(error.message, { requestId: status.requestId })
    }
  }

  const loadSessionDetail = async (options = {}) => {
    const { silentIfRequested = false, preserveCurrentStep = false } = options
    clearError()
    if (!config.sessionId) {
      setError('Isi session ID dulu untuk ambil detail session.')
      return
    }

    status.requestState = 'loading'

    try {
      const url = buildUrl(
        config.apiBaseUrl,
        `/devices/${config.deviceId}/remote-desktop/sessions/${config.sessionId}`,
      )
      const response = await fetch(url, {
        headers: {
          ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}),
        },
      })
      const payload = await response.json().catch(() => ({}))
      status.requestId = payload?.request_id ?? ''

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Gagal mengambil detail session.')
      }

      const data = resolveEnvelope(payload)
      ensureWebRtcTransport(data)
      syncSession(data)
      status.requestState = 'success'
      if (silentIfRequested && status.sessionStatus === 'requested') {
        addLog('info', 'Detail session di-resync dan masih berada pada status requested.', data)
      }
      addLog('success', 'Detail session berhasil di-refresh.', data)
      if (!preserveCurrentStep) {
        status.currentStep = 'session_synced'
      }
    } catch (error) {
      status.requestState = 'error'
      setError(error.message, { requestId: status.requestId })
    }
  }

  const terminateSession = async (mode = 'ws') => {
    clearError()
    const reason = 'terminated by operator'

    if (!config.sessionId) {
      setError('Session ID belum tersedia untuk terminate.')
      return
    }

    if (mode === 'ws') {
      sendSocketEvent('remote_session.terminate', {
        session_id: config.sessionId,
        device_id: config.deviceId,
        reason,
      })
    }

    if (mode === 'http' || mode === 'both') {
      try {
        const url = buildUrl(
          config.apiBaseUrl,
          `/devices/${config.deviceId}/remote-desktop/sessions/${config.sessionId}/terminate`,
        )
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}),
          },
          body: JSON.stringify({ reason }),
        })
        const payload = await response.json().catch(() => ({}))
        status.requestId = payload?.request_id ?? ''

        if (!response.ok) {
          throw new Error(payload?.message ?? 'Gagal terminate session lewat HTTP.')
        }

        addLog('success', 'Terminate session via HTTP berhasil.', payload)
      } catch (error) {
        setError(error.message, { requestId: status.requestId })
      }
    }

    status.sessionStatus = 'terminated'
    cleanupPeerConnection()
    cleanupSocket({ reason: 'session-terminated' })
    resetSessionRuntimeState({ preserveSessionId: true })
  }

  const deleteSession = async (overrides = {}) => {
    clearError()

    const targetDeviceId = String(overrides.deviceId ?? config.deviceId ?? '').trim()
    const targetSessionId = String(overrides.sessionId ?? config.sessionId ?? '').trim()

    if (!targetDeviceId) {
      setError('Device ID belum tersedia untuk delete session.')
      return false
    }

    if (!targetSessionId) {
      setError('Session ID belum tersedia untuk delete session.')
      return false
    }

    status.deleteSessionState = 'loading'

    try {
      const url = buildUrl(
        config.apiBaseUrl,
        `/devices/${targetDeviceId}/remote-desktop/sessions/${targetSessionId}`,
      )
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}),
        },
      })
      const payload = await response.json().catch(() => ({}))
      status.requestId = payload?.request_id ?? status.requestId

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Gagal delete session remote desktop.')
      }

      addLog('success', 'Delete session via HTTP berhasil.', {
        deviceId: targetDeviceId,
        sessionId: targetSessionId,
        response: payload,
      })

      if (targetSessionId === config.sessionId) {
        status.sessionStatus = 'ended'
        cleanupPeerConnection()
        cleanupSocket({ reason: 'session-deleted' })
        resetSessionRuntimeState()
      }

      status.deleteSessionState = 'success'
      return true
    } catch (error) {
      status.deleteSessionState = 'error'
      setError(error.message, { requestId: status.requestId })
      return false
    }
  }

  const getRenderedVideoRect = (fallbackTarget) => {
    const videoElement = remoteVideoElement.value
    const fallbackRect = fallbackTarget?.getBoundingClientRect?.()

    if (!videoElement) {
      return fallbackRect
    }

    const rect = videoElement.getBoundingClientRect()
    const videoWidth = videoElement.videoWidth
    const videoHeight = videoElement.videoHeight

    if (!videoWidth || !videoHeight || rect.width === 0 || rect.height === 0) {
      return rect.width > 0 && rect.height > 0 ? rect : fallbackRect
    }

    const containerAspect = rect.width / rect.height
    const videoAspect = videoWidth / videoHeight

    if (containerAspect > videoAspect) {
      const width = rect.height * videoAspect
      const left = rect.left + (rect.width - width) / 2

      return {
        left,
        top: rect.top,
        width,
        height: rect.height,
      }
    }

    const height = rect.width / videoAspect
    const top = rect.top + (rect.height - height) / 2

    return {
      left: rect.left,
      top,
      width: rect.width,
      height,
    }
  }

  const extractClientPoint = (event) => {
    if (typeof event?.clientX === 'number' && typeof event?.clientY === 'number') {
      return { clientX: event.clientX, clientY: event.clientY }
    }

    const touch = event?.touches?.[0] ?? event?.changedTouches?.[0]
    if (touch) {
      return { clientX: touch.clientX, clientY: touch.clientY }
    }

    return { clientX: 0, clientY: 0 }
  }

  const normalizedCoordinates = (event) => {
    const rect = getRenderedVideoRect(event.currentTarget)
    const point = extractClientPoint(event)
    const x = rect?.width ? (point.clientX - rect.left) / rect.width : 0
    const y = rect?.height ? (point.clientY - rect.top) / rect.height : 0

    return {
      x: Number(Math.min(1, Math.max(0, x)).toFixed(4)),
      y: Number(Math.min(1, Math.max(0, y)).toFixed(4)),
    }
  }

  const handleKeyboard = (type, event) => {
    if (!canInteract.value) {
      return
    }

    const isKeyDown = type === 'keyboard.key_down'
    const isPrintable = event.key?.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
    if (isKeyDown && isPrintable) {
      sendControlEvent({
        type: 'keyboard.text',
        text: event.key,
        timestamp: Date.now(),
      })
      return
    }

    sendControlEvent({
      type,
      key: event.key,
      code: event.code,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
      repeat: event.repeat,
      timestamp: Date.now(),
    })
  }

  const handleMouseMove = (event) => {
    if (!canInteract.value) {
      return
    }

    const now = Date.now()
    if (now - lastMouseMoveSentAt.value < 40) {
      return
    }

    lastMouseMoveSentAt.value = now
    sendControlEvent({
      type: 'mouse.move',
      ...normalizedCoordinates(event),
      timestamp: now,
    })
  }

  const handleMouseButton = (type, event) => {
    if (!canInteract.value) {
      return
    }

    focusRemoteStage()
    sendControlEvent({
      type,
      button: event.button,
      ...normalizedCoordinates(event),
      timestamp: Date.now(),
    })
  }

  const handleWheel = (event) => {
    if (!canInteract.value) {
      return
    }

    focusRemoteStage()
    sendControlEvent({
      type: 'mouse.wheel',
      delta_x: event.deltaX,
      delta_y: event.deltaY,
      ...normalizedCoordinates(event),
      timestamp: Date.now(),
    })
  }

  const handleTouchStart = (event) => {
    if (!canInteract.value) {
      return
    }

    focusRemoteStage()
    sendControlEvent({
      type: 'mouse.down',
      button: 0,
      ...normalizedCoordinates(event),
      timestamp: Date.now(),
    })
  }

  const handleTouchMove = (event) => {
    if (!canInteract.value) {
      return
    }

    const now = Date.now()
    if (now - lastMouseMoveSentAt.value < 40) {
      return
    }

    lastMouseMoveSentAt.value = now
    sendControlEvent({
      type: 'mouse.move',
      ...normalizedCoordinates(event),
      timestamp: now,
    })
  }

  const handleTouchEnd = (event) => {
    if (!canInteract.value) {
      return
    }

    sendControlEvent({
      type: 'mouse.up',
      button: 0,
      ...normalizedCoordinates(event),
      timestamp: Date.now(),
    })
  }

  const handleTextInput = (text) => {
    if (!canInteract.value) {
      return
    }
    const normalized = String(text ?? '')
    if (!normalized.length) {
      return
    }
    sendControlEvent({
      type: 'keyboard.text',
      text: normalized,
      timestamp: Date.now(),
    })
  }

  const setRemoteStageElement = (element) => {
    remoteStageElement.value = element
  }

  const setRemoteVideoElement = (element) => {
    remoteVideoElement.value = element
  }

  const runStep = async (step) => {
    if (step === 'create-session') {
      await createSession()
      return
    }

    if (step === 'connect-socket') {
      connectSocket()
      return
    }

    if (step === 'create-peer') {
      await createPeerConnection()
      return
    }

    if (step === 'send-offer') {
      await createAndSendOffer()
    }
  }

  onBeforeUnmount(() => {
    stopStatsPolling()
    delete window.__remoteDesktopSimulatorBridge
    cleanupAll()
  })

  registerWindowBridge()

  return proxyRefs({
    attachViewerElements,
    applyStunOnlyPreset,
    applyTurnPreset,
    canInteract,
    config,
    controlReady,
    devices,
    createAndSendOffer,
    createPeerConnection,
    createSession,
    generateAccessToken,
    eventHistory,
    handleKeyboard,
    handleTextInput,
    handleMouseButton,
    handleMouseMove,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleWheel,
    hasSession,
    iceConfigSummary,
    isTerminal,
    loadSessionDetail,
    logs,
    getStatsSnapshot,
    getStatusSnapshot,
    loadTurnCredentials,
    runStep,
    loadDevices,
    viewerReady,
    screenReady,
    session,
    sessionPhase,
    setRemoteStageElement,
    setRemoteVideoElement,
    stats,
    status,
    deleteSession,
    terminateSession,
    connectSocket,
    detachViewerElements,
    focusRemoteStage,
  })
}
