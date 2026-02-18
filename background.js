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

// Tier 1 (weight 10): Conclusive ad-tech domains and unambiguous event names.
// A single match from this tier is strong enough to trigger auto-mute.
const AD_PATTERNS_TIER1 = [
  'doubleclick',
  'googlesyndication',
  'googleadservices',
  'adnxs',
  'adsafeprotected',
  'c3.ad.system',
  'media.adstart',
  'media.adbreakstart',
];

// Tier 2 (weight 5): Ad-specific strings that could rarely appear in platform APIs.
// Two tier-2 matches are needed to reach the mute threshold.
const AD_PATTERNS_TIER2 = [
  'pubads',
  'googleads',
  'advertisercategory',
  'advertiserid',
  'advertisingdetails',
  'ads?ver',
  'adview',
  'advideostart',
];

// Tier 3 (weight 1): Generic URL regex match for 'ad'/'ads' as a path segment.
// Cannot trigger mute alone — requires corroboration from tier-1 or tier-2 matches.
const AD_URL_REGEX = /[/&?=]ads?[/&?=.#]|[/&?=]ads?$/i;

// Ad state per tab: tabId -> {
//   recentSignals: Array<{timestamp, weight}>, — rolling window for burst detection
//   lastSignal: number,          — timestamp of most recent signal (for TTL in confirmed phase)
//   firstSignal: number,         — timestamp of first signal
//   phase: 'pending'|'confirmed'|'grace',
//     pending   = signals arriving but no burst detected yet (no muting)
//     confirmed = burst detected, ad is playing (tab muted)
//     grace     = silence after confirmed, waiting to confirm ad is over
//   graceStartTime: number|null  — when we entered grace phase
// }
const adState = new Map();

// Burst detection: time window and thresholds to confirm an ad break.
// During real ads, many ad-tech requests fire in rapid succession (impression beacons,
// quartile tracking, etc.). Sporadic background SDK pings don't reach these thresholds.
const BURST_WINDOW_MS = 8000;

// Primary threshold: weight-based. Works for platforms using standard ad-tech
// (doubleclick, googlesyndication, etc.) where tier-1 (+10) signals appear.
const BURST_WEIGHT_THRESHOLD = 20; // 2x tier-1 (10+10) or 4x tier-2 (5*4)

// Secondary threshold: count-based. For platforms whose ad requests only match the
// generic URL regex (tier-3, weight 1). Requires more individual signals to confirm,
// relying on the higher request frequency during actual ad breaks vs sporadic
// background pings during content playback.
const BURST_COUNT_THRESHOLD = 5;

// How long after the last signal before entering grace phase (confirmed → grace)
const AD_SIGNAL_TTL_MS = 10000;

// How long silence must be sustained in grace phase before actually unmuting
const UNMUTE_GRACE_MS = 5000;

// Maximum ad state duration — force-expire to prevent permanent muting
// No real ad break lasts longer than this
const MAX_AD_DURATION_MS = 300000; // 5 minutes

// Alarm name for ad state expiry checks
const AD_CHECK_ALARM_NAME = 'adStateCheck';

/**
 * Returns the tier weight for the highest-priority pattern match found in text.
 * Tier 1 = 10, Tier 2 = 5, 0 = no match.
 * @param {string} text - Text to search (URL, header value, POST body, etc.)
 * @returns {number} Weight of the match (0 if none).
 */
function getPatternWeight(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  for (const pattern of AD_PATTERNS_TIER1) {
    if (lower.includes(pattern)) return 10;
  }
  for (const pattern of AD_PATTERNS_TIER2) {
    if (lower.includes(pattern)) return 5;
  }
  return 0;
}

/**
 * Returns weight 1 if the URL contains 'ad' or 'ads' as a distinct path segment.
 * Uses regex to avoid false positives from words like 'download', 'add', 'loading'.
 * @param {string} url
 * @returns {number} 1 if matched, 0 otherwise.
 */
function getUrlWeight(url) {
  if (!url) return 0;
  return AD_URL_REGEX.test(url) ? 1 : 0;
}

/**
 * Record an ad signal for a given tab with a weighted confidence value.
 * Uses burst detection: only triggers muting when enough weighted signals
 * arrive within a short time window, filtering out sporadic ad-tech pings
 * that some platforms generate during regular content playback.
 * @param {number} tabId
 * @param {number} weight - Signal weight (10 = tier-1, 5 = tier-2, 1 = tier-3)
 */
function recordAdSignal(tabId, weight) {
  const now = Date.now();
  const existing = adState.get(tabId);

  if (existing) {
    existing.lastSignal = now;
    existing.recentSignals.push({ timestamp: now, weight });

    // Evict signals older than the burst window
    existing.recentSignals = existing.recentSignals.filter(
      s => now - s.timestamp <= BURST_WINDOW_MS
    );

    const windowWeight = existing.recentSignals.reduce((sum, s) => sum + s.weight, 0);
    const signalCount = existing.recentSignals.length;
    const burstDetected = windowWeight >= BURST_WEIGHT_THRESHOLD || signalCount >= BURST_COUNT_THRESHOLD;

    if (existing.phase === 'pending') {
      // Check if either burst threshold is reached — confirms an actual ad break
      if (burstDetected) {
        existing.phase = 'confirmed';
        console.log(
          `[Ad Detection] Burst confirmed for tab ${tabId} (weight: ${windowWeight}, count: ${signalCount})`
        );
      }
    } else if (existing.phase === 'grace') {
      // During grace, only a new BURST cancels the pending unmute.
      // A single sporadic signal does NOT cancel grace — this prevents
      // platforms with ongoing ad-tech pings from blocking the unmute.
      if (burstDetected) {
        existing.phase = 'confirmed';
        existing.graceStartTime = null;
        console.log(
          `[Ad Detection] New burst during grace for tab ${tabId} — staying muted (weight: ${windowWeight}, count: ${signalCount})`
        );
      }
    }
    // In 'confirmed' phase, lastSignal update keeps the TTL alive
  } else {
    adState.set(tabId, {
      recentSignals: [{ timestamp: now, weight }],
      lastSignal: now,
      firstSignal: now,
      phase: 'pending',
      graceStartTime: null
    });
  }

  const state = adState.get(tabId);
  const windowWeight = state.recentSignals.reduce((sum, s) => sum + s.weight, 0);
  const windowCount = state.recentSignals.length;
  console.log(
    `[Ad Detection] Signal for tab ${tabId} (+${weight}, weight: ${windowWeight}, count: ${windowCount}, phase: ${state.phase})`
  );

  // Auto-mute only when burst is confirmed (not during pending phase)
  if (autoMuteEnabled && state.phase === 'confirmed') {
    if (userOverrideTabs.has(tabId)) return;
    if (autoMutedTabs.has(tabId)) return;

    const tabInfo = audioTabs.get(tabId);
    if (tabInfo && !tabInfo.mutedInfo?.muted) {
      chrome.tabs.update(tabId, { muted: true }).then(() => {
        autoMutedTabs.add(tabId);
        console.log(`[Auto-Mute] Muted tab ${tabId} (weight: ${windowWeight}, count: ${windowCount})`);
      }).catch((error) => {
        console.error(`[Auto-Mute] Failed to mute tab ${tabId}:`, error);
      });
    }
  }
}

/**
 * Check ad state entries using a three-phase approach:
 * 1. Pending: signals arriving but no burst detected — clean up when window empties.
 * 2. Confirmed: burst detected, ad is playing. After AD_SIGNAL_TTL_MS of silence, enter grace.
 * 3. Grace: waiting to confirm ad is truly over. Only a new burst cancels grace.
 *
 * Also enforces MAX_AD_DURATION_MS to prevent permanent muting from platforms
 * with continuous ad-tech background traffic.
 */
function checkAdStateExpiry() {
  const now = Date.now();
  for (const [tabId, state] of adState) {
    // Safety net: force-expire any ad state older than MAX_AD_DURATION_MS
    if (now - state.firstSignal >= MAX_AD_DURATION_MS) {
      adState.delete(tabId);
      console.log(`[Ad Detection] Force-expired ad state for tab ${tabId} (exceeded ${MAX_AD_DURATION_MS}ms)`);
      if (autoMutedTabs.has(tabId)) {
        chrome.tabs.update(tabId, { muted: false }).then(() => {
          console.log(`[Auto-Mute] Unmuted tab ${tabId} (max duration exceeded)`);
        }).catch((error) => {
          console.error(`[Auto-Mute] Failed to unmute tab ${tabId}:`, error);
        });
        autoMutedTabs.delete(tabId);
      }
      userOverrideTabs.delete(tabId);
      continue;
    }

    if (state.phase === 'pending') {
      // Clean up pending entries whose burst window has emptied (no recent signals)
      state.recentSignals = state.recentSignals.filter(
        s => now - s.timestamp <= BURST_WINDOW_MS
      );
      if (state.recentSignals.length === 0) {
        adState.delete(tabId);
        console.log(`[Ad Detection] Pending state expired for tab ${tabId} (no burst detected)`);
      }
      continue;
    }

    if (state.phase === 'confirmed') {
      const silenceDuration = now - state.lastSignal;
      if (silenceDuration >= AD_SIGNAL_TTL_MS) {
        state.phase = 'grace';
        state.graceStartTime = now;
        console.log(
          `[Ad Detection] Tab ${tabId} entering grace phase (${now - state.firstSignal}ms since first signal)`
        );
      }
      continue;
    }

    if (state.phase === 'grace') {
      const graceDuration = now - state.graceStartTime;
      if (graceDuration >= UNMUTE_GRACE_MS) {
        adState.delete(tabId);
        console.log(`[Ad Detection] Ad state expired for tab ${tabId} after grace period`);

        if (autoMutedTabs.has(tabId)) {
          chrome.tabs.update(tabId, { muted: false }).then(() => {
            console.log(`[Auto-Mute] Unmuted tab ${tabId} (grace period elapsed)`);
          }).catch((error) => {
            console.error(`[Auto-Mute] Failed to unmute tab ${tabId}:`, error);
          });
          autoMutedTabs.delete(tabId);
        }
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

    // Check the request URL against tiered patterns and URL regex
    let weight = getPatternWeight(details.url);
    if (weight === 0) {
      weight = getUrlWeight(details.url);
    }

    // Check POST body if URL didn't yield a strong (tier-1) match
    if (weight < 10 && details.method === 'POST' && details.requestBody) {
      // Check raw bytes (e.g., JSON payloads)
      if (details.requestBody.raw && details.requestBody.raw.length > 0) {
        try {
          const decoder = new TextDecoder('utf-8');
          for (const element of details.requestBody.raw) {
            if (element.bytes) {
              const bodyText = decoder.decode(element.bytes);
              const bodyWeight = getPatternWeight(bodyText);
              if (bodyWeight > weight) {
                weight = bodyWeight;
                if (weight >= 10) break;
              }
            }
          }
        } catch (e) {
          // Decoding failed -- skip body check
        }
      }

      // Check form data values
      if (weight < 10 && details.requestBody.formData) {
        for (const key of Object.keys(details.requestBody.formData)) {
          const values = details.requestBody.formData[key];
          // Check the key itself
          const keyWeight = getPatternWeight(key);
          if (keyWeight > weight) weight = keyWeight;
          // Check each value
          if (weight < 10 && Array.isArray(values)) {
            for (const val of values) {
              const valWeight = getPatternWeight(String(val));
              if (valWeight > weight) weight = valWeight;
              if (weight >= 10) break;
            }
          }
          if (weight >= 10) break;
        }
      }
    }

    if (weight > 0) {
      recordAdSignal(details.tabId, weight);
    }

    // Piggyback expiry checks on network activity — streaming pages make constant
    // requests (video segments, analytics), so this runs frequently and eliminates
    // the ~30s alarm latency for unmuting. The alarm remains as a safety-net fallback.
    if (adState.size > 0) {
      checkAdStateExpiry();
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
        const w = getPatternWeight(header.value);
        if (w > 0) {
          recordAdSignal(details.tabId, w);
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
    let w = getPatternWeight(details.url);
    if (w === 0) w = getUrlWeight(details.url);
    if (w > 0) {
      recordAdSignal(details.tabId, w);
      return;
    }

    // Check P3P response header for ad-tech patterns
    if (details.responseHeaders) {
      for (const header of details.responseHeaders) {
        if (header.name.toLowerCase() === 'p3p' && header.value) {
          const pw = getPatternWeight(header.value);
          if (pw > 0) {
            recordAdSignal(details.tabId, pw);
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
  // This alarm is a safety-net fallback; the primary expiry path piggybacks
  // on webRequest events which fire frequently on streaming pages.
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

  // Reset ad detection state on navigation to prevent stale weight accumulation
  // across page changes (e.g., SPA navigation between videos)
  if (changeInfo.url && adState.has(tabId)) {
    adState.delete(tabId);
    console.log(`[Ad Detection] URL changed for tab ${tabId}, resetting ad state`);
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
        adDetected: adState.has(tab.id) && adState.get(tab.id).phase !== 'pending',
        autoMuted: autoMutedTabs.has(tab.id)
      }));
      sendResponse({ tabs });
    }).catch((error) => {
      console.error('Error rescanning for getAudioTabs:', error);
      // Fall back to whatever we have in memory
      const tabs = Array.from(audioTabs.values()).map(tab => ({
        ...tab,
        adDetected: adState.has(tab.id) && adState.get(tab.id).phase !== 'pending',
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
