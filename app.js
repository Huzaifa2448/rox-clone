/* Rox Assistant clone — direct-browser client.
   Talks to Google Gemini Live straight from the browser with the official
   @google/genai JS SDK (loaded as an ES module from a CDN). There is no
   relay server: the page is pure static files, so it can be hosted free
   on GitHub Pages. The user's Gemini API key goes from this page directly
   to Google — nothing in between.
   Behaviour reference: the original web app (mic 16 kHz in, 24 kHz out,
   Puck/Kore voices, same tool calls, same statuses). No code was copied
   from the original bundle. */

import { GoogleGenAI } from 'https://esm.run/@google/genai@1.52.0';

'use strict';

/* ------------------------------------------------------------------ */
/* Profile storage (same localStorage keys as the original, so a user   */
/* moving from the original app keeps their profile and key).          */
/* ------------------------------------------------------------------ */
const LS = {
  apiKey: 'rox_custom_gemini_key',
  firstName: 'rox_profile_first_name',
  lastName: 'rox_profile_last_name',
  memory: 'rox_profile_memory',
  photo: 'rox_profile_photo',
  voice: 'rox_voice',
  introDone: 'rox_intro_completed',
  resumeHandle: 'rox_live_resume_handle',
  resumeHandleTs: 'rox_live_resume_handle_ts',
};

const RESUME_HANDLE_TTL_MS = 100 * 60 * 1000; // 100 minutes, as in the original
const CONNECT_TIMEOUT_MS = 12 * 1000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

const store = {
  get(key) {
    try {
      const v = window.localStorage.getItem(key) || '';
      return (v === 'None' || v === 'none' || v === 'undefined' || v === 'null') ? '' : v;
    } catch (e) { return ''; }
  },
  set(key, value) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
      return true;
    } catch (e) { return false; }
  },
};

function getProfile() {
  return {
    apiKey: store.get(LS.apiKey),
    firstName: store.get(LS.firstName),
    lastName: store.get(LS.lastName),
    memory: store.get(LS.memory),
    photo: store.get(LS.photo),
    voice: store.get(LS.voice) === 'female' ? 'female' : 'male', // default male
  };
}

function cleanApiKey() {
  const key = (getProfile().apiKey || '').trim();
  return key ? key : '';
}

/* ------------------------------------------------------------------ */
/* Gemini Live config: model, tools, system instruction.               */
/* Tool names/args match the browser tool dispatcher below, and the    */
/* system instruction matches the relay server's, so both modes        */
/* behave the same.                                                    */
/* ------------------------------------------------------------------ */
/* Live models, newest first. Google retires preview model names without
   warning (yehi 'not found' error ki wajah thi), so the session tries
   each one in turn until one connects — fast failover, no rebuild. */
const LIVE_MODELS = [
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-2.5-flash-preview-native-audio-dialog',
  'gemini-3.1-flash-live-preview',
  'gemini-live-2.5-flash-preview',
];

function functionDeclaration(name, description, properties, required) {
  return { name, description, parameters: { type: 'OBJECT', properties, required: required || [] } };
}

const FUNCTION_DECLARATIONS = [
  functionDeclaration('openAnyApp', 'Open an installed app by name.', {
    appName: { type: 'STRING', description: 'App name, e.g. YouTube, WhatsApp, Spotify.' },
  }, ['appName']),
  functionDeclaration('launchApp', 'Open an installed app by name.', {
    appName: { type: 'STRING', description: 'App name, e.g. YouTube, WhatsApp, Spotify.' },
  }, ['appName']),
  functionDeclaration('callContact', 'Call a contact by name.', {
    name: { type: 'STRING', description: 'Contact name.' },
  }, ['name']),
  functionDeclaration('callNumber', 'Call a phone number.', {
    number: { type: 'STRING', description: 'Phone number to call.' },
  }, ['number']),
  functionDeclaration('makePhoneCall', 'Call a phone number.', {
    phoneNumber: { type: 'STRING', description: 'Phone number to call.' },
  }, ['phoneNumber']),
  functionDeclaration('draftSms', 'Open an SMS draft.', {
    nameOrNumber: { type: 'STRING', description: 'Contact name or phone number.' },
    message: { type: 'STRING', description: 'Message text.' },
  }, ['nameOrNumber']),
  functionDeclaration('openWhatsAppChat', 'Open a WhatsApp chat.', {
    nameOrNumber: { type: 'STRING', description: 'Contact name or phone number.' },
    message: { type: 'STRING', description: 'Optional message text.' },
  }, ['nameOrNumber']),
  functionDeclaration('setFlashlight', 'Turn the flashlight on or off.', {
    on: { type: 'BOOLEAN', description: 'True to turn on, false to turn off.' },
  }, ['on']),
  functionDeclaration('setVolume', 'Change the device volume.', {
    action: { type: 'STRING', description: '"up", "down", "mute", "unmute" or "set".' },
    level: { type: 'NUMBER', description: 'Volume level 0-100 when action is "set".' },
  }, ['action']),
  functionDeclaration('setBrightness', 'Change the screen brightness.', {
    action: { type: 'STRING', description: '"up", "down" or "set".' },
    level: { type: 'NUMBER', description: 'Brightness level 0-100 when action is "set".' },
  }, ['action']),
  functionDeclaration('setAlarm', 'Set an alarm.', {
    hour: { type: 'NUMBER', description: 'Hour 0-23.' },
    minute: { type: 'NUMBER', description: 'Minute 0-59.' },
    label: { type: 'STRING', description: 'Optional alarm label.' },
  }, ['hour', 'minute']),
  functionDeclaration('setTimer', 'Set a timer.', {
    seconds: { type: 'NUMBER', description: 'Timer length in seconds.' },
    label: { type: 'STRING', description: 'Optional timer label.' },
  }, ['seconds']),
  functionDeclaration('openCamera', 'Open the camera.', {
    mode: { type: 'STRING', description: '"photo" or "video".' },
  }, []),
  functionDeclaration('getBatteryStatus', 'Read the battery level and charging state.', {}, []),
  functionDeclaration('getNetworkStatus', 'Read the network connection state.', {}, []),
  functionDeclaration('playMedia', 'Play music or a video.', {
    query: { type: 'STRING', description: 'Song or video to play.' },
    app: { type: 'STRING', description: '"youtube" or "spotify".' },
  }, ['query']),
  functionDeclaration('openCalendarOrCalculator', 'Open the calendar or the calculator.', {
    which: { type: 'STRING', description: '"calendar" or "calculator".' },
  }, ['which']),
  functionDeclaration('openSystemSettings', 'Open a system settings page.', {
    which: { type: 'STRING', description: 'Setting page, e.g. "wifi", "bluetooth", "general".' },
  }, ['which']),
  functionDeclaration('openDeviceSettings', 'Open a system settings page.', {
    settingType: { type: 'STRING', description: 'Setting page, e.g. "wifi", "bluetooth", "general".' },
  }, ['settingType']),
  functionDeclaration('openWebsite', 'Open a website.', {
    url: { type: 'STRING', description: 'Website URL.' },
    siteName: { type: 'STRING', description: 'Friendly site name.' },
  }, ['url']),
  functionDeclaration('openWebSearch', 'Search the web.', {
    query: { type: 'STRING', description: 'Search query.' },
  }, ['query']),
  functionDeclaration('openMapLocation', 'Open a place on the map.', {
    locationQuery: { type: 'STRING', description: 'Place or address.' },
  }, ['locationQuery']),
  functionDeclaration('changeAtmosphere', 'Change the app theme/mood.', {
    theme: { type: 'STRING', description: 'Theme name, e.g. "neon-cyber", "sunset", "rose", "violet".' },
    moodTitle: { type: 'STRING', description: 'Short mood title to show.' },
  }, ['theme']),
  functionDeclaration('triggerReactionAnimation', 'Play a reaction animation on the orb.', {
    reactionType: { type: 'STRING', description: 'Reaction, e.g. "wink".' },
    wittyComment: { type: 'STRING', description: 'Short witty caption to show with it.' },
  }, ['reactionType']),
  functionDeclaration('getCurrentTimeAndDate', 'Read the current local time and date.', {}, []),
];

