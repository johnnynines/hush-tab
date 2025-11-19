// Background service worker for audio detection
// Monitors all tabs and detects which ones are playing audio

// Store tabs with audio state
let audioTabs = new Map();

// Initialize when extension is installed/updated
chrome.runtime.onInstalled.addListener(() => {
  console.log('Audio Tab Detector initialized');
  scanAllTabs();
});

// Scan all existing tabs on startup
async function scanAllTabs() {
  const tabs = await chrome.tabs.query({});
  tabs.forEach(tab => {
    if (tab.audible) {
      audioTabs.set(tab.id, {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        audible: true,
        mutedInfo: tab.mutedInfo
      });
    }
  });
  updateBadge();
}

// Listen for tab updates (including audio state changes)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if audio state changed
  if (changeInfo.hasOwnProperty('audible')) {
    if (changeInfo.audible) {
      // Tab started playing audio
      audioTabs.set(tabId, {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        audible: true,
        mutedInfo: tab.mutedInfo
      });
      console.log(`Audio started in tab ${tabId}: ${tab.title}`);
    } else {
      // Tab stopped playing audio
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
  
  // Update muted state
  if (changeInfo.mutedInfo && audioTabs.has(tabId)) {
    const tabInfo = audioTabs.get(tabId);
    audioTabs.set(tabId, {
      ...tabInfo,
      mutedInfo: changeInfo.mutedInfo
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
});

// Periodic scan to ensure we don't miss any tabs (fallback)
setInterval(() => {
  scanAllTabs();
}, 30000); // Every 30 seconds
