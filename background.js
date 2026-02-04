// Background service worker for audio detection
// Monitors all tabs and detects which ones are playing audio

// Store tabs with audio state
let audioTabs = new Map();

// Store auto-mute state per tab (tracks if we auto-muted due to ad)
let autoMutedTabs = new Set();

// Track audible state changes for flicker detection (potential ad transitions)
let audibleStateHistory = new Map(); // tabId -> { changes: [{time, audible}], lastNotified: timestamp }

// Configuration for audible flicker detection
const AUDIBLE_CONFIG = {
  HISTORY_WINDOW_MS: 5000,      // Track changes within this window
  FLICKER_THRESHOLD: 2,         // Number of changes to consider a "flicker"
  NOTIFY_COOLDOWN_MS: 3000,     // Don't notify more often than this
};

// Network-based ad detection configuration
const AD_NETWORK_CONFIG = {
  // Known ad server domain patterns
  AD_DOMAINS: [
    'doubleclick.net',
    'googlesyndication.com',
    'googleadservices.com',
    'moatads.com',
    '2mdn.net',
    'adskeeper.com',
    'adservice.google.com',
    'imasdk.googleapis.com',
    'pubads.g.doubleclick.net',
    'securepubads.g.doubleclick.net',
    'ad.doubleclick.net',
    'ads.espn.com',
    'ads.hulu.com',
    'ads.youtube.com',
    'fwmrm.net',           // FreeWheel ad server (used by many broadcasters)
    'uplynk.com',          // Verizon ad platform
    'innovid.com',         // Video ad platform
    'spotxchange.com',     // SpotX ads
    'springserve.com',     // Ad server
  ],
  // How long to consider ad "active" after last ad request (ms)
  AD_ACTIVITY_TIMEOUT_MS: 10000,
  // Minimum requests to consider an ad is playing
  MIN_AD_REQUESTS: 2,
};

// Track ad network activity per tab
let adNetworkActivity = new Map(); // tabId -> { lastAdRequest: timestamp, requestCount: number, isAdActive: boolean }

// Initialize when extension is installed/updated
chrome.runtime.onInstalled.addListener(() => {
  console.log('Audio Tab Detector initialized');
  
  // Set default auto-mute preference
  chrome.storage.sync.get(['autoMuteAds'], (result) => {
    if (result.autoMuteAds === undefined) {
      chrome.storage.sync.set({ autoMuteAds: true });
      console.log('Auto-mute ads enabled by default');
    }
  });
  
  scanAllTabs();
  setupNetworkAdDetection();
});

// Setup network-based ad detection
function setupNetworkAdDetection() {

  // Listen for web requests to ad servers
  chrome.webRequest.onBeforeRequest.addListener(
    handleAdNetworkRequest,
    {
      urls: [
        "*://*.doubleclick.net/*",
        "*://*.googlesyndication.com/*",
        "*://*.googleadservices.com/*",
        "*://*.moatads.com/*",
        "*://*.2mdn.net/*",
        "*://*.imasdk.googleapis.com/*",
        "*://*.fwmrm.net/*",
        "*://*.uplynk.com/*",
        "*://*.innovid.com/*",
        "*://*.spotxchange.com/*",
        "*://*.springserve.com/*",
        "*://ads.espn.com/*",
        "*://ads.hulu.com/*",
      ],
      types: ["xmlhttprequest", "media", "script", "image", "other"]
    }
  );

  // Periodically check and update ad state
  setInterval(checkAdNetworkActivity, 2000);
}

// Handle detected ad network request
function handleAdNetworkRequest(details) {
  const tabId = details.tabId;
  if (tabId < 0) return; // Ignore requests not associated with a tab

  const now = Date.now();
  const url = details.url;

  // Check if this URL matches known ad domains
  const isAdRequest = AD_NETWORK_CONFIG.AD_DOMAINS.some(domain => url.includes(domain));

  if (isAdRequest) {
    // Initialize or update tab's ad activity
    if (!adNetworkActivity.has(tabId)) {
      adNetworkActivity.set(tabId, {
        lastAdRequest: now,
        requestCount: 0,
        isAdActive: false,
        recentUrls: []
      });
    }

    const activity = adNetworkActivity.get(tabId);
    activity.lastAdRequest = now;
    activity.requestCount++;
    activity.recentUrls.push(url.substring(0, 80));
    if (activity.recentUrls.length > 10) activity.recentUrls.shift();

    // If we have enough ad requests, consider ad as active
    if (activity.requestCount >= AD_NETWORK_CONFIG.MIN_AD_REQUESTS && !activity.isAdActive) {
      activity.isAdActive = true;
      handleNetworkAdDetected(tabId, true);
    }
  }
}