function buildSystemInstruction(profile) {
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'the user';
  const lines = [
    'You are Rox, a confident, witty, and charming personal AI assistant.',
    'Your developer is Huzaifa.',
    'The user you are talking to is ' + name + '.',
  ];
  if (profile.memory) lines.push('Things to remember about the user: ' + profile.memory);
  lines.push(
    'Speak naturally in voice, keep answers short and useful, and use the tools available to you ' +
    'to open apps, call, message, set alarms and timers, and control the phone when the user asks.'
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
function base64FromInt16(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function int16FromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/* ------------------------------------------------------------------ */
/* Audio: 16 kHz mic in, 24 kHz speaker out (same rates as original).  */
/* ------------------------------------------------------------------ */
class AudioStreamer {
  constructor() {
    this.inputCtx = null;
    this.outputCtx = null;
    this.mediaStream = null;
    this.scriptProcessor = null;
    this.playQueue = [];
    this.isPlayingChunk = false;
    this.isMuted = false;
    this.micAvailable = false;
    this.micError = '';
    this.onAudioInput = null;      // (base64 pcm) => void
    this.onPlaybackChange = null;  // (playing: boolean) => void
  }

  async initialize() {
    if (!this.mediaStream) {
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.micAvailable = true;
      } catch (err) {
        this.micAvailable = false;
        this.micError = (err && err.name) || 'Microphone unavailable';
        return false;
      }
    }
    if (!this.inputCtx || this.inputCtx.state === 'closed') {
      try { this.inputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 }); }
      catch (e) { this.inputCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    }
    if (this.inputCtx.state === 'suspended') await this.inputCtx.resume();
    return true;
  }

  async attachMicrophone() {
    if (!(await this.initialize())) return false;
    if (this.scriptProcessor) return true;
    const source = this.inputCtx.createMediaStreamSource(this.mediaStream);
    this.scriptProcessor = this.inputCtx.createScriptProcessor(2048, 1, 1);
    this.scriptProcessor.onaudioprocess = (event) => {
      if (this.isMuted || !this.onAudioInput) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.onAudioInput(base64FromInt16(pcm));
    };
    source.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.inputCtx.destination);
    return true;
  }

  async resume() {
    if (this.inputCtx && this.inputCtx.state === 'suspended') await this.inputCtx.resume();
    if (this.outputCtx && this.outputCtx.state === 'suspended') await this.outputCtx.resume();
  }

  playChunk(base64Pcm) {
    const pcm = int16FromBase64(base64Pcm);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
    this.playQueue.push(samples);
    this.pumpPlayback();
  }

  async pumpPlayback() {
    if (this.isPlayingChunk || this.playQueue.length === 0) return;
    this.isPlayingChunk = true;
    if (this.onPlaybackChange) this.onPlaybackChange(true);
    if (!this.outputCtx || this.outputCtx.state === 'closed') {
      try { this.outputCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 }); }
      catch (e) { this.outputCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    }
    if (this.outputCtx.state === 'suspended') await this.outputCtx.resume();
    while (this.playQueue.length > 0) {
      const samples = this.playQueue.shift();
      const buffer = this.outputCtx.createBuffer(1, samples.length, 24000);
      buffer.getChannelData(0).set(samples);
      const source = this.outputCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.outputCtx.destination);
      await new Promise((resolve) => { source.onended = resolve; source.start(); });
    }
    this.isPlayingChunk = false;
    if (this.onPlaybackChange) this.onPlaybackChange(false);
  }

  stopPlayback() {
    this.playQueue = [];
    // Current chunk finishes on its own; the queue being empty stops the rest.
    if (this.onPlaybackChange) this.onPlaybackChange(false);
  }

  setMuted(muted) { this.isMuted = muted; }
}

/* ------------------------------------------------------------------ */
/* Android bridge: same window.Android method names as the original.   */
/* When the page runs in a browser (not the app) every call falls back  */
/* to an ordinary web URL, so the clone still works on desktop.         */
/* ------------------------------------------------------------------ */
const isNativeAndroid = () =>
  typeof window.Android !== 'undefined' && window.Android !== null;

