// Background service worker for Hush Tab
// Monitors all tabs and detects which ones are playing audio

// Store tabs with audio state
let audioTabs = new Map();

// --- Auto-mute state ---

// Tracks tabs that the extension has auto-muted (only unmute these on ad expiry)
const autoMutedTabs = new Set();

// Tracks tabs where the user manually unmuted during an ad (don't re-mute until fresh ad)
const userOverrideTabs = new Set();

// Cached in-memory; persisted in chrome.storage.local
let autoMuteEnabled = false;

// Load autoMuteEnabled from storage on startup
chrome.storage.local.get({ autoMuteEnabled: false }, (result) => {
  autoMuteEnabled = result.autoMuteEnabled;
  console.log(`[Auto-Mute] Loaded autoMuteEnabled = ${autoMuteEnabled}`);
});

// Keep the cached value in sync when storage changes (e.g., from popup or another context)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.autoMuteEnabled) {
    autoMuteEnabled = changes.autoMuteEnabled.newValue;
    console.log(`[Auto-Mute] Storage changed, autoMuteEnabled = ${autoMuteEnabled}`);
  }
});

// Alarm name constant for periodic scan
const SCAN_ALARM_NAME = 'periodicTabScan';

// --- Ad Detection ---

// Patterns to match in URLs, headers, and POST bodies (all lowercase)
const AD_DETECTION_PATTERNS = [
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
  'adview',
  'adsafeprotected',
  'adVideoStart',
  'adnxs'
];