// Check ad network activity and update state
function checkAdNetworkActivity() {
  const now = Date.now();

  adNetworkActivity.forEach((activity, tabId) => {
    // Check if ad activity has timed out
    if (activity.isAdActive) {
      const timeSinceLastRequest = now - activity.lastAdRequest;
      if (timeSinceLastRequest > AD_NETWORK_CONFIG.AD_ACTIVITY_TIMEOUT_MS) {
        activity.isAdActive = false;
        activity.requestCount = 0;
        handleNetworkAdDetected(tabId, false);
      }
    }
  });
}

// Handle network-based ad detection - send signal to content script for confidence scoring
async function handleNetworkAdDetected(tabId, isAd) {
  try {
    const tab = await chrome.tabs.get(tabId);

    // Check if this is a supported streaming site
    const isSupportedSite = tab.url && (
      tab.url.includes('espn.com') ||
      tab.url.includes('hulu.com') ||
      tab.url.includes('youtube.com') ||
      tab.url.includes('nbc.com')
    );

    if (!isSupportedSite) return;

    // Send signal to content script to use as confidence data point
    await chrome.tabs.sendMessage(tabId, {
      action: 'networkAdDetected',
      isAd: isAd,
      timestamp: Date.now()
    });
  } catch (error) {
    // Content script may not be loaded, ignore
  }
}

// Scan all existing tabs on startup
async function scanAllTabs() {
  const tabs = await chrome.tabs.query({});
  tabs.forEach(tab => {
    // Track tabs that are audible OR have audio but are muted
    // A tab with mutedInfo.muted = true still has active audio, just silenced
    const hasAudio = tab.audible || (tab.mutedInfo && tab.mutedInfo.muted);
    
    if (hasAudio) {
      audioTabs.set(tab.id, {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        audible: tab.audible,
        mutedInfo: tab.mutedInfo
      });
    } else {
      // Remove tabs that no longer have audio
      audioTabs.delete(tab.id);
    }
  });
  updateBadge();
}

// Listen for tab updates (including audio state changes)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if audio state or mute state changed
  if (changeInfo.hasOwnProperty('audible') || changeInfo.hasOwnProperty('mutedInfo')) {
    // A tab has audio if it's audible OR if it's muted (muted means audio exists but is silenced)
    const hasAudio = tab.audible || (tab.mutedInfo && tab.mutedInfo.muted);

    if (hasAudio) {
      // Tab has active audio (muted or unmuted)
      audioTabs.set(tabId, {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        audible: tab.audible,
        mutedInfo: tab.mutedInfo
      });
      console.log(`Audio detected in tab ${tabId}: ${tab.title} (muted: ${tab.mutedInfo?.muted})`);
    } else {
      // Tab no longer has any audio activity
      audioTabs.delete(tabId);
      console.log(`Audio stopped in tab ${tabId}`);
    }
    updateBadge();

    // Track audible state changes for flicker detection
    if (changeInfo.hasOwnProperty('audible')) {
      trackAudibleStateChange(tabId, tab.audible, tab.url);
    }
  }

  // Update tab info if it exists in our map
  if (audioTabs.has(tabId) && (changeInfo.title || changeInfo.url)) {
    const tabInfo = audioTabs.get(tabId);
    audioTabs.set(tabId, {
      ...tabInfo,
      title: changeInfo.title || tabInfo.title,
      url: changeInfo.url || tabInfo.url
    });
  }
});

/**
 * Track audible state changes to detect "flicker" patterns
 * that may indicate ad/content transitions
 */