function bridgeCall(name, ...args) {
  if (isNativeAndroid() && typeof window.Android[name] === 'function') {
    try { return window.Android[name](...args); } catch (e) { console.warn('[AndroidBridge] call failed:', name, e); }
  }
  return null;
}

function bridgeResult(raw, fallbackMessage) {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return { ok: parsed.ok !== false, message: parsed.message || fallbackMessage, ...parsed };
    } catch (e) { return { ok: true, message: raw || fallbackMessage }; }
  }
  return { ok: true, message: fallbackMessage };
}

function openWebUrl(url) {
  window.open(url, '_blank', 'noopener');
  return { ok: true, message: 'Opened ' + url };
}

const AndroidBridge = {
  isNativeAndroid,
  openAnyApp(appName) {
    const raw = bridgeCall('openAnyApp', appName);
    if (raw !== null) return bridgeResult(raw, 'Opened ' + appName);
    // Browser fallback: open a web search for the app.
    return openWebUrl('https://www.google.com/search?q=' + encodeURIComponent(appName));
  },
  callContact(name) {
    const raw = bridgeCall('callContact', name);
    if (raw !== null) return bridgeResult(raw, 'Calling ' + name);
    return { ok: false, message: 'Calling needs the Android app' };
  },
  callNumber(number) {
    const raw = bridgeCall('callNumber', number);
    if (raw !== null) return bridgeResult(raw, 'Calling ' + number);
    return openWebUrl('tel:' + encodeURIComponent(number));
  },
  draftSms(nameOrNumber, message) {
    const raw = bridgeCall('draftSms', nameOrNumber, message);
    if (raw !== null) return bridgeResult(raw, 'Opened SMS draft for ' + nameOrNumber);
    return openWebUrl('sms:' + encodeURIComponent(nameOrNumber) + '?body=' + encodeURIComponent(message || ''));
  },
  openWhatsAppChat(nameOrNumber, message) {
    const raw = bridgeCall('openWhatsAppChat', nameOrNumber, message);
    if (raw !== null) return bridgeResult(raw, 'Opened WhatsApp chat for ' + nameOrNumber);
    const url = 'https://web.whatsapp.com/send?phone=' + encodeURIComponent(nameOrNumber) +
      (message ? '&text=' + encodeURIComponent(message) : '');
    return openWebUrl(url);
  },
  setFlashlight(on) {
    const raw = bridgeCall('setFlashlight', on);
    if (raw !== null) return bridgeResult(raw, on ? 'Flashlight turned on' : 'Flashlight turned off');
    return { ok: false, message: 'Flashlight needs the Android app' };
  },
  setVolume(action, level) {
    const raw = bridgeCall('setVolume', action, level === undefined ? -1 : Math.round(level));
    if (raw !== null) return bridgeResult(raw, 'Volume ' + action);
    return { ok: false, message: 'Volume needs the Android app' };
  },
  setBrightness(action, level) {
    const raw = bridgeCall('setBrightness', action, level === undefined ? -1 : Math.round(level));
    if (raw !== null) return bridgeResult(raw, 'Brightness set');
    return { ok: false, message: 'Brightness needs the Android app' };
  },
  setAlarm(hour, minute, label) {
    const raw = bridgeCall('setAlarm', hour, minute, label || null);
    if (raw !== null) return bridgeResult(raw, 'Alarm set');
    return { ok: false, message: 'Alarm needs the Android app' };
  },
  setTimer(seconds, label) {
    const raw = bridgeCall('setTimer', seconds, label || null);
    if (raw !== null) return bridgeResult(raw, 'Timer set for ' + seconds + ' seconds');
    return { ok: false, message: 'Timer needs the Android app' };
  },
  openCamera(mode) {
    const raw = bridgeCall('openCamera', mode);
    if (raw !== null) return bridgeResult(raw, 'Opened camera in ' + mode + ' mode');
    return { ok: false, message: 'Camera needs the Android app' };
  },
  getBatteryStatus() {
    const raw = bridgeCall('getBatteryStatus');
    if (raw !== null) return bridgeResult(raw, 'Battery status retrieved');
    if (navigator.getBattery) {
      return navigator.getBattery().then((b) => ({
        ok: true, message: 'Battery ' + Math.round(b.level * 100) + '%',
        level: Math.round(b.level * 100), charging: b.charging,
      }));
    }
    return { ok: false, message: 'Battery status unavailable' };
  },
  getNetworkStatus() {
    const raw = bridgeCall('getNetworkStatus');
    if (raw !== null) return bridgeResult(raw, 'Network status retrieved');
    return { ok: true, message: navigator.onLine ? 'Online' : 'Offline', online: navigator.onLine };
  },
  playMedia(query, app) {
    const raw = bridgeCall('playMedia', query, app);
    if (raw !== null) return bridgeResult(raw, 'Playing ' + query);
    const target = (app || 'youtube').toLowerCase();
    if (target === 'spotify') return openWebUrl('https://open.spotify.com/search/' + encodeURIComponent(query));
    return openWebUrl('https://www.youtube.com/results?search_query=' + encodeURIComponent(query));
  },
  openCalendarOrCalculator(which) {
    const raw = bridgeCall('openCalendarOrCalculator', which);
    if (raw !== null) return bridgeResult(raw, 'Opened ' + which);
    if ((which || '').includes('calc')) return openWebUrl('https://www.google.com/search?q=calculator');
    return openWebUrl('https://calendar.google.com');
  },
  openSystemSettings(which) {
    const raw = bridgeCall('openSystemSettings', which);
    if (raw !== null) return bridgeResult(raw, 'Opened ' + which + ' settings');
    return openWebUrl('https://support.google.com/android/answer/9079129?hl=en');
  },
  performSearch(query) {
    const raw = bridgeCall('performSearch', query);
    if (raw !== null) return bridgeResult(raw, 'Searched for "' + query + '"');
    return openWebUrl('https://www.google.com/search?q=' + encodeURIComponent(query));
  },
  openMapLocation(locationQuery) {
    const raw = bridgeCall('openMapLocation', locationQuery);
    if (raw !== null) return bridgeResult(raw, 'Opened Maps for "' + locationQuery + '"');
    return openWebUrl('https://maps.google.com/?q=' + encodeURIComponent(locationQuery));
  },
  vibrate(durationMs) {
    if (isNativeAndroid() && typeof window.Android.vibrate === 'function') {
      try { window.Android.vibrate(durationMs); return; } catch (e) { /* fall through */ }
    }
    if (typeof navigator.vibrate === 'function') { try { navigator.vibrate(durationMs); } catch (e) { /* ignore */ } }
  },
  showToast(message) {
    if (isNativeAndroid() && typeof window.Android.showToast === 'function') {
      try { window.Android.showToast(message); return; } catch (e) { /* fall through */ }
    }
    showToast(message);
  },
  requestAudioPermission() {
    if (isNativeAndroid() && typeof window.Android.requestAudioPermission === 'function') {
      try { return !!window.Android.requestAudioPermission(); } catch (e) { return false; }
    }
    return true; // browser asks via getUserMedia instead
  },
  startForegroundService() {
    bridgeCall('startForegroundService');
  },
  stopForegroundService() {
    bridgeCall('stopForegroundService');
  },
};