// URL-specific patterns using regex for short/ambiguous terms
// Matches 'ad' as a path segment (/ad/, /ad?, /ads/) not as a substring of other words
const AD_URL_REGEX = /[/&?=]ads?[/&?=.#]|[/&?=]ads?$/i;

// Ad state per tab: tabId -> {
//   lastSignal: number,        — timestamp of most recent signal
//   firstSignal: number,       — timestamp of first signal in this break
//   signalCount: number,       — total signals in this break
//   phase: 'active' | 'grace', — active = signals arriving; grace = waiting to confirm end
//   graceStartTime: number|null — when we entered grace phase
// }
const adState = new Map();

// How long after the last signal before entering grace phase (ms)
const AD_SIGNAL_TTL_MS = 20000;

// How long silence must be sustained in grace phase before actually unmuting (ms)
const UNMUTE_GRACE_MS = 10000;

// Minimum signals required before auto-muting (filters stray single-beacon matches)
const MIN_SIGNAL_COUNT = 2;

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
 * If auto-mute is enabled, mutes the tab (respecting user overrides).
 * @param {number} tabId
 */
function recordAdSignal(tabId) {
  const now = Date.now();
  const existing = adState.get(tabId);
  if (existing) {
    existing.lastSignal = now;
    existing.signalCount += 1;

    // If we were in the grace phase, cancel the pending unmute —
    // a new signal means the ad break is still ongoing
    if (existing.phase === 'grace') {
      existing.phase = 'active';
      existing.graceStartTime = null;
      console.log(`[Ad Detection] New signal during grace phase for tab ${tabId} — staying muted`);
    }
  } else {
    adState.set(tabId, {
      lastSignal: now,
      firstSignal: now,
      signalCount: 1,
      phase: 'active',
      graceStartTime: null
    });
  }
  console.log(
    `[Ad Detection] Signal recorded for tab ${tabId} (count: ${adState.get(tabId).signalCount})`
  );

  // Auto-mute logic
  if (autoMuteEnabled) {
    // If the user manually unmuted during this ad break, respect that choice
    if (userOverrideTabs.has(tabId)) {
      return;
    }

    // If we already auto-muted this tab, nothing to do
    if (autoMutedTabs.has(tabId)) {
      return;
    }

    // Require minimum signal count before muting to avoid false positives
    if (adState.get(tabId).signalCount < MIN_SIGNAL_COUNT) {
      return;
    }

    // Only mute if the tab is not already muted
    const tabInfo = audioTabs.get(tabId);
    if (tabInfo && !tabInfo.mutedInfo?.muted) {
      chrome.tabs.update(tabId, { muted: true }).then(() => {
        autoMutedTabs.add(tabId);
        console.log(`[Auto-Mute] Muted tab ${tabId} due to ad signal`);
      }).catch((error) => {
        console.error(`[Auto-Mute] Failed to mute tab ${tabId}:`, error);
      });
    }
  }
}

/**
 * Check ad state entries using a two-phase approach:
 * 1. Active phase: signals are arriving. After AD_SIGNAL_TTL_MS of silence, transition to grace.
 * 2. Grace phase: waiting to confirm ad is truly over. If UNMUTE_GRACE_MS elapses with no
 *    new signals, the ad break is genuinely over and the tab is unmuted.
 *    If a new signal arrives during grace, recordAdSignal() flips back to active.
 */
function checkAdStateExpiry() {
  const now = Date.now();
  for (const [tabId, state] of adState) {
    const silenceDuration = now - state.lastSignal;

    if (state.phase === 'active') {
      // Transition to grace phase when signals have been quiet long enough
      if (silenceDuration >= AD_SIGNAL_TTL_MS) {
        state.phase = 'grace';
        state.graceStartTime = now;
        console.log(
          `[Ad Detection] Tab ${tabId} entering grace phase (${state.signalCount} signals over ${now - state.firstSignal}ms)`
        );
      }
      continue;
    }

    if (state.phase === 'grace') {
      const graceDuration = now - state.graceStartTime;

      if (graceDuration >= UNMUTE_GRACE_MS) {
        // Grace period elapsed with no new signals — ad break is genuinely over
        adState.delete(tabId);
        console.log(`[Ad Detection] Ad state expired for tab ${tabId} after grace period`);

        // If this tab was auto-muted by us, unmute it now
        if (autoMutedTabs.has(tabId)) {
          chrome.tabs.update(tabId, { muted: false }).then(() => {
            console.log(`[Auto-Mute] Unmuted tab ${tabId} (grace period elapsed)`);
          }).catch((error) => {
            console.error(`[Auto-Mute] Failed to unmute tab ${tabId}:`, error);
          });
          autoMutedTabs.delete(tabId);
        }
        // Always clear user override when ad break ends — fresh start for next ad
        userOverrideTabs.delete(tabId);
      }
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

  // Setup alarm for ad state expiry checks
  // Chrome enforces a minimum of ~30 seconds for periodic alarms in MV3.
  // With AD_SIGNAL_TTL_MS (20s) + UNMUTE_GRACE_MS (10s) = 30s minimum before unmute,
  // the ~30s alarm period means worst-case unmute delay is ~60s after last signal.
  const adCheckExisting = await chrome.alarms.get(AD_CHECK_ALARM_NAME);
  if (!adCheckExisting) {
    chrome.alarms.create(AD_CHECK_ALARM_NAME, {
      periodInMinutes: 0.5 // 30 seconds (Chrome's enforced minimum)
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

    // Detect user override: if a tab transitions to unmuted and was in autoMutedTabs,
    // the user manually unmuted it -- respect that choice for this ad break
    if (
      changeInfo.mutedInfo &&
      changeInfo.mutedInfo.muted === false &&
      autoMutedTabs.has(tabId)
    ) {
      autoMutedTabs.delete(tabId);
      userOverrideTabs.add(tabId);
      console.log(`[Auto-Mute] User override detected for tab ${tabId} -- will not re-mute until next ad break`);
    }
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
  // Clean up auto-mute tracking for removed tabs
  if (autoMutedTabs.has(tabId)) {
    autoMutedTabs.delete(tabId);
    console.log(`[Auto-Mute] Cleaned up autoMutedTabs for removed tab ${tabId}`);
  }
  if (userOverrideTabs.has(tabId)) {
    userOverrideTabs.delete(tabId);
    console.log(`[Auto-Mute] Cleaned up userOverrideTabs for removed tab ${tabId}`);
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
      const tabs = Array.from(audioTabs.values()).map(tab => ({
        ...tab,
        adDetected: adState.has(tab.id),
        autoMuted: autoMutedTabs.has(tab.id)
      }));
      sendResponse({ tabs });
    }).catch((error) => {
      console.error('Error rescanning for getAudioTabs:', error);
      // Fall back to whatever we have in memory
      const tabs = Array.from(audioTabs.values()).map(tab => ({
        ...tab,
        adDetected: adState.has(tab.id),
        autoMuted: autoMutedTabs.has(tab.id)
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

  if (request.action === 'getAutoMuteEnabled') {
    sendResponse({ enabled: autoMuteEnabled });
    return false;
  }

  if (request.action === 'setAutoMuteEnabled') {
    const enabled = !!request.enabled;
    autoMuteEnabled = enabled;
    chrome.storage.local.set({ autoMuteEnabled: enabled }, () => {
      console.log(`[Auto-Mute] autoMuteEnabled set to ${enabled}`);
    });

    // If disabled, immediately unmute all auto-muted tabs and clear tracking Sets
    if (!enabled) {
      const unmutePromises = [];
      for (const tabId of autoMutedTabs) {
        unmutePromises.push(
          chrome.tabs.update(tabId, { muted: false }).then(() => {
            console.log(`[Auto-Mute] Unmuted tab ${tabId} (auto-mute disabled)`);
          }).catch((error) => {
            console.error(`[Auto-Mute] Failed to unmute tab ${tabId} on disable:`, error);
          })
        );
      }
      autoMutedTabs.clear();
      userOverrideTabs.clear();
      console.log('[Auto-Mute] Cleared autoMutedTabs and userOverrideTabs');

      Promise.all(unmutePromises).then(() => {
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: true });
    }
    return true;
  }
});