function trackAudibleStateChange(tabId, audible, url) {
  const now = Date.now();

  // Initialize history for this tab if needed
  if (!audibleStateHistory.has(tabId)) {
    audibleStateHistory.set(tabId, { changes: [], lastNotified: 0 });
  }

  const history = audibleStateHistory.get(tabId);

  // Add this change to history
  history.changes.push({ time: now, audible });

  // Remove old entries outside the window
  history.changes = history.changes.filter(
    change => now - change.time < AUDIBLE_CONFIG.HISTORY_WINDOW_MS
  );

  // Check if we have a "flicker" pattern (multiple changes in short window)
  const hasFlicker = history.changes.length >= AUDIBLE_CONFIG.FLICKER_THRESHOLD;

  // Only notify if we haven't notified recently and this is a supported streaming tab
  const canNotify = now - history.lastNotified > AUDIBLE_CONFIG.NOTIFY_COOLDOWN_MS;
  const isSupportedSite = url && (
    url.includes('youtube.com') ||
    url.includes('hulu.com') ||
    url.includes('espn.com') ||
    url.includes('nbc.com')
  );

  if (hasFlicker && canNotify && isSupportedSite) {
    history.lastNotified = now;

    // Notify the content script about the audible state change
    notifyContentScriptAudibleChange(tabId, audible, history.changes.length);
  }
}

/**
 * Send audible state change notification to content script
 */
async function notifyContentScriptAudibleChange(tabId, audible, changeCount) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'audibleStateChanged',
      audible: audible,
      flickerCount: changeCount,
      timestamp: Date.now()
    });
  } catch (error) {
    // Content script may not be loaded yet, ignore
  }
}

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  if (audioTabs.has(tabId)) {
    audioTabs.delete(tabId);
    console.log(`Tab ${tabId} removed`);
    updateBadge();
  }
  // Clean up audible state history
  audibleStateHistory.delete(tabId);
  // Clean up ad network activity
  adNetworkActivity.delete(tabId);
});

// Update badge with count of tabs playing audio
function updateBadge() {
  const count = audioTabs.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B6B' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAudioTabs') {
    // Convert Map to array for sending
    const tabs = Array.from(audioTabs.values());
    sendResponse({ tabs: tabs });
    return true;
  }
  
  if (request.action === 'muteTab') {
    chrome.tabs.update(request.tabId, { muted: true }).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (request.action === 'unmuteTab') {
    chrome.tabs.update(request.tabId, { muted: false }).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (request.action === 'focusTab') {
    chrome.tabs.update(request.tabId, { active: true }).then(() => {
      chrome.windows.update(request.windowId, { focused: true }).then(() => {
        sendResponse({ success: true });
      });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  // Handle ad state changes from content scripts
  if (request.action === 'adStateChanged') {
    handleAdStateChange(sender.tab.id, request.isAd);
    sendResponse({ success: true });
    return true;
  }
  
  // Get auto-mute settings
  if (request.action === 'getAutoMuteSettings') {
    chrome.storage.sync.get(['autoMuteAds'], (result) => {
      sendResponse({ autoMuteAds: result.autoMuteAds !== false });
    });
    return true;
  }
  
  // Set auto-mute settings
  if (request.action === 'setAutoMuteSettings') {
    chrome.storage.sync.set({ autoMuteAds: request.enabled }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Handle ad state changes from content scripts
async function handleAdStateChange(tabId, isAd) {
  try {
    const tab = await chrome.tabs.get(tabId);
    
    // Check if auto-mute is enabled
    const settings = await chrome.storage.sync.get(['autoMuteAds']);
    const autoMuteEnabled = settings.autoMuteAds !== false;
    
    if (!autoMuteEnabled) {
      return;
    }
    
    if (isAd) {
      // Ad started - mute the tab if not already muted
      if (!tab.mutedInfo.muted) {
        await chrome.tabs.update(tabId, { muted: true });
        autoMutedTabs.add(tabId);
      }
    } else {
      // Content resumed - unmute only if we auto-muted it
      if (autoMutedTabs.has(tabId)) {
        await chrome.tabs.update(tabId, { muted: false });
        autoMutedTabs.delete(tabId);
      }
    }
  } catch (error) {
    // Error handling ad state change
  }
}

// Clean up auto-mute tracking when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  autoMutedTabs.delete(tabId);
});

// Periodic scan to ensure we don't miss any tabs (fallback)
setInterval(() => {
  scanAllTabs();
}, 30000); // Every 30 seconds