/* ------------------------------------------------------------------ */
/* Live session: direct Gemini Live connection from the browser via   */
/* the @google/genai SDK. No relay server, no WebSocket of our own:  */
/* the SDK owns the Live socket; this class owns reconnects, the mic  */
/* stream, playback, and tool dispatch.                               */
/* ------------------------------------------------------------------ */
class LiveSession {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.liveSession = null;
    this.status = 'disconnected';
    this.isMuted = false;
    this.isLiveReady = false;
    this.isConnectingNow = false;
    this.userInitiatedDisconnect = false;
    this.liveClosedByUs = false;
    this.activeWsSeq = 0;
    this.reconnectAttempts = 0;
    this.modelIndex = 0;
    this.reconnectTimer = null;
    this.reconnectNoticeTimer = null;
    this.reconnectStartedAt = null;
    this.shownReconnectingNotice = false;
    this.connectionWatchdog = null;
    this.lastErrorReason = '';
    this.audioStreamer = new AudioStreamer();
    this.latestResumeHandle = this.loadValidResumeHandle();
    this.pendingToolNames = new Map();

    this.audioStreamer.onAudioInput = (base64Pcm) => {
      if (this.isLiveReady && this.liveSession && !this.isMuted) {
        try {
          this.liveSession.sendRealtimeInput({
            audio: { data: base64Pcm, mimeType: 'audio/pcm;rate=16000' },
          });
        } catch (e) { /* ignore */ }
      }
    };
    this.audioStreamer.onPlaybackStateChange = (playing) => {
      if (this.status === 'disconnected' || this.status === 'connecting') return;
      this.setStatus(playing ? 'speaking' : 'listening');
    };

