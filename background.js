// Background service worker for audio detection
// Monitors all tabs and detects which ones are playing audio

// Store tabs with audio state
let audioTabs = new Map();

// Store auto-mute state per tab (tracks if we auto-muted due to ad)
let autoMutedTabs = new Set();

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
});

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

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  if (audioTabs.has(tabId)) {
    audioTabs.delete(tabId);
    console.log(`Tab ${tabId} removed`);
    updateBadge();
  }
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
      console.log(`[Hush Tab] Auto-mute disabled, ignoring ad state for tab ${tabId}`);
      return;
    }
    
    if (isAd) {
      // Ad started - mute the tab if not already muted
      if (!tab.mutedInfo.muted) {
        console.log(`[Hush Tab] Ad detected in tab ${tabId}, auto-muting`);
        await chrome.tabs.update(tabId, { muted: true });
        autoMutedTabs.add(tabId);
      }
    } else {
      // Content resumed - unmute only if we auto-muted it
      if (autoMutedTabs.has(tabId)) {
        console.log(`[Hush Tab] Content resumed in tab ${tabId}, auto-unmuting`);
        await chrome.tabs.update(tabId, { muted: false });
        autoMutedTabs.delete(tabId);
      } else {
        console.log(`[Hush Tab] Content resumed in tab ${tabId}, but was not auto-muted (user may have manually muted)`);
      }
    }
  } catch (error) {
    console.error(`[Hush Tab] Error handling ad state change for tab ${tabId}:`, error);
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
