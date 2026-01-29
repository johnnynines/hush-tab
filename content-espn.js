// ESPN Ad Detection Content Script
// Confidence-based detection system for ESPN and ESPN+ properties

(function() {
  'use strict';

  // Detect if we're in an iframe
  const isInIframe = window.self !== window.top;
  const frameInfo = isInIframe ? `(IFRAME: ${window.location.hostname})` : '(MAIN FRAME)';

  console.log(`[Hush Tab] ESPN content script loaded ${frameInfo} - URL: ${window.location.href.substring(0, 100)}`);

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
    NETWORK_AD_DETECTED: 35,           // Network requests to ad servers detected (lower weight - needs other signals)
    SHORT_VIDEO_DURATION: 40,          // Video duration is ad-length (15-90 seconds)
    AD_PLAYING_STATE: 45,              // Player reports ad playing
    AD_OVERLAY_VISIBLE: 40,            // Ad overlay/container visible
    AD_COUNTDOWN_TEXT: 40,             // Countdown or "Ad" text visible
    AD_BREAK_INDICATOR: 35,            // Ad break indicator in UI
    AD_BADGE_VISIBLE: 30,              // "Ad" or "Commercial" badge
    VIDEO_TIME_FROZEN: 20,             // Video currentTime not advancing
    SEEK_DISABLED: 20,                 // Seek bar disabled during ad
    AUDIBLE_FLICKER: 10,               // Audio state changes detected
  };

  // Ad duration thresholds (in seconds)
  const AD_DURATION = {
    MIN: 5,    // Minimum ad length
    MAX: 120,  // Maximum ad length (2 minutes)
  };

  // State
  let isAutoMuteEnabled = false;
  let lastKnownDuration = Infinity;  // Track duration changes
  let durationChangeCount = 0;       // Count rapid duration changes
  let checkInterval = null;
  let networkAdActive = false;       // Network-based ad detection signal
  let networkAdTimeout = null;       // Timeout to clear network ad signal
  let currentAdState = false;
  let lastConfidence = 0;
  let lowConfidenceStartTime = null;
  let lastVideoTime = 0;
  let lastVideoTimeCheck = Date.now();
  let videoTimeStalled = false;
  let recentAudibleFlicker = false;
  let audibleFlickerTimeout = null;

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

  // Listen for messages from background script
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
      console.log(`[Hush Tab] ESPN received network ad signal: isAd=${request.isAd}`);
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

    console.log('[Hush Tab] Starting ESPN ad monitoring (confidence-based)');

    // Debug: Log what video elements exist
    const videos = document.querySelectorAll('video');
    console.log(`[Hush Tab] ESPN found ${videos.length} video element(s)`);

    // Debug: Run a DOM diagnostic once at start
    runDiagnostic();

    checkForAds();
    checkInterval = setInterval(checkForAds, CONFIG.CHECK_INTERVAL_MS);
    observeDOMChanges();

    // Run diagnostic every 10 seconds to see DOM state
    setInterval(runDiagnostic, 10000);
  }

  function runDiagnostic() {
    console.log(`[Hush Tab] === ESPN DOM Diagnostic ${frameInfo} ===`);

    // Check for ALL video elements
    const videos = document.querySelectorAll('video');
    console.log(`[Hush Tab] Found ${videos.length} video element(s)`);

    videos.forEach((video, i) => {
      const isPlaying = !video.paused && !video.ended && video.currentTime > 0;
      console.log(`[Hush Tab] Video[${i}]: playing=${isPlaying}, paused=${video.paused}, currentTime=${video.currentTime.toFixed(1)}, duration=${video.duration}, src=${(video.src || video.currentSrc || 'none').substring(0, 50)}`);
    });

    // Check the WebPlayerContainer specifically for ESPN
    const playerContainer = document.querySelector('.WebPlayerContainer, [class*="WebPlayerContainer"]');
    if (playerContainer) {
      console.log(`[Hush Tab] WebPlayerContainer classes: ${playerContainer.className}`);

      // Look for any child elements that might indicate ad state
      const allChildren = playerContainer.querySelectorAll('*');
      const interestingElements = [];
      allChildren.forEach(el => {
        const className = el.className || '';
        const text = (el.textContent || '').trim();
        // Look for elements with short text that might be ad indicators
        if (text.length > 0 && text.length < 50 && /ad|skip|commercial|\d+\s*of\s*\d+/i.test(text)) {
          interestingElements.push({ class: className.substring(0, 50), text: text.substring(0, 30) });
        }
        // Look for interesting class names
        if (/ad|commercial|skip|overlay|countdown/i.test(className)) {
          interestingElements.push({ class: className.substring(0, 50), text: '' });
        }
      });

      if (interestingElements.length > 0) {
        console.log(`[Hush Tab] Interesting elements in player: ${JSON.stringify(interestingElements.slice(0, 5))}`);
      }
    }

    // Check for common ad-related elements
    const adSelectors = [
      '[class*="ad-"]',
      '[class*="Ad"]',
      '[class*="commercial"]',
      '[class*="Commercial"]',
      '[class*="advertisement"]',
      '[data-ad]',
      '[class*="ima-"]',
      '.videoAdUi',
      '[class*="bam"]',
      '[class*="bam-"]',
      '[class*="skip"]',
      '[class*="Skip"]',
    ];

    for (const selector of adSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        const details = Array.from(elements).slice(0, 3).map(el => ({
          class: (el.className || '').substring(0, 40),
          text: (el.textContent || '').substring(0, 20).trim()
        }));
        console.log(`[Hush Tab] Found ${elements.length} "${selector}":`, details);
      }
    }

    // Look for ANY visible text that says "Ad" in the player area
    const playerArea = document.querySelector('.WebPlayerContainer, [class*="player"]');
    if (playerArea) {
      const walker = document.createTreeWalker(playerArea, NodeFilter.SHOW_TEXT, null, false);
      const adTexts = [];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (text.length > 0 && text.length < 30) {
          // Look for ad indicators
          if (/^ad$/i.test(text) || /^ad\s*\d/i.test(text) || /^\d+\s*of\s*\d+$/i.test(text) ||
              /skip/i.test(text) || /commercial/i.test(text)) {
            adTexts.push(text);
          }
        }
      }
      if (adTexts.length > 0) {
        console.log(`[Hush Tab] Ad-related text found in player: ${JSON.stringify(adTexts)}`);
      }
    }

    // Log current confidence
    const confidence = getAdConfidence();
    console.log(`[Hush Tab] Current confidence: ${confidence}`);

    console.log(`[Hush Tab] === End Diagnostic ${frameInfo} ===`);
  }

  function stopMonitoring() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
      console.log('[Hush Tab] Stopped ESPN ad monitoring');
    }
  }

  /**
   * Find the actively playing video element
   */
  function getActiveVideo() {
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      // Look for a video that's actually playing (not paused, has valid duration)
      if (!video.paused && !video.ended && video.currentTime > 0 && !isNaN(video.duration)) {
        return video;
      }
    }
    // Fallback: return first video with valid duration
    for (const video of videos) {
      if (!isNaN(video.duration) && video.duration > 0) {
        return video;
      }
    }
    return null;
  }

  /**
   * Calculate ad detection confidence score (0-100)
   */
  function getAdConfidence() {
    let confidence = 0;
    const signals = [];

    // Signal 0 (HIGH PRIORITY): Network-based ad detection from background script
    if (networkAdActive) {
      confidence += WEIGHTS.NETWORK_AD_DETECTED;
      signals.push('network-ad-detected');
    }

    // Signal 1 (MOST IMPORTANT): Check video duration - ads are typically 5-120 seconds
    const activeVideo = getActiveVideo();
    if (activeVideo) {
      const duration = activeVideo.duration;
      const isPlaying = !activeVideo.paused && activeVideo.currentTime > 0;

      // Check for finite ad-length duration
      if (isPlaying && !isNaN(duration) && isFinite(duration) &&
          duration >= AD_DURATION.MIN && duration <= AD_DURATION.MAX) {
        confidence += WEIGHTS.SHORT_VIDEO_DURATION;
        signals.push(`short-video-${Math.round(duration)}s`);
      }

      // Track duration changes - when switching from Infinity to finite or vice versa
      if (duration !== lastKnownDuration) {
        console.log(`[Hush Tab] ESPN duration changed: ${lastKnownDuration} -> ${duration}`);
        lastKnownDuration = duration;

        // Finite duration appearing after Infinity often indicates ad start
        if (isFinite(duration) && duration >= AD_DURATION.MIN && duration <= AD_DURATION.MAX) {
          durationChangeCount++;
        }
      }
    }

    // Signal 2: Check for ESPN player ad state (legacy API if available)
    try {
      if (window.espn && window.espn.video && window.espn.video.player) {
        if (window.espn.video.player.adPlaying) {
          confidence += WEIGHTS.AD_PLAYING_STATE;
          signals.push('espn-api-ad-playing');
        }
      }
    } catch (e) {
      // API not available, continue with DOM detection
    }

    // Signal 2: Ad overlay or container visible
    const adOverlaySelectors = [
      '[class*="ad-overlay"]',
      '[class*="adOverlay"]',
      '[class*="ad-container"]',
      '[class*="adContainer"]',
      '[class*="commercial"]',
      '[class*="Commercial"]',
      '[class*="advertisement"]',
      '[data-ad]',
      '[data-advertisement]',
      '.ad-break',
      '.adBreak',
    ];

    for (const selector of adOverlaySelectors) {
      const element = document.querySelector(selector);
      if (element && isElementVisible(element)) {
        confidence += WEIGHTS.AD_OVERLAY_VISIBLE;
        signals.push('ad-overlay');
        break;
      }
    }

    // Signal 3: Ad countdown or label text
    const adTextPatterns = [
      /ad\s*\d+\s*(of|\/)\s*\d+/i,          // "Ad 1 of 3"
      /commercial\s*break/i,                  // "Commercial Break"
      /advertisement/i,                        // "Advertisement"
      /your\s*(program|video|stream)\s*will\s*(resume|continue)/i,
      /\d+\s*seconds?\s*(remaining|left)/i,   // "15 seconds remaining"
      /skip\s*(ad|in)/i,                      // "Skip Ad" or "Skip in"
      /^ad$/i,                                 // Just "Ad"
    ];

    // Check common text containers
    const textContainers = document.querySelectorAll(
      '[class*="ad"] *, [class*="Ad"] *, [class*="overlay"] *, [class*="player"] span, [class*="player"] div'
    );

    for (const el of textContainers) {
      const text = (el.textContent || '').trim();
      if (text.length < 100) { // Avoid checking large text blocks
        if (adTextPatterns.some(pattern => pattern.test(text))) {
          confidence += WEIGHTS.AD_COUNTDOWN_TEXT;
          signals.push('ad-text');
          break;
        }
      }
    }

    // Signal 4: Ad break indicator in player UI
    const adBreakIndicator = document.querySelector(
      '[class*="ad-break"], [class*="adBreak"], [class*="ad-marker"], ' +
      '[class*="adMarker"], [class*="break-indicator"]'
    );
    if (adBreakIndicator && isElementVisible(adBreakIndicator)) {
      confidence += WEIGHTS.AD_BREAK_INDICATOR;
      signals.push('ad-break-indicator');
    }

    // Signal 5: Ad badge visible
    const adBadge = document.querySelector(
      '[class*="ad-badge"], [class*="adBadge"], [class*="ad-label"], ' +
      '[class*="adLabel"], [aria-label*="ad" i], [aria-label*="commercial" i]'
    );
    if (adBadge && isElementVisible(adBadge)) {
      confidence += WEIGHTS.AD_BADGE_VISIBLE;
      signals.push('ad-badge');
    }

    // Signal 6: Video time frozen
    if (checkVideoTimeAnomaly()) {
      confidence += WEIGHTS.VIDEO_TIME_FROZEN;
      signals.push('video-time-frozen');
    }

    // Signal 7: Seek bar disabled (common during ads)
    const seekBar = document.querySelector(
      '[class*="seek"], [class*="progress-bar"], [class*="scrubber"], ' +
      '[class*="timeline"], input[type="range"]'
    );
    if (seekBar) {
      const isDisabled = seekBar.hasAttribute('disabled') ||
                        seekBar.getAttribute('aria-disabled') === 'true' ||
                        seekBar.classList.contains('disabled') ||
                        window.getComputedStyle(seekBar).pointerEvents === 'none';
      if (isDisabled) {
        confidence += WEIGHTS.SEEK_DISABLED;
        signals.push('seek-disabled');
      }
    }

    // Signal 8: Audible flicker detected
    if (recentAudibleFlicker) {
      confidence += WEIGHTS.AUDIBLE_FLICKER;
      signals.push('audible-flicker');
    }

    // Signal 9: ESPN-specific player classes (BAM Media player)
    const espnPlayer = document.querySelector(
      '[class*="bam-player"], [class*="media-player"], [class*="espn-player"], ' +
      '[class*="video-player-container"]'
    );
    if (espnPlayer) {
      const playerClasses = espnPlayer.className || '';
      if (/ad[-_]?(playing|active|mode|break|state)/i.test(playerClasses)) {
        confidence += WEIGHTS.AD_PLAYING_STATE;
        signals.push('player-ad-class');
      }
    }

    // Signal 10: IMA SDK ad container (Google Interactive Media Ads - commonly used)
    const imaContainer = document.querySelector(
      '[class*="ima-"], [id*="ima-"], [class*="google-ad"], ' +
      '.videoAdUi, .videoAdUiContainer'
    );
    if (imaContainer && isElementVisible(imaContainer)) {
      confidence += 35;
      signals.push('ima-sdk');
    }

    // Cap confidence at 100
    confidence = Math.min(confidence, 100);

    if (confidence !== lastConfidence) {
      console.log(`[Hush Tab] ESPN Confidence: ${confidence} | Signals: ${signals.join(', ') || 'none'}`);
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
    const now = Date.now();

    // Debug: Log threshold comparison when confidence changes
    if (confidence > 0 && confidence !== lastConfidence) {
      console.log(`[Hush Tab] ESPN threshold check: confidence=${confidence}, threshold=${CONFIG.MUTE_THRESHOLD}, currentAdState=${currentAdState}`);
    }

    lastConfidence = confidence;

    if (!currentAdState && confidence >= CONFIG.MUTE_THRESHOLD) {
      currentAdState = true;
      lowConfidenceStartTime = null;
      console.log(`[Hush Tab] ESPN AD DETECTED (confidence: ${confidence}) - Muting`);
      notifyBackgroundScript(true);

    } else if (currentAdState && confidence < CONFIG.UNMUTE_THRESHOLD) {
      if (lowConfidenceStartTime === null) {
        lowConfidenceStartTime = now;
        console.log(`[Hush Tab] Confidence dropped to ${confidence}, waiting ${CONFIG.UNMUTE_DELAY_MS}ms before unmute`);
      } else if (now - lowConfidenceStartTime >= CONFIG.UNMUTE_DELAY_MS) {
        currentAdState = false;
        lowConfidenceStartTime = null;
        console.log(`[Hush Tab] ESPN AD ENDED (confidence: ${confidence}) - Unmuting`);
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
    console.log(`[Hush Tab] ESPN sending adStateChanged message: isAd=${isAd}, confidence=${lastConfidence}`);
    chrome.runtime.sendMessage({
      action: 'adStateChanged',
      isAd: isAd,
      url: window.location.href,
      confidence: lastConfidence,
      platform: 'espn'
    }).then(response => {
      console.log(`[Hush Tab] ESPN message sent successfully, response:`, response);
    }).catch(err => {
      console.log('[Hush Tab] Could not send message:', err);
    });
  }

  function observeDOMChanges() {
    const targetNode = document.querySelector(
      '[class*="video-player"], [class*="media-player"], [class*="player-container"]'
    ) || document.body;

    const observer = new MutationObserver((mutations) => {
      const relevantChange = mutations.some(mutation => {
        if (mutation.type === 'childList') {
          for (let node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              const className = node.className || '';
              if (/ad[-_]?(break|overlay|container|player|badge|playing)/i.test(className) ||
                  /commercial|advertisement|ima-/i.test(className)) {
                return true;
              }
              if (node.querySelector && node.querySelector('[class*="ad-"], [class*="Ad"], [class*="ima-"]')) {
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
      console.log('[Hush Tab] ESPN navigation detected');
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