    window.addEventListener('online', () => this.handleResumeTrigger('online'));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.handleResumeTrigger('visible');
    });
    window.addEventListener('pageshow', () => this.handleResumeTrigger('pageshow'));
  }

  /* Resume handle: stored with a timestamp, valid for 100 minutes. */
  loadValidResumeHandle() {
    const handle = store.get(LS.resumeHandle);
    const ts = parseInt(store.get(LS.resumeHandleTs) || '0', 10);
    if (!handle || !ts || Date.now() - ts > RESUME_HANDLE_TTL_MS) {
      this.clearResumeHandle();
      return null;
    }
    return handle;
  }
  saveResumeHandle(handle) {
    if (!handle) return;
    this.latestResumeHandle = handle;
    store.set(LS.resumeHandle, handle);
    store.set(LS.resumeHandleTs, String(Date.now()));
  }
  clearResumeHandle() {
    this.latestResumeHandle = null;
    store.set(LS.resumeHandle, '');
    store.set(LS.resumeHandleTs, '');
  }

  setStatus(status) {
    this.status = status;
    if (this.callbacks.onStatus) this.callbacks.onStatus(status);
  }
  fail(message) {
    if (this.callbacks.onError) this.callbacks.onError(message);
  }

  async start() {
    if (!cleanApiKey()) {
      this.setStatus('disconnected');
      this.fail('Add your API Key from the profile icon to start Rox');
      return;
    }
    this.clearResumeHandle();
    this.userInitiatedDisconnect = false;
    this.reconnectAttempts = 0;
    this.modelIndex = 0;
    this.lastErrorReason = '';
    this.clearReconnectNotice();
    this.reconnectTimer && clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeLiveSessionOnly();
    this.isConnectingNow = false;
    await this.connectInternal(false);
  }

  async connectInternal(isReconnect) {
    if (this.isConnectingNow || this.userInitiatedDisconnect) return;
    const apiKey = cleanApiKey();
    if (!apiKey) {
      this.setStatus('disconnected');
      this.fail('Add your API Key from the profile icon to start Rox');
      return;
    }
    this.isConnectingNow = true;
    this.isLiveReady = false;
    if (!isReconnect) this.setStatus('connecting');

    try {
      if (!isReconnect) AndroidBridge.requestAudioPermission();
      if (!(await this.audioStreamer.initialize())) {
        if (!isReconnect && this.audioStreamer.micError) {
          this.fail(this.audioStreamer.micError);
          if (this.callbacks.onDebug) this.callbacks.onDebug('Mic: ' + this.audioStreamer.micError);
        }
      }
      if (this.userInitiatedDisconnect) { this.isConnectingNow = false; return; }

      const profile = getProfile();
      const voiceName = profile.voice === 'female' ? 'Kore' : 'Puck';
      const seq = ++this.activeWsSeq;

      this.connectionWatchdog = setTimeout(() => {
        if (seq !== this.activeWsSeq || this.userInitiatedDisconnect) return;
        console.warn('[LiveSession] Connection attempt timed out');
        this.lastErrorReason = 'Connection timed out';
        this.closeLiveSessionOnly();
        this.isConnectingNow = false;
        this.handleUnexpectedDisconnect();
      }, CONNECT_TIMEOUT_MS);

      const config = {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        systemInstruction: buildSystemInstruction(profile),
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      };
      if (this.latestResumeHandle) {
        config.sessionResumption = { handle: this.latestResumeHandle };
      }

      if (this.callbacks.onDebug) {
        this.callbacks.onDebug('Connecting: ' + LIVE_MODELS[this.modelIndex] +
          (isReconnect ? ' (retry ' + this.reconnectAttempts + ')' : ''));
      }
      const session = await new GoogleGenAI({ apiKey }).live.connect({
        model: LIVE_MODELS[this.modelIndex],
        config,
        callbacks: {
          onopen: () => {
            if (seq !== this.activeWsSeq || this.userInitiatedDisconnect) return;
            console.log('[LiveSession] Gemini Live connection established.');
            if (!isReconnect) AndroidBridge.startForegroundService();
          },
          onmessage: (msg) => {
            if (seq !== this.activeWsSeq || this.userInitiatedDisconnect) return;
            if (!msg) return;
            if (msg.setupComplete) {
              if (this.connectionWatchdog) { clearTimeout(this.connectionWatchdog); this.connectionWatchdog = null; }
              this.isLiveReady = true;
              this.isConnectingNow = false;
              this.reconnectAttempts = 0;
              this.lastErrorReason = '';
              this.clearReconnectNotice();
              if (this.callbacks.onDebug) this.callbacks.onDebug('Connected: ' + LIVE_MODELS[this.modelIndex]);
              this.setStatus(this.audioStreamer.isPlayingChunk ? 'speaking' : 'listening');
              if (!isReconnect) {
                AndroidBridge.showToast('Rox is listening...');
                if (!store.get(LS.introDone)) {
                  console.log('[LiveSession] Playing first-time intro introduction');
                  store.set(LS.introDone, 'true');
                  if (this.liveSession) {
                    try {
                      this.liveSession.sendClientContent({
                        turns: [{ role: 'user', parts: [{ text: 'Say: "Hi, I\'m Rox, your personal AI assistant."' }] }],
                        turnComplete: true,
                      });
                    } catch (e) { console.warn('[LiveSession] Failed to send intro text:', e); }
                  }
                }
              }
              return;
            }
            if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.newHandle) {
              this.saveResumeHandle(msg.sessionResumptionUpdate.newHandle);
            }
            if (msg.serverContent) {
              const content = msg.serverContent;
              if (content.interrupted) {
                console.log('[LiveSession] User interrupted Rox');
                this.audioStreamer.stopPlayback();
                this.setStatus('listening');
              }
              const parts = (content.modelTurn && content.modelTurn.parts) || [];
              for (const part of parts) {
                if (part.inlineData && part.inlineData.data) {
                  this.audioStreamer.playChunk(part.inlineData.data);
                } else if (part.text && this.callbacks.onText) {
                  this.callbacks.onText(part.text);
                }
              }
              if (content.turnComplete && !this.audioStreamer.isPlayingChunk) {
                this.setStatus('listening');
              }
            }
            if (msg.toolCall && msg.toolCall.functionCalls) {
              const functionCalls = msg.toolCall.functionCalls.map((fc) => {
                this.pendingToolNames.set(fc.id, fc.name);
                return { id: fc.id, name: fc.name, args: fc.arguments || fc.args || {} };
              });
              this.handleToolCalls(functionCalls);
            }
            if (msg.toolCallCancellation) {
              for (const id of msg.toolCallCancellation.ids || []) this.pendingToolNames.delete(id);
            }
            if (msg.goAway) {
              console.log('[LiveSession] Server asked the session to go away');
            }
          },
          onerror: (event) => {
            if (seq !== this.activeWsSeq || this.userInitiatedDisconnect) return;
            const detail = (event && (event.message || event.error)) || 'Live connection error';
            console.warn('[LiveSession] Gemini Live error:', detail);
            this.lastErrorReason = String(detail);
            if (this.callbacks.onDebug) this.callbacks.onDebug('Live error: ' + this.lastErrorReason);
          },
          onclose: (event) => {
            if (seq !== this.activeWsSeq) return;
            const code = event && event.code;
            const reason = (event && event.reason) || '';
            console.log('[LiveSession] Gemini Live closed' + (code ? ' (code ' + code + (reason ? ': ' + reason : '') + ')' : ''));
            if (this.userInitiatedDisconnect) return;
            if (this.liveClosedByUs) { this.liveClosedByUs = false; return; }
            const wasReady = this.isLiveReady;
            this.liveSession = null;
            this.isLiveReady = false;
            this.isConnectingNow = false;
            if (this.connectionWatchdog) { clearTimeout(this.connectionWatchdog); this.connectionWatchdog = null; }
            if (!wasReady) {
              // Died before setup completed (usually a bad key). Say so
              // plainly instead of reconnecting forever; the client
              // treats key errors as fatal.
              this.lastErrorReason = this.lastErrorReason || reason ||
                'Live session closed before it was ready — check your API key';
              if (this.callbacks.onDebug) this.callbacks.onDebug('Closed: ' + this.lastErrorReason);
              // Model retired? Rotate to the next model instead of giving
              // up — this path returns early, so the failover must live
              // here too, not only in handleUnexpectedDisconnect.
              if (this.isModelNotFound(this.lastErrorReason) && this.modelIndex < LIVE_MODELS.length - 1) {
                this.modelIndex++;
                this.reconnectAttempts = 0;
                this.fail('Model nahi mila — agla model try kar raha hoon...');
                if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
                this.reconnectTimer = setTimeout(() => {
                  this.reconnectTimer = null;
                  if (!this.userInitiatedDisconnect) this.connectInternal(true);
                }, 800);
                return;
              }
              this.disconnect();
              this.fail(this.lastErrorReason);
              return;
            }
            if (this.reconnectTimer) return; // a reconnect is already scheduled
            this.handleUnexpectedDisconnect();
          },
        },
      });
      this.liveSession = session;
    } catch (err) {
      const message = (err && err.message) || 'Connection failed';
      console.warn('[LiveSession] Could not connect session:', message);
      this.closeLiveSessionOnly();
      this.isConnectingNow = false;
      this.lastErrorReason = message;
      if (this.callbacks.onDebug) this.callbacks.onDebug('Connect failed: ' + message);
      if (this.userInitiatedDisconnect) {
        this.disconnect();
        this.fail(this.lastErrorReason);
      } else {
        this.handleUnexpectedDisconnect();
      }
    }
  }

  isModelNotFound(reason) {
    const r = (reason || '').toLowerCase();
    return r.includes('not found') && r.includes('model');
  }

  isFatalError(reason) {
    const r = (reason || '').toLowerCase();
    return r.includes('api key') || r.includes('api_key') || r.includes('invalid') ||
      r.includes('unauthenticated') || r.includes('permission denied') || r.includes('quota');
  }

  handleUnexpectedDisconnect() {
    if (this.userInitiatedDisconnect || this.isConnectingNow) return;
    if (this.lastErrorReason && this.isFatalError(this.lastErrorReason)) {
      const reason = this.lastErrorReason;
      this.disconnect();
      this.fail(reason);
      return;
    }
    // Model retired/renamed by Google: try the next model fast (under 1s),
    // instead of retrying a dead name forever.
    if (this.lastErrorReason && this.isModelNotFound(this.lastErrorReason)) {
      if (this.modelIndex < LIVE_MODELS.length - 1) {
        this.modelIndex++;
        this.reconnectAttempts = 0;
        console.log('[LiveSession] Model not found, trying ' + LIVE_MODELS[this.modelIndex]);
        this.fail('Model nahi mila — agla model try kar raha hoon...');
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.userInitiatedDisconnect) this.connectInternal(true);
        }, 800);
        return;
      }
      this.disconnect();
      this.fail('Koi Live model nahi mila — API key check karein');
      return;
    }
    if (this.connectionWatchdog) { clearTimeout(this.connectionWatchdog); this.connectionWatchdog = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.reconnectStartedAt === null) this.reconnectStartedAt = Date.now();
    if (!this.reconnectNoticeTimer && !this.shownReconnectingNotice) {
      const waited = Date.now() - this.reconnectStartedAt;
      const delay = Math.max(0, 10000 - waited);
      this.reconnectNoticeTimer = setTimeout(() => {
        this.reconnectNoticeTimer = null;
        if (!this.userInitiatedDisconnect && this.reconnectStartedAt !== null && !this.shownReconnectingNotice) {
          this.shownReconnectingNotice = true;
          this.fail('Reconnecting\u2026');
        }
      }, delay);
    }
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts++;
    const base = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
    const jitter = Math.round((Math.random() - 0.5) * 200);
    const delayMs = Math.max(500, Math.min(10000, base + jitter));
    console.log('[LiveSession] Connection dropped (' + (this.lastErrorReason || 'network') +
      '). Reconnecting attempt #' + this.reconnectAttempts + ' in ' + delayMs + 'ms...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.userInitiatedDisconnect) this.connectInternal(true);
    }, delayMs);
  }

  clearReconnectNotice() {
    if (this.reconnectNoticeTimer) { clearTimeout(this.reconnectNoticeTimer); this.reconnectNoticeTimer = null; }
    this.reconnectStartedAt = null;
    this.shownReconnectingNotice = false;
  }

  handleResumeTrigger(source) {
    if (this.userInitiatedDisconnect || this.status === 'disconnected') return;
    this.audioStreamer.resume();
    if (!this.liveSession || !this.isLiveReady) {
      if (!this.isConnectingNow) {
        console.log('[LiveSession] Reconnecting immediately on ' + source);
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.connectInternal(true);
      }
    }
  }

  closeLiveSessionOnly() {
    if (this.connectionWatchdog) { clearTimeout(this.connectionWatchdog); this.connectionWatchdog = null; }
    if (this.liveSession) {
      this.liveClosedByUs = true;
      try { this.liveSession.close(); } catch (e) { /* ignore */ }
      this.liveSession = null;
    }
    this.isLiveReady = false;
  }

  sendText(text) {
    const clean = (text || '').trim();
    if (!clean || !this.isLiveReady || !this.liveSession) return false;
    try {
      this.liveSession.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: clean }] }],
        turnComplete: true,
      });
    } catch (e) { console.warn('[LiveSession] Failed to send text:', e); return false; }
    this.setStatus('speaking');
    return true;
  }

  async requestMic() {
    const ok = await this.audioStreamer.attachMicrophone();
    if (ok) this.fail('');
    return ok;
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    this.audioStreamer.setMuted(this.isMuted);
    return this.isMuted;
  }
  getIsMuted() { return this.isMuted; }

  disconnect() {
    this.userInitiatedDisconnect = true;
    this.isConnectingNow = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearReconnectNotice();
    this.closeLiveSessionOnly();
    this.clearResumeHandle();
    this.audioStreamer.stopPlayback();
    this.setStatus('disconnected');
    AndroidBridge.stopForegroundService();
  }

  destroy() { this.disconnect(); }

  /* Tool calls from the server: run them locally, report back. */
  async handleToolCalls(functionCalls) {
    const responses = [];
    for (const call of functionCalls) {
      const id = call.id;
      const name = call.name;
      const args = call.args || {};
      let result = 'Action completed successfully';
      let ok = true;
      let iconType = 'default';
      let extra = {};
      try {
        switch (name) {
          case 'openAnyApp':
          case 'launchApp': {
            const appName = args.appName || 'Application';
            const r = await AndroidBridge.openAnyApp(appName);
            result = r.message; ok = r.ok; iconType = 'android_app'; extra = r; break;
          }
          case 'callContact': {
            const r = await AndroidBridge.callContact(args.name || '');
            result = r.message; ok = r.ok; iconType = 'phone'; extra = r; break;
          }
          case 'callNumber':
          case 'makePhoneCall': {
            const r = await AndroidBridge.callNumber(args.number || args.phoneNumber || '');
            result = r.message; ok = r.ok; iconType = 'phone'; extra = r; break;
          }
          case 'draftSms': {
            const r = await AndroidBridge.draftSms(args.nameOrNumber || '', args.message || '');
            result = r.message; ok = r.ok; iconType = 'message'; extra = r; break;
          }
          case 'openWhatsAppChat': {
            const r = await AndroidBridge.openWhatsAppChat(args.nameOrNumber || '', args.message);
            result = r.message; ok = r.ok; iconType = 'message'; extra = r; break;
          }
          case 'setFlashlight': {
            const on = !!args.on;
            const r = await AndroidBridge.setFlashlight(on);
            result = r.message; ok = r.ok; iconType = 'flashlight'; extra = r; break;
          }
          case 'setVolume': {
            const r = await AndroidBridge.setVolume(args.action || 'set', args.level !== undefined ? Number(args.level) : undefined);
            result = r.message; ok = r.ok; iconType = 'volume'; extra = r; break;
          }
          case 'setBrightness': {
            const r = await AndroidBridge.setBrightness(args.action || 'set', args.level !== undefined ? Number(args.level) : undefined);
            result = r.message; ok = r.ok; iconType = 'brightness'; extra = r; break;
          }
          case 'setAlarm': {
            const r = await AndroidBridge.setAlarm(Number(args.hour !== undefined ? args.hour : 7), Number(args.minute !== undefined ? args.minute : 0), args.label);
            result = r.message; ok = r.ok; iconType = 'alarm'; extra = r; break;
          }
          case 'setTimer': {
            const r = await AndroidBridge.setTimer(Number(args.seconds !== undefined ? args.seconds : 60), args.label);
            result = r.message; ok = r.ok; iconType = 'time'; extra = r; break;
          }
          case 'openCamera': {
            const r = await AndroidBridge.openCamera(args.mode || 'photo');
            result = r.message; ok = r.ok; iconType = 'camera'; extra = r; break;
          }
          case 'getBatteryStatus': {
            const r = await AndroidBridge.getBatteryStatus();
            result = r.message; ok = r.ok; iconType = 'battery'; extra = r; break;
          }
          case 'getNetworkStatus': {
            const r = await AndroidBridge.getNetworkStatus();
            result = r.message; ok = r.ok; iconType = 'wifi'; extra = r; break;
          }
          case 'playMedia': {
            const r = await AndroidBridge.playMedia(args.query || '', args.app || 'youtube');
            result = r.message; ok = r.ok; iconType = 'music'; extra = r; break;
          }
          case 'openCalendarOrCalculator': {
            const which = args.which || 'calculator';
            const r = await AndroidBridge.openCalendarOrCalculator(which);
            result = r.message; ok = r.ok; iconType = which.includes('calc') ? 'android_app' : 'time'; extra = r; break;
          }
          case 'openSystemSettings':
          case 'openDeviceSettings': {
            const r = await AndroidBridge.openSystemSettings(args.which || args.settingType || 'general');
            result = r.message; ok = r.ok; iconType = 'settings'; extra = r; break;
          }
          case 'openWebsite': {
            let url = (args.url || '').trim();
            if (url && !url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
            const r = await AndroidBridge.openAnyApp(args.siteName || url);
            result = r.message || ('Opened ' + (args.siteName || url)); ok = r.ok; iconType = 'link'; extra = r; break;
          }
          case 'openWebSearch': {
            const r = await AndroidBridge.performSearch((args.query || '').trim());
            result = r.message; ok = r.ok; iconType = 'search'; extra = r; break;
          }
          case 'openMapLocation': {
            const r = await AndroidBridge.openMapLocation(args.locationQuery || '');
            result = r.message; ok = r.ok; iconType = 'map'; extra = r; break;
          }
          case 'changeAtmosphere': {
            const theme = args.theme || 'neon-cyber';
            const moodTitle = args.moodTitle || 'Atmosphere Updated';
            if (this.callbacks.onThemeChange) this.callbacks.onThemeChange(theme, moodTitle);
            result = 'Switched theme to ' + theme + ' (' + moodTitle + ')';
            iconType = 'theme'; break;
          }
          case 'triggerReactionAnimation': {
            const reactionType = args.reactionType || 'wink';
            if (this.callbacks.onReaction) this.callbacks.onReaction({ type: reactionType, caption: args.wittyComment, timestamp: Date.now() });
            result = 'Reaction triggered: ' + reactionType;
            iconType = 'reaction'; break;
          }
          case 'getCurrentTimeAndDate': {
            const now = new Date();
            const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const date = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
            result = 'Current local time is ' + time + ' on ' + date;
            iconType = 'time'; break;
          }
          default:
            result = 'Command executed';
            break;
        }
      } catch (err) {
        ok = false;
        result = 'Failed: ' + ((err && err.message) || 'Error occurred');
      }
      if (this.callbacks.onToolExecuted) {
        this.callbacks.onToolExecuted({ id, name, args, result, timestamp: Date.now(), iconType });
      }
      responses.push({ id, response: { ok, status: ok ? 'success' : 'failure', result, ...extra } });
    }
    if (this.liveSession && responses.length > 0) {
      try {
        this.liveSession.sendToolResponse({
          functionResponses: responses.map((r) => ({
            id: r.id,
            name: this.pendingToolNames.get(r.id) || '',
            response: {
              result: (r.response && r.response.result) || '',
              ok: !!(r.response && r.response.ok),
              status: (r.response && r.response.status) || '',
            },
          })),
        });
      } catch (e) { console.warn('[LiveSession] Failed to send tool response:', e); }
      for (const r of responses) this.pendingToolNames.delete(r.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                           */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  orbWrap: $('orbWrap'),
  statusText: $('statusText'),
  statusSub: $('statusSub'),
  reactionCaption: $('reactionCaption'),
  transcript: $('transcript'),
  micBtn: $('micBtn'),
  muteBtn: $('muteBtn'),
  themeBtn: $('themeBtn'),
  textInput: $('textInput'),
  sendTextBtn: $('sendTextBtn'),
  settingsBtn: $('settingsBtn'),
  panelOverlay: $('panelOverlay'),
  panelCloseBtn: $('panelCloseBtn'),
  panelSaveBtn: $('panelSaveBtn'),
  firstName: $('firstName'),
  lastName: $('lastName'),
  memory: $('memory'),
  apiKey: $('apiKey'),
  voiceMale: $('voiceMale'),
  voiceFemale: $('voiceFemale'),
  toast: $('toast'),
  debugLine: $('debugLine'),
};

let toastTimer = null;
function showToast(text) {
  if (!text) return;
  els.toast.textContent = text;
  els.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2000);
}

/* Persistent diagnostic line under the status: toasts fade after 2s,
   so without this the real failure reason vanishes before a screenshot. */
function setDebug(text) {
  if (els.debugLine) els.debugLine.textContent = text || '';
}

const STATUS_LABELS = {
  connecting: ['Connecting...', 'Talking to Gemini Live'],
  listening: ['Listening...', 'Rox is listening...'],
  speaking: ['Rox is speaking...', 'Tap the mic to stop'],
  disconnected: ['Tap the mic to start', 'Rox Assistant'],
};

const session = new LiveSession({
  onStatus(status) {
    const [title, sub] = STATUS_LABELS[status] || STATUS_LABELS.disconnected;
    els.statusText.textContent = title;
    els.statusSub.textContent = sub;
    els.orbWrap.classList.remove('speaking', 'listening');
    if (status === 'speaking') els.orbWrap.classList.add('speaking');
    if (status === 'listening') els.orbWrap.classList.add('listening');
    els.micBtn.classList.toggle('live', status !== 'disconnected');
    els.micBtn.innerHTML = status === 'disconnected' ? '&#127908;' : '&#9632;';
    els.micBtn.title = status === 'disconnected' ? 'Tap to start' : 'Tap to stop';
    els.sendTextBtn.disabled = status === 'disconnected';
  },
  onError(message) {
    if (message) { showToast(message); setDebug(message); }
  },
  onDebug(text) {
    setDebug(text);
  },
  onText(text) {
    els.transcript.style.display = 'block';
    els.transcript.textContent = text;
  },
  onThemeChange(theme) {
    const known = ['neon-cyber', 'sunset', 'rose', 'violet'];
    els.app.dataset.theme = known.includes(theme) ? theme : 'default';
    showToast('Atmosphere updated');
  },
  onReaction(reaction) {
    els.orbWrap.classList.remove('wink');
    void els.orbWrap.offsetWidth; // restart the animation
    els.orbWrap.classList.add('wink');
    els.reactionCaption.textContent = reaction.caption || '';
    setTimeout(() => { els.reactionCaption.textContent = ''; }, 4000);
  },
  onToolExecuted(tool) {
    showToast(tool.result);
  },
});

els.micBtn.addEventListener('click', async () => {
  AndroidBridge.vibrate(40);
  if (session.status === 'disconnected') {
    if (!cleanApiKey()) {
      showToast('Add your API Key from the profile icon to start Rox');
      openPanel();
      return;
    }
    if (!(await session.requestMic())) {
      showToast(session.audioStreamer.micError || 'Microphone unavailable');
      return;
    }
    await session.start();
  } else {
    session.disconnect();
  }
});

els.muteBtn.addEventListener('click', () => {
  const muted = session.toggleMute();
  els.muteBtn.classList.toggle('off', muted);
  els.muteBtn.innerHTML = muted ? '&#128263;' : '&#128266;';
  showToast(muted ? 'Microphone muted' : 'Microphone on');
});

const THEMES = ['default', 'neon-cyber', 'sunset', 'rose', 'violet'];
let themeIndex = 0;
els.themeBtn.addEventListener('click', () => {
  themeIndex = (themeIndex + 1) % THEMES.length;
  els.app.dataset.theme = THEMES[themeIndex];
  showToast('Atmosphere: ' + THEMES[themeIndex]);
});

els.sendTextBtn.addEventListener('click', sendTypedText);
els.textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTypedText(); });
function sendTypedText() {
  const text = els.textInput.value;
  if (session.sendText(text)) {
    els.transcript.style.display = 'block';
    els.transcript.textContent = 'You: ' + text.trim();
    els.textInput.value = '';
  }
}

