// YouTube Ad Detection Content Script
// Monitors YouTube player for ads and notifies background script for auto-mute

(function() {
  'use strict';
  
  console.log('[Hush Tab] YouTube content script loaded');
  
  let isAdPlaying = false;
  let isAutoMuteEnabled = false;
  let checkInterval = null;
  
  // Load auto-mute preference from storage
  chrome.storage.sync.get(['autoMuteAds'], (result) => {
    isAutoMuteEnabled = result.autoMuteAds !== false; // Default to true
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
  
  function startMonitoring() {
    if (checkInterval) return; // Already monitoring
    
    console.log('[Hush Tab] Starting YouTube ad monitoring');
    
    // Check immediately
    checkForAds();
    
    // Then check every 500ms for responsive detection
    checkInterval = setInterval(checkForAds, 500);
    
    // Also use MutationObserver for immediate detection
    observeDOMChanges();
  }
  
  function stopMonitoring() {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
      console.log('[Hush Tab] Stopped YouTube ad monitoring');
    }
  }
  
  function checkForAds() {
    const adDetected = isYouTubeAdPlaying();
    
    if (adDetected !== isAdPlaying) {
      isAdPlaying = adDetected;
      console.log('[Hush Tab] Ad state changed:', isAdPlaying ? 'AD PLAYING' : 'CONTENT PLAYING');
      
      // Notify background script
      chrome.runtime.sendMessage({
        action: 'adStateChanged',
        isAd: isAdPlaying,
        url: window.location.href
      }).catch(err => {
        // Extension context may be invalidated, ignore
        console.log('[Hush Tab] Could not send message:', err);
      });
    }
  }
  
  function isYouTubeAdPlaying() {
    // Method 1: Check for ad-specific overlay elements
    const adOverlay = document.querySelector('.ytp-ad-player-overlay');
    if (adOverlay) return true;
    
    // Method 2: Check for "Skip Ad" button
    const skipButton = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button');
    if (skipButton && skipButton.offsetParent !== null) return true;
    
    // Method 3: Check for ad text indicator
    const adText = document.querySelector('.ytp-ad-text');
    if (adText && adText.offsetParent !== null) return true;
    
    // Method 4: Check video element for ad module
    const video = document.querySelector('video.html5-main-video');
    if (video) {
      const adModule = document.querySelector('.video-ads');
      if (adModule && adModule.children.length > 0) return true;
    }
    
    // Method 5: Check player container for ad class
    const playerAd = document.querySelector('.ad-showing');
    if (playerAd) return true;
    
    // Method 6: Check for ad container
    const adContainer = document.querySelector('.video-ads.ytp-ad-module');
    if (adContainer && adContainer.querySelector('.ytp-ad-player-overlay-instream-info')) {
      return true;
    }
    
    // Method 7: Check player API state (if available)
    try {
      const player = document.querySelector('.html5-video-player');
      if (player && player.classList.contains('ad-showing')) {
        return true;
      }
      if (player && player.classList.contains('ad-interrupting')) {
        return true;
      }
    } catch (e) {
      // Ignore errors accessing player state
    }
    
    return false;
  }
  
  function observeDOMChanges() {
    // Watch for changes in the video player area
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
                node.classList.contains('ytp-ad-skip-button') ||
                node.classList.contains('video-ads')
              )) {
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
      console.log('[Hush Tab] YouTube navigation detected');
      // Reset state on navigation
      isAdPlaying = false;
      if (isAutoMuteEnabled) {
        checkForAds();
      }
    }
  }).observe(document, { subtree: true, childList: true });
  
})();
