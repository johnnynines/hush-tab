// YouTube Ad Detection Content Script
// Confidence-based detection system with multiple signals and hysteresis

(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    MUTE_THRESHOLD: 50,           // Confidence score to trigger mute
    UNMUTE_THRESHOLD: 20,         // Confidence must drop below this to unmute
    UNMUTE_DELAY_MS: 2000,        // How long confidence must stay low before unmute
    CHECK_INTERVAL_MS: 500,       // Polling interval
    VIDEO_STALL_THRESHOLD_MS: 1000, // Time without progress to consider stalled
  };

  // Detection weights for confidence scoring
  const WEIGHTS = {
    NETWORK_AD_DETECTED: 50,           // Network requests to ad servers detected
    AD_SHOWING_CLASS: 40,              // .ad-showing on player
    AD_MODULE_HAS_CHILDREN: 35,        // .ytp-ad-module with content
    AD_PLAYER_OVERLAY: 30,             // .ytp-ad-player-overlay present
    AD_PREVIEW_TEXT: 25,               // .ytp-ad-preview-text visible
    AD_MESSAGE_CONTAINER: 20,          // .ytp-ad-message-container visible
    AD_TEXT: 15,                       // .ytp-ad-text visible
    AD_INTERRUPTING_CLASS: 40,         // .ad-interrupting on player
    AD_OVERLAY_CONTAINER: 20,          // .ytp-ad-overlay-container present
    AD_SKIP_BUTTON: 15,                // Skip button present (lower weight as requested)
    VIDEO_TIME_NOT_ADVANCING: 15,      // Video currentTime anomaly
    AD_BADGE: 25,                      // Ad badge/label visible
    AUDIBLE_FLICKER: 10,               // Recent audible state changes detected
  };

  // State
  let isAutoMuteEnabled = false;
  let checkInterval = null;
  let currentAdState = false;  // Current muted-for-ad state
  let lastConfidence = 0;
  let lowConfidenceStartTime = null;  // For hysteresis tracking
  let lastVideoTime = 0;
  let lastVideoTimeCheck = Date.now();
  let videoTimeStalled = false;

  // Audible flicker state (received from background script)
  let recentAudibleFlicker = false;
  let audibleFlickerTimeout = null;

  // Network-based ad detection state (received from background script)
  let networkAdActive = false;
  let networkAdTimeout = null;

  // Load auto-mute preference from storage
  chrome.storage.sync.get(['autoMuteAds'], (result) => {
    isAutoMuteEnabled = result.autoMuteAds !== false; // Default to true

    if (isAutoMuteEnabled) {
      startMonitoring();
    }
  });

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.autoMuteAds) {
      isAutoMuteEnabled = changes.autoMuteAds.newValue;

      if (isAutoMuteEnabled) {
        startMonitoring();
      } else {
        stopMonitoring();
      }
    }
  });

  // Listen for audible state changes from background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'audibleStateChanged') {

      // Set flicker flag for confidence scoring
      recentAudibleFlicker = true;

      // Clear the flicker flag after a delay
      if (audibleFlickerTimeout) {
        clearTimeout(audibleFlickerTimeout);
      }
      audibleFlickerTimeout = setTimeout(() => {
        recentAudibleFlicker = false;
      }, 3000); // Flicker signal is relevant for 3 seconds

      // Trigger an immediate check
      if (isAutoMuteEnabled) {
        checkForAds();
      }

      sendResponse({ received: true });
    }

    // Network-based ad detection signal from background script
    if (request.action === 'networkAdDetected') {
      networkAdActive = request.isAd;

      // Clear any existing timeout
      if (networkAdTimeout) {
        clearTimeout(networkAdTimeout);
        networkAdTimeout = null;
      }

      // If ad ended, keep the signal active briefly then clear
      if (!request.isAd) {
        networkAdTimeout = setTimeout(() => {
          networkAdActive = false;
        }, 1000);
      }

      // Trigger immediate check
      if (isAutoMuteEnabled) {
        checkForAds();
      }

      sendResponse({ received: true });
    }

    return true;
  });

  function startMonitoring() {
    if (checkInterval) return; // Already monitoring

    // Check immediately
    checkForAds();

    // Then check at regular intervals
    checkInterval = setInterval(checkForAds, CONFIG.CHECK_INTERVAL_MS);

    // Also use MutationObserver for immediate detection
    observeDOMChanges();
  }

  function stopMonitoring() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  }

  /**
   * Calculate ad detection confidence score (0-100)
   * Higher score = more confident an ad is playing
   */
  function getAdConfidence() {
    let confidence = 0;
    const signals = [];

    // Signal 0: Network-based ad detection from background script
    if (networkAdActive) {
      confidence += WEIGHTS.NETWORK_AD_DETECTED;
      signals.push('network-ad-detected');
    }

    // Signal 1: .ad-showing class on player (most reliable)
    const player = document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) {
      confidence += WEIGHTS.AD_SHOWING_CLASS;
      signals.push('ad-showing');
    }

    // Signal 2: .ad-interrupting class on player
    if (player && player.classList.contains('ad-interrupting')) {
      confidence += WEIGHTS.AD_INTERRUPTING_CLASS;
      signals.push('ad-interrupting');
    }

    // Signal 3: .ytp-ad-module has children (primary container check)
    const adModule = document.querySelector('.ytp-ad-module, .video-ads.ytp-ad-module');
    if (adModule && adModule.children.length > 0) {
      confidence += WEIGHTS.AD_MODULE_HAS_CHILDREN;
      signals.push('ad-module-has-children');
    }

    // Signal 4: .ytp-ad-player-overlay present
    const adOverlay = document.querySelector('.ytp-ad-player-overlay');
    if (adOverlay) {
      confidence += WEIGHTS.AD_PLAYER_OVERLAY;
      signals.push('ad-player-overlay');
    }

    // Signal 5: .ytp-ad-preview-text visible (shows "Ad will end in X")
    const previewText = document.querySelector('.ytp-ad-preview-text');
    if (previewText && isElementVisible(previewText)) {
      confidence += WEIGHTS.AD_PREVIEW_TEXT;
      signals.push('ad-preview-text');
    }

    // Signal 6: .ytp-ad-message-container visible
    const messageContainer = document.querySelector('.ytp-ad-message-container');
    if (messageContainer && isElementVisible(messageContainer)) {
      confidence += WEIGHTS.AD_MESSAGE_CONTAINER;
      signals.push('ad-message-container');
    }

    // Signal 7: .ytp-ad-text visible
    const adText = document.querySelector('.ytp-ad-text');
    if (adText && isElementVisible(adText)) {
      confidence += WEIGHTS.AD_TEXT;
      signals.push('ad-text');
    }

    // Signal 8: .ytp-ad-overlay-container present
    const overlayContainer = document.querySelector('.ytp-ad-overlay-container');
    if (overlayContainer && overlayContainer.children.length > 0) {
      confidence += WEIGHTS.AD_OVERLAY_CONTAINER;
      signals.push('ad-overlay-container');
    }

    // Signal 9: Skip button present (lower weight - appears late or not at all)
    const skipButton = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
    if (skipButton && isElementVisible(skipButton)) {
      confidence += WEIGHTS.AD_SKIP_BUTTON;
      signals.push('skip-button');
    }

    // Signal 10: Ad badge visible (e.g., "Ad" label)
    const adBadge = document.querySelector('.ytp-ad-simple-ad-badge, .ytp-ad-badge, [class*="ad-badge"]');
    if (adBadge && isElementVisible(adBadge)) {
      confidence += WEIGHTS.AD_BADGE;
      signals.push('ad-badge');
    }

    // Signal 11: Video time not advancing (content paused during ad)
    if (checkVideoTimeAnomaly()) {
      confidence += WEIGHTS.VIDEO_TIME_NOT_ADVANCING;
      signals.push('video-time-anomaly');
    }

    // Signal 12: Check for ad info in player overlay
    const instreamInfo = document.querySelector('.ytp-ad-player-overlay-instream-info');
    if (instreamInfo && isElementVisible(instreamInfo)) {
      confidence += 20;
      signals.push('instream-info');
    }

    // Signal 13: Check for "Ad X of Y" counter text
    const adCounter = findAdCounterText();
    if (adCounter) {
      confidence += 25;
      signals.push('ad-counter-text');
    }

    // Signal 14: Audible flicker detected (from background script)
    if (recentAudibleFlicker) {
      confidence += WEIGHTS.AUDIBLE_FLICKER;
      signals.push('audible-flicker');
    }

    // Cap confidence at 100
    confidence = Math.min(confidence, 100);

    // Log signal details periodically for debugging
    if (confidence !== lastConfidence) {
    }

    return confidence;
  }

  /**
   * Check if element is visible in the DOM
   */
  function isElementVisible(element) {
    if (!element) return false;
    return element.offsetParent !== null ||
           element.offsetWidth > 0 ||
           element.offsetHeight > 0;
  }

  /**
   * Check for video time anomalies that might indicate an ad
   * During ads, the main video's currentTime often doesn't advance normally
   */
  function checkVideoTimeAnomaly() {
    const video = document.querySelector('video.html5-main-video');
    if (!video) return false;

    const now = Date.now();
    const timeSinceLastCheck = now - lastVideoTimeCheck;
    const currentTime = video.currentTime;

    // If video is playing but time hasn't advanced
    if (!video.paused && timeSinceLastCheck > CONFIG.VIDEO_STALL_THRESHOLD_MS) {
      const expectedProgress = timeSinceLastCheck / 1000 * 0.8; // 80% of expected (buffer for variance)
      const actualProgress = currentTime - lastVideoTime;

      if (actualProgress < expectedProgress && actualProgress < 0.5) {
        videoTimeStalled = true;
      } else {
        videoTimeStalled = false;
      }
    }

    lastVideoTime = currentTime;
    lastVideoTimeCheck = now;

    return videoTimeStalled;
  }

  /**
   * Look for "Ad X of Y" counter text in common locations
   */
  function findAdCounterText() {
    // Common containers where ad counter appears
    const containers = [
      '.ytp-ad-preview-container',
      '.ytp-ad-player-overlay-instream-info',
      '.ytp-ad-message-container',
      '.ytp-ad-player-overlay'
    ];

    for (const selector of containers) {
      const container = document.querySelector(selector);
      if (container) {
        const text = container.textContent || '';
        // Match patterns like "Ad 1 of 2", "Ad · 0:15", "1 of 2", etc.
        if (/ad\s*\d+\s*(of|\/)\s*\d+/i.test(text) ||
            /^\s*\d+\s*(of|\/)\s*\d+\s*$/i.test(text) ||
            /ad\s*·/i.test(text)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Main check function with hysteresis logic
   */
  function checkForAds() {
    const confidence = getAdConfidence();
    lastConfidence = confidence;

    const now = Date.now();

    // Determine if we should change state based on hysteresis
    if (!currentAdState && confidence >= CONFIG.MUTE_THRESHOLD) {
      // Not currently muted for ad, but confidence is high - MUTE
      currentAdState = true;
      lowConfidenceStartTime = null;
      notifyBackgroundScript(true);

    } else if (currentAdState && confidence < CONFIG.UNMUTE_THRESHOLD) {
      // Currently muted for ad, confidence dropped low
      if (lowConfidenceStartTime === null) {
        // Start tracking low confidence duration
        lowConfidenceStartTime = now;
      } else if (now - lowConfidenceStartTime >= CONFIG.UNMUTE_DELAY_MS) {
        // Confidence has been low long enough - UNMUTE
        currentAdState = false;
        lowConfidenceStartTime = null;
        notifyBackgroundScript(false);
      }
      // Else: still waiting for delay

    } else if (currentAdState && confidence >= CONFIG.UNMUTE_THRESHOLD) {
      // Confidence went back up - reset the low confidence timer
      if (lowConfidenceStartTime !== null) {
        lowConfidenceStartTime = null;
      }
    }
  }

  /**
   * Send ad state change to background script
   */
  function notifyBackgroundScript(isAd) {
    chrome.runtime.sendMessage({
      action: 'adStateChanged',
      isAd: isAd,
      url: window.location.href,
      confidence: lastConfidence
    }).catch(err => {
      // Extension context may be invalidated, ignore
    });
  }

  /**
   * Observe DOM changes for immediate ad detection
   */
  function observeDOMChanges() {
    const targetNode = document.querySelector('#movie_player') || document.body;

    const observer = new MutationObserver((mutations) => {
      // Check if any mutations involve ad-related classes or elements
      const relevantChange = mutations.some(mutation => {
        if (mutation.type === 'childList') {
          // Check added nodes for ad elements
          for (let node of mutation.addedNodes) {
            if (node.nodeType === 1) { // Element node
              if (node.classList && (
                node.classList.contains('ytp-ad-player-overlay') ||
                node.classList.contains('ytp-ad-module') ||
                node.classList.contains('video-ads') ||
                node.classList.contains('ytp-ad-preview-text') ||
                node.classList.contains('ytp-ad-message-container') ||
                node.classList.contains('ytp-ad-text') ||
                node.classList.contains('ytp-ad-overlay-container')
              )) {
                return true;
              }
              // Also check if ad-related elements were added as children
              if (node.querySelector && node.querySelector('[class*="ytp-ad-"]')) {
                return true;
              }
            }
          }
        }

        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const target = mutation.target;
          if (target.classList && (
            target.classList.contains('ad-showing') ||
            target.classList.contains('ad-interrupting')
          )) {
            return true;
          }
        }

        return false;
      });

      if (relevantChange) {
        // Check immediately when relevant DOM changes occur
        checkForAds();
      }
    });

    observer.observe(targetNode, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  // Handle page navigation (YouTube is a SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      // Reset state on navigation
      currentAdState = false;
      lowConfidenceStartTime = null;
      lastVideoTime = 0;
      lastVideoTimeCheck = Date.now();
      videoTimeStalled = false;
      recentAudibleFlicker = false;
      if (audibleFlickerTimeout) {
        clearTimeout(audibleFlickerTimeout);
        audibleFlickerTimeout = null;
      }
      if (isAutoMuteEnabled) {
        checkForAds();
      }
    }
  }).observe(document, { subtree: true, childList: true });

})();