/* Settings panel */
let pickedVoice = getProfile().voice;
function openPanel() {
  const profile = getProfile();
  els.firstName.value = profile.firstName;
  els.lastName.value = profile.lastName;
  els.memory.value = profile.memory;
  els.apiKey.value = profile.apiKey;
  pickedVoice = profile.voice;
  markVoiceButtons();
  els.panelOverlay.classList.add('open');
}
function closePanel() { els.panelOverlay.classList.remove('open'); }
function markVoiceButtons() {
  els.voiceMale.classList.toggle('selected', pickedVoice === 'male');
  els.voiceFemale.classList.toggle('selected', pickedVoice === 'female');
}
els.settingsBtn.addEventListener('click', openPanel);
els.panelCloseBtn.addEventListener('click', closePanel);
els.panelOverlay.addEventListener('click', (e) => { if (e.target === els.panelOverlay) closePanel(); });
els.voiceMale.addEventListener('click', () => { pickedVoice = 'male'; markVoiceButtons(); });
els.voiceFemale.addEventListener('click', () => { pickedVoice = 'female'; markVoiceButtons(); });

els.panelSaveBtn.addEventListener('click', async () => {
  const oldVoice = getProfile().voice;
  store.set(LS.firstName, els.firstName.value.trim());
  store.set(LS.lastName, els.lastName.value.trim());
  store.set(LS.memory, els.memory.value.trim());
  store.set(LS.apiKey, els.apiKey.value.trim());
  store.set(LS.voice, pickedVoice);
  closePanel();
  showToast('Profile saved');
  // Voice change needs a fresh Live session, like the original.
  if (pickedVoice !== oldVoice && session.status !== 'disconnected') {
    session.disconnect();
    setTimeout(() => session.start().catch((e) => console.warn(e)), 150);
  }
});

// Offline notice, same idea as the original's offline page.
window.addEventListener('offline', () => showToast('Still offline. Check your Wi-Fi or mobile data.'));
