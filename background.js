// Background service worker for Hush Tab
// Monitors all tabs and detects which ones are playing audio

// Store tabs with audio state
let audioTabs = new Map();

// Alarm name constant for periodic scan
const SCAN_ALARM_NAME = 'periodicTabScan';

// --- Ad Detection ---

// Patterns to match in URLs, headers, and POST bodies (all lowercase)
const AD_DETECTION_PATTERNS = [
  'pagead',
  'pubads',
  'googleads',
  'doubleclick',
  'googleadservices',
  'googlesyndication',
  'c3.ad.system',
  'advertisercategory',
  'advertiserid',
  'media.adstart',
  'advertisingdetails',
  'media.adbreakstart',
  'ads?ver',
  'adview'
];

// URL-specific patterns using regex for short/ambiguous terms
// Matches 'ad' as a path segment (/ad/, /ad?, /ads/) not as a substring of other words
const AD_URL_REGEX = /[/&?=]ads?[/&?=.#]|[/&?=]ads?$/i;

// Ad state per tab: tabId -> { lastSignal: timestamp, signalCount: number }
const adState = new Map();

// Time-to-live for ad detection signals (ms)
const AD_TTL_MS = 5000;

// Alarm name for ad state expiry checks
const AD_CHECK_ALARM_NAME = 'adStateCheck';

/**
 * Check if any ad detection pattern is found in the given text.
 * @param {string} text - Text to search (URL, header value, POST body, etc.)
 * @returns {boolean} True if any pattern matches.
 */
function checkAdPatterns(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const pattern of AD_DETECTION_PATTERNS) {
    if (lower.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a URL contains ad-related path segments.
 * Uses regex to match 'ad' or 'ads' as a distinct URL segment,
 * avoiding false positives from words like 'download', 'add', 'loading'.
 * @param {string} url
 * @returns {boolean}
 */
function checkAdUrl(url) {
  if (!url) return false;
  return AD_URL_REGEX.test(url);
}

/**
 * Record an ad signal for a given tab, updating or creating the adState entry.
 * @param {number} tabId
 */
function recordAdSignal(tabId) {
  const now = Date.now();
  const existing = adState.get(tabId);
  if (existing) {
    existing.lastSignal = now;
    existing.signalCount += 1;
  } else {
    adState.set(tabId, { lastSignal: now, signalCount: 1 });
  }
  console.log(
    `[Ad Detection] Signal recorded for tab ${tabId} (count: ${adState.get(tabId).signalCount})`
  );
}

/**
 * Remove expired ad state entries and clean up tabs that no longer exist.
 */
function checkAdStateExpiry() {
  const now = Date.now();
  for (const [tabId, state] of adState) {
    if (now - state.lastSignal >= AD_TTL_MS) {
      adState.delete(tabId);
      console.log(`[Ad Detection] Ad state expired for tab ${tabId}`);
    }
  }
}

// --- webRequest listeners (top-level, observation-only, re-registered on every SW init) ---

// Listen for request URLs and POST bodies
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Early exit: ignore requests not associated with a tab or not in audioTabs
    if (details.tabId === -1 || !audioTabs.has(details.tabId)) {
      return;
    }

    let matched = false;

    // Check the request URL against patterns (includes + regex for short terms)
    if (checkAdPatterns(details.url) || checkAdUrl(details.url)) {
      matched = true;
    }

    // Check POST body if present and not already matched
    if (!matched && details.method === 'POST' && details.requestBody) {
      // Check raw bytes (e.g., JSON payloads)
      if (details.requestBody.raw && details.requestBody.raw.length > 0) {
        try {
          const decoder = new TextDecoder('utf-8');
          for (const element of details.requestBody.raw) {
            if (element.bytes) {
              const bodyText = decoder.decode(element.bytes);
              if (checkAdPatterns(bodyText)) {
                matched = true;
                break;
              }
            }
          }
        } catch (e) {
          // Decoding failed -- skip body check
        }
      }

      // Check form data values
      if (!matched && details.requestBody.formData) {
        for (const key of Object.keys(details.requestBody.formData)) {
          const values = details.requestBody.formData[key];
          // Check the key itself
          if (checkAdPatterns(key)) {
            matched = true;
            break;
          }
          // Check each value
          if (Array.isArray(values)) {
            for (const val of values) {
              if (checkAdPatterns(String(val))) {
                matched = true;
                break;
              }
            }
          }
          if (matched) break;
        }
      }
    }

    if (matched) {
      recordAdSignal(details.tabId);
    }
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'ping', 'image'] },
  ['requestBody']
);

// Listen for request headers
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Early exit: ignore requests not associated with a tab or not in audioTabs
    if (details.tabId === -1 || !audioTabs.has(details.tabId)) {
      return;
    }

    if (details.requestHeaders) {
      for (const header of details.requestHeaders) {
        if (checkAdPatterns(header.value)) {
          recordAdSignal(details.tabId);
          return; // one match is enough
        }
      }
    }
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'ping'] },
  ['requestHeaders', 'extraHeaders']
);

// Listen for P3P response headers on image/gif requests (ad tracking pixels)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId === -1 || !audioTabs.has(details.tabId)) {
      return;
    }

    // Check URL for ad patterns (tracking pixel URLs often contain ad domains)
    if (checkAdPatterns(details.url) || checkAdUrl(details.url)) {
      recordAdSignal(details.tabId);
      return;
    }

    // Check P3P response header for googleadservices
    if (details.responseHeaders) {
      for (const header of details.responseHeaders) {
        if (header.name.toLowerCase() === 'p3p' && header.value) {
          if (header.value.toLowerCase().includes('googleadservices')) {
            recordAdSignal(details.tabId);
            return;
          }
        }
      }
    }
  },
  { urls: ['<all_urls>'], types: ['image'] },
  ['responseHeaders', 'extraHeaders']
);

