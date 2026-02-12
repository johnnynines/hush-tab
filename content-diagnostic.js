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
    MAX_ENTRIES: 1000,          // Max entries to store per category (increased)
    DOM_DEBOUNCE_MS: 50,        // Faster DOM mutation capture
    VIDEO_POLL_INTERVAL_MS: 500, // Poll video state every 500ms
    ELEMENT_SNAPSHOT_INTERVAL_MS: 1000, // Snapshot key elements every second
  };

  // Data storage
  const diagnosticData = {
    consoleLogs: [],
    networkRequests: [],
    domMutations: [],
    videoEvents: [],
    playerState: [],
    audioSignals: [],          // Volume changes, silence, discontinuities
    elementSnapshots: [],
    userMarkers: [],
    startTime: Date.now(),
    platform: detectPlatform(),
    isRecording: false,
  };

  // Track previous video state for detecting discontinuities
  // Keyed by a stable identifier per video element
  const previousVideoState = new Map();

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
  // Uses PerformanceObserver to capture network activity from the page context.
  // Content scripts run in an isolated world and cannot intercept the page's
  // fetch/XHR calls directly. PerformanceObserver sees all resource loads
  // regardless of JS context isolation.
  const TRACKED_INITIATOR_TYPES = new Set([
    'fetch', 'xmlhttprequest',  // Fetch/XHR
    'script',                    // JS
    'video', 'audio', 'media',  // Media
  ]);

  function setupNetworkCapture() {
    // Capture new resource loads in real-time
    try {
      const observer = new PerformanceObserver((list) => {
        if (!diagnosticData.isRecording) return;

        for (const entry of list.getEntries()) {
          if (!TRACKED_INITIATOR_TYPES.has(entry.initiatorType)) continue;

          addEntry(diagnosticData.networkRequests, {
            type: entry.initiatorType,
            url: entry.name.substring(0, 500),
            duration: Math.round(entry.duration),
            transferSize: entry.transferSize || 0,
            isAdRelated: isAdRelatedUrl(entry.name),
          });
        }
      });

      observer.observe({ type: 'resource', buffered: false });
    } catch (e) {
      console.warn('[Hush Tab Diagnostic] PerformanceObserver not available:', e.message);
    }

    console.log('[Hush Tab Diagnostic] Network capture initialized (PerformanceObserver)');
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

    // Patterns that indicate ad-related elements. Uses word-boundary-aware
    // matching to avoid false positives from substrings like "loading",
    // "padding", "shadow", "header", etc.
    const AD_PATTERNS = [
      // Word-boundary regex patterns for ad-related terms
      /\bad[s]?\b/i,          // "ad", "ads" as whole words
      /\bad[-_]/i,            // "ad-showing", "ad_container", etc.
      /[-_]ad\b/i,            // "video-ad", "pre_ad", etc.
      /\bcommercial/i,        // "commercial", "commercial-break"
      /\bima[-_]/i,           // "ima-ad-container", "ima_sdk"
      /\bsponsor/i,           // "sponsor", "sponsored"
      /\bytp-ad/i,            // YouTube-specific "ytp-ad-*"
      /\bvideo-ads?\b/i,      // "video-ad", "video-ads"
      /\bvjs-ad/i,            // Video.js "vjs-ad-playing"
      /\bad-showing\b/i,      // YouTube "ad-showing"
      /\bad-interrupting\b/i, // YouTube "ad-interrupting"
      /\bcontrols__ad/i,      // Hulu "controls__ad-break"
      /\bgoogle-ima/i,        // ESPN/generic Google IMA
      /\badvertis/i,          // "advertisement", "advertising"
    ];

    // Selectors for interesting elements in childList mutations
    const interestingSelectors = [
      // YouTube
      '.ad-showing', '.ad-interrupting', '[class*="ytp-ad"]', '.video-ads',
      // Hulu
      '[class*="ad-break"]', '[class*="controls__ad"]',
      // ESPN
      '[class*="ima-"]', '.google-ima', '[class*="ad-container"]', '[class*="ad-overlay"]',
      // NBC
      '.vjs-ad-playing', '.vjs-ad-loading', '[class*="player-controls"]',
      // Generic
      '[data-ad]', '[data-ad-state]', '.advertisement', '.commercial',
    ];

    // Test if a string contains ad-related patterns using word-boundary matching
    function containsAdPattern(str) {
      if (!str) return false;
      return AD_PATTERNS.some(pattern => pattern.test(str));
    }

    // Check if a class change is interesting by examining BOTH old and new values.
    // This is critical: when an element transitions FROM a non-ad state TO an ad
    // state (e.g., gaining "ad-showing"), the OLD class string won't contain "ad"
    // but the NEW one will. We must check both directions.
    function isInterestingClassChange(oldVal, newVal) {
      // Check if either the old or new class string contains ad patterns
      if (containsAdPattern(oldVal) || containsAdPattern(newVal)) {
        return true;
      }

      // Also check for player/video elements -- we want to track class changes
      // on the video player container itself even if the classes don't say "ad"
      // because these are the elements that GET ad classes added to them
      const combined = (oldVal + ' ' + newVal).toLowerCase();
      if (combined.includes('player') || combined.includes('video-js') ||
          combined.includes('html5-video') || combined.includes('vjs-')) {
        return true;
      }

      return false;
    }

    // Check if a non-class attribute mutation is interesting
    function isInterestingMutation(mutation) {
      const target = mutation.target;
      if (!target || !target.classList) return false;

      // For attribute mutations, check the element's identity and the
      // old/new attribute values
      const classStr = target.className?.toString() || '';
      const idStr = target.id || '';
      const oldAttrVal = mutation.oldValue || '';
      const newAttrVal = target.getAttribute(mutation.attributeName) || '';

      // Check element identity (class/id)
      if (containsAdPattern(classStr) || containsAdPattern(idStr)) {
        return true;
      }

      // Check attribute values themselves
      if (containsAdPattern(oldAttrVal) || containsAdPattern(newAttrVal)) {
        return true;
      }

      // Check for player/video elements that may receive ad state changes
      const combined = (classStr + ' ' + idStr).toLowerCase();
      if (combined.includes('player') || combined.includes('video') ||
          combined.includes('controls') || combined.includes('progress')) {
        return true;
      }

      // Check if any interesting selector matches the target
      try {
        for (const selector of interestingSelectors) {
          if (target.matches?.(selector)) {
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
              // Also check children of added nodes for interesting elements
              try {
                for (const selector of interestingSelectors) {
                  const matches = node.querySelectorAll?.(selector);
                  if (matches) {
                    matches.forEach(match => {
                      const matchInfo = describeElement(match);
                      if (matchInfo.isInteresting) {
                        summary.interestingElements.push({
                          action: 'added (child)',
                          ...matchInfo,
                        });
                      }
                    });
                  }
                }
              } catch {
                // Ignore selector errors on detached nodes
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
              // Filter: only record class changes that are interesting.
              // Check both old and new values so we catch transitions in
              // both directions (gaining ad classes AND losing them).
              if (isInterestingClassChange(oldVal, newVal)) {
                // Compute the actual diff for clearer output
                const oldSet = new Set(oldVal.split(/\s+/).filter(Boolean));
                const newSet = new Set(newVal.split(/\s+/).filter(Boolean));
                const added = [...newSet].filter(c => !oldSet.has(c));
                const removed = [...oldSet].filter(c => !newSet.has(c));

                summary.classChanges.push({
                  element: describeElement(target),
                  oldClasses: oldVal.substring(0, 300),
                  newClasses: newVal.substring(0, 300),
                  addedClasses: added,
                  removedClasses: removed,
                });
              }
            }
          } else if (isInterestingMutation(mutation)) {
            summary.attributeChanges.push({
              element: describeElement(target),
              attribute: attrName,
              oldValue: String(mutation.oldValue).substring(0, 200),
              newValue: String(target.getAttribute(attrName)).substring(0, 200),
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
        Object.keys(element.dataset).slice(0, 10).forEach(key => {
          dataAttrs[key] = String(element.dataset[key]).substring(0, 50);
        });
      }

      // Use word-boundary-aware matching rather than naive .includes('ad')
      // to avoid false positives from "loading", "padding", "shadow", etc.
      const isAdRelated = containsAdPattern(id) || containsAdPattern(classes);
      const combined = (tag + ' ' + id + ' ' + classes).toLowerCase();
      const isPlayerRelated = combined.includes('player') || combined.includes('video') ||
                              combined.includes('controls') || tag === 'video';
      const isInteresting = isAdRelated || isPlayerRelated ||
                           containsAdPattern(combined);

      return {
        tag,
        id: id.substring(0, 50),
        classes: classes.substring(0, 200),
        dataAttrs,
        isInteresting,
        isAdRelated,
        textContent: element.textContent?.substring(0, 100)?.trim(),
      };
    }

    const observer = new MutationObserver((mutations) => {
      if (!diagnosticData.isRecording) return;

      pendingMutations.push(...mutations);

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(processMutations, CONFIG.DOM_DEBOUNCE_MS);
    });

    // Observe a broader set of attributes to capture all ad-related state changes.
    // Streaming platforms use various data attributes and ARIA attributes to
    // communicate ad state, seek-bar disablement, and player mode changes.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [
        'class',              // Class changes (ad-showing, vjs-ad-playing, etc.)
        'style',              // Visibility/display changes during ads
        'hidden',             // Elements hidden/shown during ads
        'disabled',           // Controls disabled during ads
        'src',                // Video source changes (ad vs content)
        'data-ad-state',      // Generic ad state
        'data-ad',            // Generic ad flag
        'data-ad-break',      // Hulu ad break markers
        'data-playing',       // Player state
        'data-state',         // Generic player state
        'aria-label',         // Accessible labels (often contain "ad" text)
        'aria-disabled',      // Seek bar disabled during ads (NBC/Hulu)
        'aria-hidden',        // Elements aria-hidden during ad transitions
        'aria-valuenow',      // Progress bar value changes
        'aria-valuemax',      // Progress bar max (changes with ad vs content duration)
      ],
    });

    console.log('[Hush Tab Diagnostic] DOM mutation capture initialized');
  }

  // =========================================
  // VIDEO ELEMENT MONITORING
  // =========================================
  function setupVideoMonitoring() {
    let videoElements = [];
    let pollInterval = null;

    // Get a stable key for a video element across polls
    function getVideoKey(video, index) {
      return video.id || video.getAttribute('data-video-id') || `video-${index}`;
    }

    function findVideoElements() {
      videoElements = Array.from(document.querySelectorAll('video'));
    }

    function captureVideoState() {
      if (!diagnosticData.isRecording) return;

      findVideoElements();

      videoElements.forEach((video, index) => {
        const key = getVideoKey(video, index);
        const prev = previousVideoState.get(key);
        const currentSrc = video.src?.substring(0, 200) || video.currentSrc?.substring(0, 200);

        const state = {
          index,
          currentTime: video.currentTime,
          duration: video.duration,
          paused: video.paused,
          muted: video.muted,
          volume: video.volume,
          src: currentSrc,
          readyState: video.readyState,
          networkState: video.networkState,
          buffered: video.buffered.length > 0 ? {
            start: video.buffered.start(0),
            end: video.buffered.end(video.buffered.length - 1),
          } : null,
          parentClasses: video.parentElement?.className?.substring(0, 100),
          videoId: video.id || video.getAttribute('data-video-id'),
        };

        // ---- Discontinuity & change detection ----
        if (prev) {
          const timeDelta = video.currentTime - prev.currentTime;
          const expectedDelta = CONFIG.VIDEO_POLL_INTERVAL_MS / 1000;

          // currentTime jump detection: time moved backward, or jumped
          // forward much more than one poll interval would explain
          if (!video.paused && !video.seeking) {
            if (timeDelta < -0.5) {
              addEntry(diagnosticData.audioSignals, {
                signal: 'TIME_JUMP_BACKWARD',
                videoKey: key,
                from: prev.currentTime,
                to: video.currentTime,
                delta: timeDelta,
                note: 'currentTime jumped backward (possible ad segment loaded)',
              });
            } else if (timeDelta > expectedDelta * 3 && timeDelta > 2) {
              addEntry(diagnosticData.audioSignals, {
                signal: 'TIME_JUMP_FORWARD',
                videoKey: key,
                from: prev.currentTime,
                to: video.currentTime,
                delta: timeDelta,
                note: 'currentTime jumped forward unexpectedly',
              });
            }

            // Time stall: video not paused but time hasn't moved
            if (Math.abs(timeDelta) < 0.01 && prev.readyState >= 2) {
              addEntry(diagnosticData.audioSignals, {
                signal: 'TIME_STALLED',
                videoKey: key,
                currentTime: video.currentTime,
                note: 'Video not paused but time is not advancing',
              });
            }
          }

          // Duration change detection: ad segments often have different duration
          if (prev.duration !== video.duration &&
              isFinite(video.duration) && isFinite(prev.duration)) {
            addEntry(diagnosticData.audioSignals, {
              signal: 'DURATION_CHANGED',
              videoKey: key,
              from: prev.duration,
              to: video.duration,
              note: `Duration changed from ${prev.duration.toFixed(1)}s to ${video.duration.toFixed(1)}s`,
            });
          }

          // Source change detection
          if (prev.src !== currentSrc && currentSrc) {
            addEntry(diagnosticData.audioSignals, {
              signal: 'SOURCE_CHANGED',
              videoKey: key,
              from: prev.src?.substring(0, 100),
              to: currentSrc.substring(0, 100),
              note: 'Video source URL changed',
            });
          }
        }

        // Save current state for next comparison
        previousVideoState.set(key, {
          currentTime: video.currentTime,
          duration: video.duration,
          src: currentSrc,
          readyState: video.readyState,
          volume: video.volume,
          muted: video.muted,
        });

        // Platform-specific state
        if (diagnosticData.platform === 'youtube') {
          state.ytPlayer = captureYouTubePlayerState();
        } else if (diagnosticData.platform === 'hulu') {
          state.huluPlayer = captureHuluPlayerState();
        } else if (diagnosticData.platform === 'espn') {
          state.espnPlayer = captureESPNPlayerState();
        } else if (diagnosticData.platform === 'nbc') {
          state.nbcPlayer = captureNBCPlayerState();
        }

        addEntry(diagnosticData.playerState, state);
      });
    }

    function setupVideoEventListeners(video) {
      // Prevent double-attaching listeners
      if (video.__hushTabListenersAttached) return;
      video.__hushTabListenersAttached = true;

      // Track previous volume/muted state for richer volumechange events
      let prevVolume = video.volume;
      let prevMuted = video.muted;
      let prevSrc = video.src || video.currentSrc;

      const events = ['play', 'pause', 'seeking', 'seeked', 'ended', 'error',
                      'loadstart', 'loadedmetadata', 'waiting', 'playing',
                      'ratechange', 'emptied', 'durationchange'];

      events.forEach(eventName => {
        video.addEventListener(eventName, () => {
          const entry = {
            event: eventName,
            currentTime: video.currentTime,
            duration: video.duration,
            src: video.src?.substring(0, 100),
          };

          // Extra context for specific events
          if (eventName === 'durationchange') {
            entry.newDuration = video.duration;
            entry.note = `Duration is now ${isFinite(video.duration) ? video.duration.toFixed(1) + 's' : 'Infinity'}`;
          }
          if (eventName === 'emptied') {
            entry.note = 'Media element reset (source removed or changed)';
          }
          if (eventName === 'loadstart') {
            entry.newSrc = video.src?.substring(0, 200) || video.currentSrc?.substring(0, 200);
            if (prevSrc && prevSrc !== entry.newSrc) {
              entry.note = 'New source loading (source changed)';
              entry.previousSrc = prevSrc.substring(0, 100);
            }
            prevSrc = entry.newSrc;
          }

          addEntry(diagnosticData.videoEvents, entry);
        });
      });

      // Dedicated volumechange handler with old/new tracking
      video.addEventListener('volumechange', () => {
        const volumeChanged = prevVolume !== video.volume;
        const mutedChanged = prevMuted !== video.muted;

        addEntry(diagnosticData.videoEvents, {
          event: 'volumechange',
          currentTime: video.currentTime,
          duration: video.duration,
          src: video.src?.substring(0, 100),
          oldVolume: prevVolume,
          newVolume: video.volume,
          oldMuted: prevMuted,
          newMuted: video.muted,
        });

        // Also log as an audio signal for easier correlation
        if (volumeChanged || mutedChanged) {
          addEntry(diagnosticData.audioSignals, {
            signal: 'VOLUME_CHANGED',
            videoKey: video.id || 'unknown',
            oldVolume: prevVolume,
            newVolume: video.volume,
            oldMuted: prevMuted,
            newMuted: video.muted,
            note: mutedChanged
              ? `Muted: ${prevMuted} -> ${video.muted}`
              : `Volume: ${prevVolume.toFixed(2)} -> ${video.volume.toFixed(2)}`,
          });
        }

        prevVolume = video.volume;
        prevMuted = video.muted;
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

  function captureNBCPlayerState() {
    try {
      // Check for Video.js player (NBC often uses this)
      const vjsPlayer = document.querySelector('.video-js, .vjs-player');
      const vjsAdPlaying = vjsPlayer?.classList.contains('vjs-ad-playing') ||
                          vjsPlayer?.classList.contains('vjs-ad-loading');

      // Check video duration (short = likely ad)
      const video = document.querySelector('video');
      const duration = video?.duration;
      const isShortVideo = !isNaN(duration) && isFinite(duration) && duration >= 5 && duration <= 120;

      // Check for ad overlays
      const adOverlay = !!document.querySelector(
        '[class*="ad-overlay"], [class*="adOverlay"], [class*="ad-container"], ' +
        '[class*="adContainer"], [class*="commercial"], [class*="Commercial"]'
      );

      // Check for IMA SDK
      const imaContainer = !!document.querySelector(
        '[class*="ima-"], [id*="ima-"], [class*="google-ad"], .videoAdUi'
      );

      // Check for ad text patterns
      let adTextFound = null;
      const textContainers = document.querySelectorAll('[class*="ad"] *, [class*="overlay"] *');
      for (const el of textContainers) {
        const text = (el.textContent || '').trim();
        if (text.length < 100) {
          if (/ad\s*\d+\s*(of|\/)\s*\d+/i.test(text) ||
              /commercial\s*break/i.test(text) ||
              /your\s*(program|video|show)\s*will\s*(resume|continue)/i.test(text) ||
              /\d+\s*seconds?\s*(remaining|left)/i.test(text)) {
            adTextFound = text;
            break;
          }
        }
      }

      // Check for disabled seek bar
      const seekBar = document.querySelector(
        '[class*="seek"], [class*="progress-bar"], [class*="scrubber"], .vjs-progress-holder'
      );
      const seekDisabled = seekBar && (
        seekBar.hasAttribute('disabled') ||
        seekBar.getAttribute('aria-disabled') === 'true' ||
        seekBar.classList.contains('disabled')
      );

      return {
        vjsPlayer: !!vjsPlayer,
        vjsAdPlaying: vjsAdPlaying,
        videoDuration: duration,
        isShortVideo: isShortVideo,
        adOverlay: adOverlay,
        imaContainer: imaContainer,
        adTextFound: adTextFound,
        seekDisabled: seekDisabled,
        playerClasses: vjsPlayer?.className?.substring(0, 200) || document.querySelector('[class*="player"]')?.className?.substring(0, 200),
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
        diagnosticData.audioSignals = [];
        previousVideoState.clear();
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
            audioSignals: diagnosticData.audioSignals.length,
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
