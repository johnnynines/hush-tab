// Hulu Ad Detection Content Script
// Confidence-based detection system with multiple signals and hysteresis

(function() {
  'use strict';

  console.log('[Hush Tab] Hulu content script loaded (confidence-based detection)');

  // Configuration
  const CONFIG = {
    MUTE_THRESHOLD: 50,           // Confidence score to trigger mute
    UNMUTE_THRESHOLD: 20,         // Confidence must drop below this to unmute
    UNMUTE_DELAY_MS: 2000,        // How long confidence must stay low before unmute
    CHECK_INTERVAL_MS: 500,       // Polling interval
    VIDEO_STALL_THRESHOLD_MS: 1000, // Time without progress to consider stalled
  };

  // Detection weights for confidence scoring
  // Note: Hulu selectors may change - these are based on known patterns
  const WEIGHTS = {
    NETWORK_AD_DETECTED: 60,           // Network requests to ad servers detected
    AD_BREAK_MARKER: 40,               // Ad break marker on progress bar
    AD_COUNTDOWN_TEXT: 45,             // "Your video will resume" or countdown
    AD_PLAYER_STATE: 40,               // Player in ad-playing state
    AD_OVERLAY_VISIBLE: 35,            // Ad overlay/container visible
    AD_BADGE_TEXT: 30,                 // "Ad" or "Advertisement" text
    VIDEO_TIME_FROZEN: 20,             // Video currentTime not advancing
    AD_CONTROLS_HIDDEN: 15,            // Playback controls hidden during ad
    AUDIBLE_FLICKER: 10,               // Audio state changes detected
  };

  // State
  let isAutoMuteEnabled = false;
  let checkInterval = null;
  let currentAdState = false;
  let lastConfidence = 0;
  let lowConfidenceStartTime = null;
  let lastVideoTime = 0;
  let lastVideoTimeCheck = Date.now();
  let videoTimeStalled = false;
  let recentAudibleFlicker = false;
  let audibleFlickerTimeout = null;

  // Network-based ad detection state (received from background script)
  let networkAdActive = false;
  let networkAdTimeout = null;

  // Load auto-mute preference from storage
  chrome.storage.sync.get(['autoMuteAds'], (result) => {
    isAutoMuteEnabled = result.autoMuteAds !== false;
    console.log('[Hush Tab] Auto-mute enabled:', isAutoMuteEnabled);

    if (isAutoMuteEnabled) {
      startMonitoring();
    }
  });

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.autoMuteAds) {
      isAutoMuteEnabled = changes.autoMuteAds.newValue;
      console.log('[Hush Tab] Auto-mute setting changed:', isAutoMuteEnabled);

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
      console.log(`[Hush Tab] Received audible flicker notification (count: ${request.flickerCount})`);
      recentAudibleFlicker = true;

      if (audibleFlickerTimeout) {
        clearTimeout(audibleFlickerTimeout);
      }
      audibleFlickerTimeout = setTimeout(() => {
        recentAudibleFlicker = false;
      }, 3000);

      if (isAutoMuteEnabled) {
        checkForAds();
      }

      sendResponse({ received: true });
    }

    // Network-based ad detection signal from background script
    if (request.action === 'networkAdDetected') {
      console.log(`[Hush Tab] Hulu received network ad signal: isAd=${request.isAd}`);
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
    if (checkInterval) return;

    console.log('[Hush Tab] Starting Hulu ad monitoring (confidence-based)');
    checkForAds();
    checkInterval = setInterval(checkForAds, CONFIG.CHECK_INTERVAL_MS);
    observeDOMChanges();
  }

  function stopMonitoring() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
      console.log('[Hush Tab] Stopped Hulu ad monitoring');
    }
  }

  /**
   * Calculate ad detection confidence score (0-100)
   */
  function getAdConfidence() {
    let confidence = 0;
    const signals = [];

    // Signal 0: Network-based ad detection from background script
    if (networkAdActive) {
      confidence += WEIGHTS.NETWORK_AD_DETECTED;
      signals.push('network-ad-detected');
    }

    // Signal 1: Ad break marker on progress bar (known Hulu selector)
    const adBreakMarker = document.querySelector('.controls__ad-break, [class*="ad-break"], [class*="adBreak"]');
    if (adBreakMarker && isElementVisible(adBreakMarker)) {
      confidence += WEIGHTS.AD_BREAK_MARKER;
      signals.push('ad-break-marker');
    }

    // Signal 2: Ad countdown or "Your video will resume" text
    const adCountdownPatterns = [
      /your\s*(video|show|program)\s*will\s*resume/i,
      /ad\s*\d+\s*of\s*\d+/i,
      /advertisement/i,
      /\d+\s*seconds?\s*remaining/i,
      /skip\s*ad\s*in/i,
    ];

    const textElements = document.querySelectorAll('[class*="ad"] span, [class*="ad"] div, [class*="commercial"] span');
    for (const el of textElements) {
      const text = el.textContent || '';
      if (adCountdownPatterns.some(pattern => pattern.test(text))) {
        confidence += WEIGHTS.AD_COUNTDOWN_TEXT;
        signals.push('ad-countdown-text');
        break;
      }
    }

    // Also check for ad text in common locations
    const bodyText = document.body.innerText || '';
    if (/your\s*(video|show)\s*will\s*resume\s*in/i.test(bodyText)) {
      if (!signals.includes('ad-countdown-text')) {
        confidence += WEIGHTS.AD_COUNTDOWN_TEXT;
        signals.push('ad-countdown-text');
      }
    }

    // Signal 3: Player in ad-playing state (check for ad-related classes on player)
    const player = document.querySelector('.content-video-player, [class*="video-player"], [class*="Player"]');
    if (player) {
      const playerClasses = player.className || '';
      if (/ad[-_]?(playing|active|mode|break)/i.test(playerClasses)) {
        confidence += WEIGHTS.AD_PLAYER_STATE;
        signals.push('player-ad-state');
      }
    }

    // Signal 4: Ad overlay visible
    const adOverlay = document.querySelector(
      '[class*="ad-overlay"], [class*="adOverlay"], [class*="commercial-break"], ' +
      '[class*="ad-container"], [class*="adContainer"], [class*="ad-player"]'
    );
    if (adOverlay && isElementVisible(adOverlay)) {
      confidence += WEIGHTS.AD_OVERLAY_VISIBLE;
      signals.push('ad-overlay');
    }

    // Signal 5: Ad badge or label visible
    const adBadge = document.querySelector(
      '[class*="ad-badge"], [class*="adBadge"], [class*="ad-label"], ' +
      '[class*="adLabel"], [aria-label*="advertisement" i]'
    );
    if (adBadge && isElementVisible(adBadge)) {
      confidence += WEIGHTS.AD_BADGE_TEXT;
      signals.push('ad-badge');
    }

    // Signal 6: Video time frozen (content doesn't advance during ads)
    if (checkVideoTimeAnomaly()) {
      confidence += WEIGHTS.VIDEO_TIME_FROZEN;
      signals.push('video-time-frozen');
    }

    // Signal 7: Playback controls hidden (common during ads)
    const controls = document.querySelector('.controls, [class*="controls"], [class*="Controls"]');
    const seekBar = document.querySelector('[class*="seek"], [class*="progress"], [class*="scrubber"]');
    if (controls && seekBar) {
      // Check if seek bar is disabled or hidden during ad
      const seekDisabled = seekBar.hasAttribute('disabled') ||
                          seekBar.getAttribute('aria-disabled') === 'true' ||
                          window.getComputedStyle(seekBar).pointerEvents === 'none';
      if (seekDisabled) {
        confidence += WEIGHTS.AD_CONTROLS_HIDDEN;
        signals.push('controls-disabled');
      }
    }

    // Signal 8: Audible flicker detected
    if (recentAudibleFlicker) {
      confidence += WEIGHTS.AUDIBLE_FLICKER;
      signals.push('audible-flicker');
    }

    // Signal 9: Check for Hulu-specific ad player elements
    const huluAdElements = document.querySelectorAll(
      '[data-ad], [data-advertisement], [class*="AdUnit"], [class*="adunit"]'
    );
    if (huluAdElements.length > 0) {
      confidence += 25;
      signals.push('hulu-ad-elements');
    }

    // Cap confidence at 100
    confidence = Math.min(confidence, 100);

    if (confidence !== lastConfidence) {
      console.log(`[Hush Tab] Hulu Confidence: ${confidence} | Signals: ${signals.join(', ') || 'none'}`);
    }

    return confidence;
  }

  function isElementVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           (element.offsetWidth > 0 || element.offsetHeight > 0);
  }

  function checkVideoTimeAnomaly() {
    const video = document.querySelector('video');
    if (!video) return false;

    const now = Date.now();
    const timeSinceLastCheck = now - lastVideoTimeCheck;
    const currentTime = video.currentTime;

    if (!video.paused && timeSinceLastCheck > CONFIG.VIDEO_STALL_THRESHOLD_MS) {
      const expectedProgress = timeSinceLastCheck / 1000 * 0.8;
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

  function checkForAds() {
    const confidence = getAdConfidence();
    lastConfidence = confidence;

    const now = Date.now();

    if (!currentAdState && confidence >= CONFIG.MUTE_THRESHOLD) {
      currentAdState = true;
      lowConfidenceStartTime = null;
      console.log(`[Hush Tab] Hulu AD DETECTED (confidence: ${confidence}) - Muting`);
      notifyBackgroundScript(true);

    } else if (currentAdState && confidence < CONFIG.UNMUTE_THRESHOLD) {
      if (lowConfidenceStartTime === null) {
        lowConfidenceStartTime = now;
        console.log(`[Hush Tab] Confidence dropped to ${confidence}, waiting ${CONFIG.UNMUTE_DELAY_MS}ms before unmute`);
      } else if (now - lowConfidenceStartTime >= CONFIG.UNMUTE_DELAY_MS) {
        currentAdState = false;
        lowConfidenceStartTime = null;
        console.log(`[Hush Tab] Hulu AD ENDED (confidence: ${confidence}) - Unmuting`);
        notifyBackgroundScript(false);
      }

    } else if (currentAdState && confidence >= CONFIG.UNMUTE_THRESHOLD) {
      if (lowConfidenceStartTime !== null) {
        console.log(`[Hush Tab] Confidence recovered to ${confidence}, canceling unmute`);
        lowConfidenceStartTime = null;
      }
    }
  }

  function notifyBackgroundScript(isAd) {
    chrome.runtime.sendMessage({
      action: 'adStateChanged',
      isAd: isAd,
      url: window.location.href,
      confidence: lastConfidence,
      platform: 'hulu'
    }).catch(err => {
      console.log('[Hush Tab] Could not send message:', err);
    });
  }

  function observeDOMChanges() {
    const targetNode = document.querySelector('.content-video-player, [class*="video-player"]') || document.body;

    const observer = new MutationObserver((mutations) => {
      const relevantChange = mutations.some(mutation => {
        if (mutation.type === 'childList') {
          for (let node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              const className = node.className || '';
              if (/ad[-_]?(break|overlay|container|player|badge)/i.test(className)) {
                return true;
              }
              if (node.querySelector && node.querySelector('[class*="ad-"], [class*="Ad"]')) {
                return true;
              }
            }
          }
        }

        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const target = mutation.target;
          const className = target.className || '';
          if (/ad[-_]?(playing|active|mode|break)/i.test(className)) {
            return true;
          }
        }

        return false;
      });

      if (relevantChange) {
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

  // Handle SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log('[Hush Tab] Hulu navigation detected');
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