// Scan all existing tabs — called on every service worker init
// This handles the MV3 case where the worker restarts with an empty audioTabs Map
async function scanAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const currentIds = new Set();

    for (const tab of tabs) {
      const hasAudio = tab.audible || (tab.mutedInfo && tab.mutedInfo.muted);

      if (hasAudio) {
        currentIds.add(tab.id);
        audioTabs.set(tab.id, {
          id: tab.id,
          title: tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl || '',
          audible: tab.audible,
          mutedInfo: tab.mutedInfo
        });
      }
    }

    // Remove stale entries for tabs that no longer have audio or were closed
    for (const tabId of audioTabs.keys()) {
      if (!currentIds.has(tabId)) {
        audioTabs.delete(tabId);
      }
    }

    updateBadge();
  } catch (error) {
    console.error('Error scanning tabs:', error);
  }
}

// Run scan immediately on every service worker startup
// This ensures audioTabs is populated even after worker termination/restart
scanAllTabs();

// Initialize when extension is installed/updated
chrome.runtime.onInstalled.addListener(() => {
  console.log('Hush Tab initialized');
  scanAllTabs();
  setupAlarm();
});

// Re-establish the alarm when the service worker starts (it persists, but verify)
chrome.runtime.onStartup.addListener(() => {
  scanAllTabs();
  setupAlarm();
});

// Setup periodic scan alarm — replaces unreliable setInterval in MV3
async function setupAlarm() {
  const existing = await chrome.alarms.get(SCAN_ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(SCAN_ALARM_NAME, {
      periodInMinutes: 0.5 // 30 seconds
    });
  }

  // Setup faster alarm for ad state expiry checks (~5 seconds)
  const adCheckExisting = await chrome.alarms.get(AD_CHECK_ALARM_NAME);
  if (!adCheckExisting) {
    // Minimum alarm period in MV3 is ~0.5 min for persisted alarms,
    // but we use the minimum allowed: 1/12 min (~5 seconds) for development.
    // In production Chrome enforces a minimum of 0.5 min for periodic alarms.
    // We use delayInMinutes for a one-shot that re-creates itself.
    chrome.alarms.create(AD_CHECK_ALARM_NAME, {
      periodInMinutes: 1 / 12 // ~5 seconds (Chrome may enforce 0.5 min minimum)
    });
  }
}

// Ensure alarm exists on worker init
setupAlarm();

// Handle alarm fires
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCAN_ALARM_NAME) {
    scanAllTabs();
  }
  if (alarm.name === AD_CHECK_ALARM_NAME) {
    checkAdStateExpiry();
  }
});

// Listen for tab updates (including audio state changes)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if audio state or mute state changed
  if (
    changeInfo.hasOwnProperty('audible') ||
    changeInfo.hasOwnProperty('mutedInfo')
  ) {
    const hasAudio = tab.audible || (tab.mutedInfo && tab.mutedInfo.muted);

    if (hasAudio) {
      audioTabs.set(tabId, {
        id: tab.id,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl || '',
        audible: tab.audible,
        mutedInfo: tab.mutedInfo
      });
      console.log(
        `Audio detected in tab ${tabId}: ${tab.title} (muted: ${tab.mutedInfo?.muted})`
      );
    } else {
      audioTabs.delete(tabId);
      console.log(`Audio stopped in tab ${tabId}`);
    }
    updateBadge();
  }

  // Update tab info (title, url, favicon) if it exists in our map
  if (
    audioTabs.has(tabId) &&
    (changeInfo.title || changeInfo.url || changeInfo.favIconUrl)
  ) {
    const tabInfo = audioTabs.get(tabId);
    audioTabs.set(tabId, {
      ...tabInfo,
      title: changeInfo.title || tabInfo.title,
      url: changeInfo.url || tabInfo.url,
      favIconUrl: changeInfo.favIconUrl || tabInfo.favIconUrl
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
  // Clean up ad state for removed tabs
  if (adState.has(tabId)) {
    adState.delete(tabId);
    console.log(`[Ad Detection] Cleaned up ad state for removed tab ${tabId}`);
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

// Handle messages from popup and other extension pages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAudioTabs') {
    // Always rescan before responding to guarantee fresh data,
    // especially after service worker restart where audioTabs may be stale
    scanAllTabs().then(() => {
      const now = Date.now();
      const tabs = Array.from(audioTabs.values()).map(tab => ({
        ...tab,
        adDetected: adState.has(tab.id) && (now - adState.get(tab.id).lastSignal < AD_TTL_MS)
      }));
      sendResponse({ tabs });
    }).catch((error) => {
      console.error('Error rescanning for getAudioTabs:', error);
      // Fall back to whatever we have in memory
      const now = Date.now();
      const tabs = Array.from(audioTabs.values()).map(tab => ({
        ...tab,
        adDetected: adState.has(tab.id) && (now - adState.get(tab.id).lastSignal < AD_TTL_MS)
      }));
      sendResponse({ tabs });
    });
    return true;
  }

  if (request.action === 'muteTab') {
    chrome.tabs.update(request.tabId, { muted: true }).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'unmuteTab') {
    chrome.tabs.update(request.tabId, { muted: false }).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'focusTab') {
    chrome.tabs.update(request.tabId, { active: true }).then(() => {
      return chrome.windows.update(request.windowId, { focused: true });
    }).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
});
