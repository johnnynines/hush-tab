// Unified Ad Detection Content Script
// Works across all streaming platforms using generic detection patterns

(function() {
  'use strict';

  console.log('[Hush Tab] Unified ad detector loaded');

  // Configuration
  const CONFIG = {
    MUTE_THRESHOLD: 100,
    UNMUTE_THRESHOLD: 70,
    UNMUTE_DELAY_MS: 2000,
    CHECK_INTERVAL_MS: 500,
  };

  // Detection weights - generic patterns that work across platforms
  const WEIGHTS = {
    NETWORK_AD_ACTIVE: 50,        // Network requests to ad servers
    CONTROLS_HIDDEN: 35,          // Player controls hidden/disabled
    PROGRESS_BAR_HIDDEN: 30,      // Seek bar hidden
    AD_TEXT_VISIBLE: 40,          // Text containing "ad", "commercial", etc.
    AD_OVERLAY_VISIBLE: 35,       // Ad overlay element present
    SHORT_VIDEO_DURATION: 40,     // Video is ad-length (5-120 seconds)
    SEEK_DISABLED: 25,            // Cannot seek in video
  };

  // State
  let isAutoMuteEnabled = false;
  let checkInterval = null;
  let currentAdState = false;
  let lastConfidence = 0;
  let lowConfidenceStartTime = null;
  let networkAdActive = false;

  // Load settings
  chrome.storage.sync.get(['autoMuteAds'], (result) => {
    isAutoMuteEnabled = result.autoMuteAds !== false;
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

  // Listen for network ad detection from background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'networkAdDetected') {
      networkAdActive = request.isAd;
      if (isAutoMuteEnabled) {
        checkForAds();
      }
      sendResponse({ received: true });
    }
    return true;
  });

  function startMonitoring() {
    if (checkInterval) return;
    console.log('[Hush Tab] Starting monitoring');
    checkForAds();
    checkInterval = setInterval(checkForAds, CONFIG.CHECK_INTERVAL_MS);
  }

  function stopMonitoring() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  }

  function getAdConfidence() {
    let confidence = 0;
    const signals = [];

    // Network signal
    if (networkAdActive) {
      confidence += WEIGHTS.NETWORK_AD_ACTIVE;
      signals.push('network');
    }

    // Check for generic player controls visibility
    const controlsHidden = checkControlsHidden();
    if (controlsHidden) {
      confidence += WEIGHTS.CONTROLS_HIDDEN;
      signals.push('controls-hidden');
    }

    // Check for progress bar
    const progressHidden = checkProgressBarHidden();
    if (progressHidden) {
      confidence += WEIGHTS.PROGRESS_BAR_HIDDEN;
      signals.push('progress-hidden');
    }

    // Check for ad text
    const hasAdText = checkForAdText();
    if (hasAdText) {
      confidence += WEIGHTS.AD_TEXT_VISIBLE;
      signals.push('ad-text');
    }

    // Check for ad overlay
    const hasAdOverlay = checkForAdOverlay();
    if (hasAdOverlay) {
      confidence += WEIGHTS.AD_OVERLAY_VISIBLE;
      signals.push('ad-overlay');
    }

    // Check video duration
    const isShortVideo = checkShortVideoDuration();
    if (isShortVideo) {
      confidence += WEIGHTS.SHORT_VIDEO_DURATION;
      signals.push('short-video');
    }

    // Check seek disabled
    const seekDisabled = checkSeekDisabled();
    if (seekDisabled) {
      confidence += WEIGHTS.SEEK_DISABLED;
      signals.push('seek-disabled');
    }

    return { confidence: Math.min(confidence, 100), signals };
  }

  function checkControlsHidden() {
    // Generic selectors for player controls
    const controlSelectors = [
      '[class*="player-control"]',
      '[class*="control"][class*="bar"]',
      '[class*="button"][class*="play"]',
      '.video-controls',
      '.player-controls',
    ];

    for (const selector of controlSelectors) {
      const el = document.querySelector(selector);
      if (el && !isVisible(el)) {
        return true;
      }
    }
    return false;
  }

  function checkProgressBarHidden() {
    const progressSelectors = [
      '[class*="progress"]',
      '[class*="seek"]',
      '[class*="scrub"]',
      'input[type="range"]',
    ];

    for (const selector of progressSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        if (el.classList.contains('hidden') || !isVisible(el)) {
          return true;
        }
      }
    }
    return false;
  }

  function checkForAdText() {
    const adPatterns = [
      /\bad\b.*\bof\b.*\d/i,  // "Ad 1 of 2"
      /commercial\s*break/i,
      /advertisement/i,
      /\d+\s*seconds?\s*(remaining|left)/i,
      /skip\s*ad/i,
    ];

    const textElements = document.querySelectorAll('*');
    for (const el of textElements) {
      const text = el.textContent?.trim() || '';
      if (text.length < 100) {
        for (const pattern of adPatterns) {
          if (pattern.test(text)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function checkForAdOverlay() {
    const overlaySelectors = [
      '[class*="ad-overlay"]',
      '[class*="ad"][class*="container"]',
      '[id*="ad-overlay"]',
      '[id*="ima"]',
    ];

    for (const selector of overlaySelectors) {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) {
        return true;
      }
    }
    return false;
  }

  function checkShortVideoDuration() {
    const video = document.querySelector('video');
    if (!video) return false;

    const duration = video.duration;
    return !isNaN(duration) && isFinite(duration) && duration >= 5 && duration <= 120;
  }

  function checkSeekDisabled() {
    const seekBar = document.querySelector('input[type="range"], [class*="progress"], [class*="seek"]');
    if (!seekBar) return false;

    return seekBar.disabled || 
           seekBar.getAttribute('aria-disabled') === 'true' ||
           window.getComputedStyle(seekBar).pointerEvents === 'none';
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           (el.offsetWidth > 0 || el.offsetHeight > 0);
  }

  function checkForAds() {
    const { confidence, signals } = getAdConfidence();
    const now = Date.now();

    // Log when confidence changes
    if (confidence !== lastConfidence) {
      console.log(`[Hush Tab] Confidence: ${confidence} | Signals: ${signals.join(', ')} | Ad State: ${currentAdState}`);
    }
    lastConfidence = confidence;

    // Mute logic
    if (!currentAdState && confidence >= CONFIG.MUTE_THRESHOLD) {
      console.log(`[Hush Tab] 🔇 AD DETECTED - Muting (confidence: ${confidence})`);
      currentAdState = true;
      lowConfidenceStartTime = null;
      notifyBackgroundScript(true);

    } else if (currentAdState && confidence < CONFIG.UNMUTE_THRESHOLD) {
      if (lowConfidenceStartTime === null) {
        console.log(`[Hush Tab] Confidence dropped to ${confidence}, starting unmute timer...`);
        lowConfidenceStartTime = now;
      } else if (now - lowConfidenceStartTime >= CONFIG.UNMUTE_DELAY_MS) {
        console.log(`[Hush Tab] 🔊 CONTENT RESUMED - Unmuting (confidence: ${confidence})`);
        currentAdState = false;
        lowConfidenceStartTime = null;
        notifyBackgroundScript(false);
      }

    } else if (currentAdState && confidence >= CONFIG.UNMUTE_THRESHOLD) {
      lowConfidenceStartTime = null;
    }
  }

  function notifyBackgroundScript(isAd) {
    console.log(`[Hush Tab] Sending adStateChanged message: isAd=${isAd}`);
    chrome.runtime.sendMessage({
      action: 'adStateChanged',
      isAd: isAd,
      url: window.location.href,
      confidence: lastConfidence,
      platform: 'unified'
    }).then((response) => {
      console.log(`[Hush Tab] Message sent successfully, response:`, response);
    }).catch((error) => {
      if (error.message.includes('Extension context invalidated')) {
        console.error('[Hush Tab] ⚠️ EXTENSION CONTEXT INVALIDATED - Please reload this page after reloading the extension');
        stopMonitoring(); // Stop trying to send messages
      } else {
        console.error('[Hush Tab] Failed to send message:', error);
      }
    });
  }

})();
