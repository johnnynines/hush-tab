// Diagnostic Content Script for Hush Tab
// Captures console logs, network requests, DOM changes, and player state
// to help identify ad detection signals

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.__hushTabDiagnosticLoaded) {
    console.log('[Hush Tab Diagnostic] Already loaded, skipping');
    return;
  }
  window.__hushTabDiagnosticLoaded = true;

  // Configuration
  const CONFIG = {
    MAX_ENTRIES: 500,           // Max entries to store per category
    DOM_DEBOUNCE_MS: 100,       // Debounce DOM mutation logging
    VIDEO_POLL_INTERVAL_MS: 500, // Poll video state every 500ms
  };

  // Data storage
  const diagnosticData = {
    consoleLogs: [],
    networkRequests: [],
    domMutations: [],
    videoEvents: [],
    playerState: [],
    startTime: Date.now(),
    platform: detectPlatform(),
    isRecording: false,
  };

  // Detect which platform we're on
  function detectPlatform() {
    const hostname = window.location.hostname;
    if (hostname.includes('youtube.com')) return 'youtube';
    if (hostname.includes('hulu.com')) return 'hulu';
    if (hostname.includes('espn.com')) return 'espn';
    if (hostname.includes('nbc.com')) return 'nbc';
    return 'unknown';
  }

  // Create timestamp relative to start
  function relativeTime() {
    return Date.now() - diagnosticData.startTime;
  }

  // Add entry to array with max limit
  function addEntry(array, entry) {
    if (!diagnosticData.isRecording) return;
    array.push({ ...entry, timestamp: relativeTime() });
    if (array.length > CONFIG.MAX_ENTRIES) {
      array.shift();
    }
  }

  // =========================================
  // CONSOLE LOG CAPTURE
  // =========================================
  function setupConsoleCapture() {
    const originalConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console),
    };

    function captureLog(level, args) {
      try {
        const message = Array.from(args).map(arg => {
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg, null, 2).substring(0, 500);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        }).join(' ');

        // Filter out our own diagnostic logs
        if (message.includes('[Hush Tab Diagnostic]')) return;

        addEntry(diagnosticData.consoleLogs, {
          level,
          message: message.substring(0, 1000),
          stack: new Error().stack?.split('\n').slice(2, 5).join('\n'),
        });
      } catch (e) {
        // Ignore errors in capture
      }
    }

    console.log = function(...args) {
      captureLog('log', args);
      originalConsole.log(...args);
    };

    console.warn = function(...args) {
      captureLog('warn', args);
      originalConsole.warn(...args);
    };

    console.error = function(...args) {
      captureLog('error', args);
      originalConsole.error(...args);
    };

    console.info = function(...args) {
      captureLog('info', args);
      originalConsole.info(...args);
    };

    console.debug = function(...args) {
      captureLog('debug', args);
      originalConsole.debug(...args);
    };

    console.log('[Hush Tab Diagnostic] Console capture initialized');
  }

  // =========================================
  // NETWORK REQUEST CAPTURE
  // =========================================
  function setupNetworkCapture() {
    // Capture fetch requests
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method || 'GET';

      const startTime = relativeTime();

      try {
        const response = await originalFetch.apply(this, arguments);

        addEntry(diagnosticData.networkRequests, {
          type: 'fetch',
          method,
          url: url.substring(0, 500),
          status: response.status,
          duration: relativeTime() - startTime,
          isAdRelated: isAdRelatedUrl(url),
        });

        return response;
      } catch (error) {
        addEntry(diagnosticData.networkRequests, {
          type: 'fetch',
          method,
          url: url.substring(0, 500),
          error: error.message,
          duration: relativeTime() - startTime,
          isAdRelated: isAdRelatedUrl(url),
        });
        throw error;
      }
    };

    // Capture XHR requests
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this._diagnosticData = { method, url: String(url).substring(0, 500), startTime: null };
      return originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function() {
      if (this._diagnosticData) {
        this._diagnosticData.startTime = relativeTime();

        this.addEventListener('load', () => {
          addEntry(diagnosticData.networkRequests, {
            type: 'xhr',
            method: this._diagnosticData.method,
            url: this._diagnosticData.url,
            status: this.status,
            duration: relativeTime() - this._diagnosticData.startTime,
            isAdRelated: isAdRelatedUrl(this._diagnosticData.url),
          });
        });

        this.addEventListener('error', () => {
          addEntry(diagnosticData.networkRequests, {
            type: 'xhr',
            method: this._diagnosticData.method,
            url: this._diagnosticData.url,
            error: 'Network error',
            duration: relativeTime() - this._diagnosticData.startTime,
            isAdRelated: isAdRelatedUrl(this._diagnosticData.url),
          });
        });
      }
      return originalXHRSend.apply(this, arguments);
    };

    console.log('[Hush Tab Diagnostic] Network capture initialized');
  }

  // Check if URL is ad-related
  function isAdRelatedUrl(url) {
    const adPatterns = [
      'doubleclick', 'googlesyndication', 'googleadservices', 'moatads',
      '2mdn.net', 'imasdk', 'pubads', 'securepubads', 'fwmrm.net',
      'uplynk', 'innovid', 'spotxchange', 'springserve', '/ads/',
      '/ad/', 'adserver', 'ad-', '-ad', 'advertisement', 'pagead',
      'adservice', 'tracking', 'beacon', 'analytics'
    ];
    const lowerUrl = url.toLowerCase();
    return adPatterns.some(pattern => lowerUrl.includes(pattern));
  }

  // =========================================
  // DOM MUTATION CAPTURE
  // =========================================
  function setupDOMMutationCapture() {
    let pendingMutations = [];
    let debounceTimer = null;

    // Selectors that are interesting for ad detection
    const interestingSelectors = [
      // YouTube
      '.ad-showing', '.ad-interrupting', '.ytp-ad', '.video-ads',
      // Hulu
      '.ad-', 'ad-break', 'commercial', '.controls__ad',
      // ESPN
      '.ima-', 'google-ima', '.ad-container', '.ad-overlay',
      // Generic
      '[class*="ad"]', '[class*="Ad"]', '[id*="ad"]', '[id*="Ad"]',
      '[data-ad]', '.advertisement', '.commercial',
    ];

    function isInterestingMutation(mutation) {
      const target = mutation.target;
      if (!target || !target.classList) return false;

      // Check if class/id contains interesting patterns
      const classStr = target.className?.toString() || '';
      const idStr = target.id || '';
      const combined = (classStr + ' ' + idStr).toLowerCase();

      // Check for ad-related patterns
      if (combined.includes('ad') || combined.includes('commercial') ||
          combined.includes('ima') || combined.includes('sponsor')) {
        return true;
      }

      // Check if any interesting selector matches
      try {
        for (const selector of interestingSelectors) {
          if (target.matches?.(selector) || target.querySelector?.(selector)) {
            return true;
          }
        }
      } catch {
        // Ignore selector errors
      }

      return false;
    }

    function processMutations() {
      if (pendingMutations.length === 0) return;

      const summary = {
        addedNodes: 0,
        removedNodes: 0,
        attributeChanges: [],
        classChanges: [],
        interestingElements: [],
      };

      pendingMutations.forEach(mutation => {
        if (mutation.type === 'childList') {
          summary.addedNodes += mutation.addedNodes.length;
          summary.removedNodes += mutation.removedNodes.length;

          // Check added nodes for interesting content
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) {
              const info = describeElement(node);
              if (info.isInteresting) {
                summary.interestingElements.push({
                  action: 'added',
                  ...info,
                });
              }
            }
          });

          // Check removed nodes
          mutation.removedNodes.forEach(node => {
            if (node.nodeType === 1) {
              const info = describeElement(node);
              if (info.isInteresting) {
                summary.interestingElements.push({
                  action: 'removed',
                  ...info,
                });
              }
            }
          });
        } else if (mutation.type === 'attributes') {
          const attrName = mutation.attributeName;
          const target = mutation.target;

          if (attrName === 'class') {
            const oldVal = mutation.oldValue || '';
            const newVal = target.className?.toString() || '';
            if (oldVal !== newVal) {
              summary.classChanges.push({
                element: describeElement(target),
                oldClasses: oldVal.substring(0, 200),
                newClasses: newVal.substring(0, 200),
              });
            }
          } else if (isInterestingMutation(mutation)) {
            summary.attributeChanges.push({
              element: describeElement(target),
              attribute: attrName,
              oldValue: String(mutation.oldValue).substring(0, 100),
              newValue: String(target.getAttribute(attrName)).substring(0, 100),
            });
          }
        }
      });

      // Only log if there's something interesting
      if (summary.interestingElements.length > 0 ||
          summary.classChanges.length > 0 ||
          summary.attributeChanges.length > 0) {
        addEntry(diagnosticData.domMutations, summary);
      }

      pendingMutations = [];
    }

    function describeElement(element) {
      if (!element || !element.tagName) return { tag: 'unknown', isInteresting: false };

      const tag = element.tagName.toLowerCase();
      const id = element.id || '';
      const classes = element.className?.toString() || '';
      const dataAttrs = {};

      // Get data attributes
      if (element.dataset) {
        Object.keys(element.dataset).slice(0, 5).forEach(key => {
          dataAttrs[key] = String(element.dataset[key]).substring(0, 50);
        });
      }

      const combined = (tag + ' ' + id + ' ' + classes).toLowerCase();
      const isInteresting = combined.includes('ad') || combined.includes('player') ||
                           combined.includes('video') || combined.includes('commercial') ||
                           combined.includes('ima') || combined.includes('sponsor');

      return {
        tag,
        id: id.substring(0, 50),
        classes: classes.substring(0, 200),
        dataAttrs,
        isInteresting,
        textContent: element.textContent?.substring(0, 100)?.trim(),
      };
    }

    const observer = new MutationObserver((mutations) => {
      if (!diagnosticData.isRecording) return;

      pendingMutations.push(...mutations);

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(processMutations, CONFIG.DOM_DEBOUNCE_MS);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-ad-state', 'data-playing'],
    });

    console.log('[Hush Tab Diagnostic] DOM mutation capture initialized');
  }

  // =========================================
  // VIDEO ELEMENT MONITORING
  // =========================================
  function setupVideoMonitoring() {
    let videoElements = [];
    let pollInterval = null;

    function findVideoElements() {
      videoElements = Array.from(document.querySelectorAll('video'));
    }

    function captureVideoState() {
      if (!diagnosticData.isRecording) return;

      findVideoElements();

      videoElements.forEach((video, index) => {
        const state = {
          index,
          currentTime: video.currentTime,
          duration: video.duration,
          paused: video.paused,
          muted: video.muted,
          volume: video.volume,
          src: video.src?.substring(0, 200) || video.currentSrc?.substring(0, 200),
          readyState: video.readyState,
          networkState: video.networkState,
          buffered: video.buffered.length > 0 ? {
            start: video.buffered.start(0),
            end: video.buffered.end(video.buffered.length - 1),
          } : null,
          parentClasses: video.parentElement?.className?.substring(0, 100),
          videoId: video.id || video.getAttribute('data-video-id'),
        };

        // Platform-specific state
        if (diagnosticData.platform === 'youtube') {
          state.ytPlayer = captureYouTubePlayerState();
        } else if (diagnosticData.platform === 'hulu') {
          state.huluPlayer = captureHuluPlayerState();
        } else if (diagnosticData.platform === 'espn') {
          state.espnPlayer = captureESPNPlayerState();
        }

        addEntry(diagnosticData.playerState, state);
      });
    }

    function setupVideoEventListeners(video) {
      const events = ['play', 'pause', 'seeking', 'seeked', 'ended', 'error',
                      'loadstart', 'loadedmetadata', 'waiting', 'playing',
                      'volumechange', 'ratechange'];

      events.forEach(eventName => {
        video.addEventListener(eventName, (e) => {
          addEntry(diagnosticData.videoEvents, {
            event: eventName,
            currentTime: video.currentTime,
            duration: video.duration,
            src: video.src?.substring(0, 100),
          });
        });
      });
    }

    // Watch for new video elements
    const videoObserver = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeName === 'VIDEO') {
            setupVideoEventListeners(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('video').forEach(setupVideoEventListeners);
          }
        });
      });
    });

    videoObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Setup existing videos
    document.querySelectorAll('video').forEach(setupVideoEventListeners);

    // Start polling
    pollInterval = setInterval(captureVideoState, CONFIG.VIDEO_POLL_INTERVAL_MS);

    console.log('[Hush Tab Diagnostic] Video monitoring initialized');
  }

  // =========================================
  // PLATFORM-SPECIFIC PLAYER STATE CAPTURE
  // =========================================
  function captureYouTubePlayerState() {
    try {
      const player = document.querySelector('.html5-video-player');
      if (!player) return null;

      return {
        classList: player.className,
        adShowing: player.classList.contains('ad-showing'),
        adInterrupting: player.classList.contains('ad-interrupting'),
        adModule: !!document.querySelector('.ytp-ad-module'),
        adModuleChildren: document.querySelector('.ytp-ad-module')?.children.length || 0,
        skipButton: !!document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button'),
        adPreviewText: document.querySelector('.ytp-ad-preview-text')?.textContent,
        adText: document.querySelector('.ytp-ad-text')?.textContent,
        adBadge: !!document.querySelector('.ytp-ad-badge'),
        adOverlay: !!document.querySelector('.ytp-ad-player-overlay'),
        progressBar: document.querySelector('.ytp-progress-bar')?.getAttribute('aria-valuenow'),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  function captureHuluPlayerState() {
    try {
      return {
        adBreakMarker: !!document.querySelector('.controls__ad-break'),
        adCountdown: document.querySelector('[class*="ad-countdown"]')?.textContent,
        resumeText: document.querySelector('[class*="resume"]')?.textContent,
        controlsDisabled: !!document.querySelector('.controls--disabled'),
        adOverlay: !!document.querySelector('[class*="ad-overlay"]'),
        playerClasses: document.querySelector('[class*="player"]')?.className?.substring(0, 200),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  function captureESPNPlayerState() {
    try {
      // Check for ESPN's video player API
      const espnAdPlaying = window.espn?.video?.player?.adPlaying;

      return {
        espnApiAdPlaying: espnAdPlaying,
        imaContainer: !!document.querySelector('.ima-ad-container, [class*="google-ima"]'),
        adOverlay: !!document.querySelector('[class*="ad-overlay"], [class*="commercial"]'),
        adCountdown: document.querySelector('[class*="ad-count"]')?.textContent,
        adBadge: document.querySelector('[class*="ad-badge"]')?.textContent,
        playerClasses: document.querySelector('[class*="player"]')?.className?.substring(0, 200),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  // =========================================
  // GLOBAL OBJECT INSPECTION
  // =========================================
  function captureGlobalObjects() {
    const interesting = {};

    // YouTube
    if (window.ytInitialPlayerResponse) {
      interesting.ytInitialPlayerResponse = {
        exists: true,
        hasAds: !!window.ytInitialPlayerResponse?.adPlacements,
      };
    }
    if (window.yt?.player) {
      interesting.ytPlayer = { exists: true };
    }

    // Hulu
    if (window.__HULU_WEB_CLIENT__) {
      interesting.huluWebClient = { exists: true };
    }

    // ESPN
    if (window.espn) {
      interesting.espn = {
        exists: true,
        hasVideoPlayer: !!window.espn?.video?.player,
      };
    }

    // Google IMA SDK
    if (window.google?.ima) {
      interesting.googleIMA = { exists: true };
    }

    return interesting;
  }

  // =========================================
  // MESSAGE HANDLING
  // =========================================
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'startDiagnostic') {
        diagnosticData.isRecording = true;
        diagnosticData.startTime = Date.now();
        diagnosticData.consoleLogs = [];
        diagnosticData.networkRequests = [];
        diagnosticData.domMutations = [];
        diagnosticData.videoEvents = [];
        diagnosticData.playerState = [];
        console.log('[Hush Tab Diagnostic] Recording started');
        sendResponse({ success: true, platform: diagnosticData.platform });
        return true;
      }

      if (request.action === 'stopDiagnostic') {
        diagnosticData.isRecording = false;
        console.log('[Hush Tab Diagnostic] Recording stopped');
        sendResponse({ success: true });
        return true;
      }

      if (request.action === 'getDiagnosticData') {
        const data = {
          ...diagnosticData,
          globalObjects: captureGlobalObjects(),
          url: window.location.href,
          userAgent: navigator.userAgent,
          recordingDuration: diagnosticData.isRecording ? relativeTime() : null,
        };
        sendResponse({ success: true, data });
        return true;
      }

      if (request.action === 'getDiagnosticStatus') {
        sendResponse({
          success: true,
          isRecording: diagnosticData.isRecording,
          platform: diagnosticData.platform,
          entryCounts: {
            consoleLogs: diagnosticData.consoleLogs.length,
            networkRequests: diagnosticData.networkRequests.length,
            domMutations: diagnosticData.domMutations.length,
            videoEvents: diagnosticData.videoEvents.length,
            playerState: diagnosticData.playerState.length,
          },
        });
        return true;
      }

      if (request.action === 'markAdStart') {
        addEntry(diagnosticData.videoEvents, {
          event: 'USER_MARKED_AD_START',
          note: request.note || 'User indicated ad started',
        });
        sendResponse({ success: true });
        return true;
      }

      if (request.action === 'markAdEnd') {
        addEntry(diagnosticData.videoEvents, {
          event: 'USER_MARKED_AD_END',
          note: request.note || 'User indicated ad ended',
        });
        sendResponse({ success: true });
        return true;
      }
    });
  }

  // =========================================
  // INITIALIZATION
  // =========================================
  function initialize() {
    console.log(`[Hush Tab Diagnostic] Initializing for platform: ${diagnosticData.platform}`);

    setupMessageListener();
    setupConsoleCapture();
    setupNetworkCapture();
    setupDOMMutationCapture();
    setupVideoMonitoring();

    console.log('[Hush Tab Diagnostic] All systems initialized. Ready to record.');
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
