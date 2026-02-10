# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hush Tab is a cross-browser extension (Firefox/Chrome) that detects and manages tabs playing audio with intelligent ad detection and auto-muting capabilities for multiple streaming platforms. The extension uses Manifest V3 for modern browser compatibility.

**Supported Platforms:**
- YouTube (`youtube.com`)
- Hulu (`hulu.com`)
- ESPN (`espn.com`, `plus.espn.com`, `watch.espn.com`)

## Development Commands

### Loading the Extension

**Chrome/Edge/Brave:**
```bash
# Navigate to chrome://extensions/ (or edge://extensions/, brave://extensions/)
# Enable "Developer mode" toggle (top-right)
# Click "Load unpacked" and select this directory
```

**Firefox:**
```bash
# Navigate to about:debugging#/runtime/this-firefox
# Click "Load Temporary Add-on..."
# Select manifest.json from this directory

# For auto-reload during development:
npm install --global web-ext
web-ext run
```

### Debugging

**Background Script (Service Worker):**
- Chrome: `chrome://extensions/` → Find extension → Click "service worker"
- Firefox: `about:debugging#/runtime/this-firefox` → Click "Inspect"

**Content Scripts (YouTube, Hulu, ESPN):**
- Open any supported streaming page → F12 → Console → Look for `[Hush Tab]` logs
- Each platform shows confidence scores: `[Hush Tab] Confidence: XX | Signals: ...`

**Popup:**
- Right-click extension icon → "Inspect popup"

## Architecture

### Component Interaction Flow

```
Streaming Page (content-youtube.js / content-hulu.js / content-espn.js)
    ↓ chrome.runtime.sendMessage({action: 'adStateChanged'})
Background Script (background.js)
    ↓ chrome.tabs.update({muted: true/false})
Tab Mute/Unmute
    ↓ chrome.tabs.onUpdated (audible flicker detection)
    ↓ chrome.tabs.sendMessage({action: 'audibleStateChanged'})
Content Scripts (additional confidence signal)
    ↓
Popup UI (popup.js/popup.html)
```

### 1. Background Service Worker (`background.js`)

**Core Responsibilities:**
- Maintains `audioTabs` Map tracking all tabs with audio (both audible and muted)
- Maintains `autoMutedTabs` Set to track which tabs were auto-muted (critical for knowing when to auto-unmute)
- Maintains `audibleStateHistory` Map for detecting audio state "flickers" (potential ad transitions)
- Listens to `chrome.tabs.onUpdated` for `audible` and `mutedInfo` changes
- Updates badge counter showing number of tabs with audio
- Handles messages from content scripts and popup
- Executes auto-mute/unmute logic based on ad state from content scripts
- Notifies content scripts when audible flicker patterns are detected

**Key State Management:**
- A tab is considered to "have audio" if `tab.audible === true` OR `tab.mutedInfo.muted === true`
- This distinction is important: muted tabs still have active audio, just silenced
- Auto-mute only unmutes tabs it previously muted (tracked in `autoMutedTabs`)

**Message Handlers:**
- `getAudioTabs`: Returns array of tabs with audio
- `muteTab`/`unmuteTab`: Manual mute control from popup
- `focusTab`: Switch to tab and bring window to front
- `adStateChanged`: From content script, triggers auto-mute logic
- `getAutoMuteSettings`/`setAutoMuteSettings`: Manages user preferences

### 2. YouTube Content Script (`content-youtube.js`)

**Core Responsibilities:**
- Injects into all YouTube pages (`*://*.youtube.com/*`)
- Detects ad state using confidence-based scoring with multiple signals
- Sends real-time ad state changes to background script
- Handles YouTube's SPA navigation (URL changes without page reload)
- Implements hysteresis logic to prevent rapid mute/unmute cycling

**Confidence-Based Ad Detection:**

Instead of boolean detection, the script calculates a confidence score (0-100) by combining multiple weighted signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| `.ad-showing` class | 40 | Player class during ads (most reliable) |
| `.ad-interrupting` class | 40 | Player class for interrupting ads |
| `.ytp-ad-module` has children | 35 | Primary ad container check |
| `.ytp-ad-player-overlay` | 30 | Ad overlay present |
| `.ytp-ad-preview-text` | 25 | Shows "Ad will end in X" |
| Ad counter text | 25 | "Ad 1 of 2" pattern detected |
| `.ytp-ad-badge` | 25 | Ad badge/label visible |
| `.ytp-ad-message-container` | 20 | Ad messaging visible |
| `.ytp-ad-overlay-container` | 20 | Overlay container present |
| Instream info | 20 | Ad info in player overlay |
| `.ytp-ad-text` | 15 | Generic ad text element |
| Skip button | 15 | Lower weight (appears late) |
| Video time anomaly | 15 | currentTime not advancing |
| Audible flicker | 10 | Audio state changes detected |

**Hysteresis Logic:**
- Mute when confidence >= 50
- Unmute only when confidence < 20 for 2+ seconds
- This prevents rapid mute/unmute flapping during transitions

**Why Confidence Scoring:**
- More resilient to YouTube DOM changes (multiple weak signals > one strong signal)
- Reduces false positives and negatives
- Skip button has low weight since it appears late or not at all
- Allows easy tuning of detection sensitivity

### 3. Hulu Content Script (`content-hulu.js`)

**Core Responsibilities:**
- Injects into all Hulu pages (`*://*.hulu.com/*`)
- Uses same confidence-based scoring system as YouTube
- Handles Hulu's SPA navigation

**Hulu-Specific Detection Signals:**

| Signal | Weight | Description |
|--------|--------|-------------|
| Ad countdown text | 45 | "Your video will resume" or countdown |
| Ad break marker | 40 | `.controls__ad-break` on progress bar |
| Player ad state | 40 | Player class indicates ad mode |
| Ad overlay visible | 35 | Ad overlay/container present |
| Ad badge text | 30 | "Ad" or "Advertisement" label |
| Video time frozen | 20 | currentTime not advancing |
| Controls disabled | 15 | Seek bar disabled during ad |
| Audible flicker | 10 | Audio state changes detected |

### 4. ESPN Content Script (`content-espn.js`)

**Core Responsibilities:**
- Injects into ESPN pages (`*://*.espn.com/*`, `*://plus.espn.com/*`, `*://watch.espn.com/*`)
- Uses same confidence-based scoring system
- Includes IMA SDK detection (Google Interactive Media Ads)

**ESPN-Specific Detection Signals:**

| Signal | Weight | Description |
|--------|--------|-------------|
| ESPN API ad state | 45 | Legacy `espn.video.player.adPlaying` |
| Ad overlay visible | 40 | Ad container/overlay present |
| Ad countdown text | 40 | "Ad X of Y" or countdown text |
| Ad break indicator | 35 | Ad break marker in UI |
| IMA SDK container | 35 | Google IMA ad elements |
| Ad badge visible | 30 | "Ad" or "Commercial" badge |
| Video time frozen | 20 | currentTime not advancing |
| Seek disabled | 20 | Seek bar disabled during ad |
| Audible flicker | 10 | Audio state changes detected |

### 5. NBC Content Script (`content-nbc.js`)

**Core Responsibilities:**
- Injects into NBC pages (`*://*.nbc.com/*`, `*://*.nbcuni.com/*`)
- Uses confidence-based scoring with emphasis on network and control visibility signals
- Handles NBC's unique ad delivery via AWS MediaTailor

**NBC-Specific Detection Signals (Updated with Diagnostic Data):**

| Signal | Weight | Description |
|--------|--------|-------------|
| Network ad detected | 45 | AWS MediaTailor + Adobe Analytics activity (strongest signal) |
| Player controls hidden | 35 | Back-10 and back-to-live buttons removed during ads |
| Progress bar hidden | 30 | `.player-controls__progress-wrapper--hidden` class added |
| Back-to-live hidden | 25 | `.player-controls__back-to-live__wrapper` not visible |
| Short video duration | 40 | Video duration is ad-length (5-120 seconds) |
| Ad playing state | 45 | Player reports ad playing |
| Ad overlay visible | 40 | Ad container/overlay present |
| Ad countdown text | 40 | Countdown or "Ad" text visible |
| Ad break indicator | 35 | Ad break indicator in UI |
| Ad badge visible | 30 | "Ad" or "Commercial" badge |
| Video time frozen | 20 | currentTime not advancing |
| Seek disabled | 20 | Seek bar disabled during ad |
| Audible flicker | 10 | Audio state changes detected |

**NBC Detection Strategy:**
NBC presents unique challenges as ads don't appear as separate short-duration videos. The platform uses:
- **AWS MediaTailor** for server-side ad insertion (`mediatailor.us-east-1.amazonaws.com`)
- **Adobe Analytics** for tracking (`nbcume.hb.omtrdc.net`, `omtrdc.net`)
- **Player control visibility changes** - controls are hidden/disabled during ads

The confidence threshold is set to 50 (vs 60 for other platforms) since fewer DOM signals are available. Network activity combined with control visibility provides reliable ad detection.

### 5. Popup Interface (`popup.html`, `popup.js`, `popup.css`)

**Core Responsibilities:**
- Displays all tabs currently playing audio (both muted and unmuted)
- Visual distinction: muted tabs show 🔇, unmuted show 🔊
- Per-tab mute/unmute controls
- Quick tab switching (click to focus)
- Auto-mute toggle switch with persistent storage

**UI State:**
- Dynamically updates when tabs start/stop playing audio
- Shows "No tabs playing audio" when list is empty
- Reflects real-time mute state changes

### 6. Manifest Configuration (`manifest.json`)

**Critical Permissions:**
- `tabs`: Required to access audio state, title, URL
- `storage`: Persists auto-mute preference via `chrome.storage.sync`
- `scripting`: Enables content script injection
- `host_permissions`: YouTube, Hulu, and ESPN domains for ad detection

**Browser-Specific Settings:**
- `browser_specific_settings.gecko`: Firefox compatibility (min version 109.0)
- `service_worker`: Manifest V3 background script

## Key Implementation Details

### Auto-Mute Logic (Critical)

**In `background.js:handleAdStateChange()`:**

When ad detected (`isAd === true`):
1. Check if auto-mute is enabled in storage
2. If tab is not already muted, mute it
3. Add tab ID to `autoMutedTabs` Set (this is crucial!)

When content resumes (`isAd === false`):
1. Check if tab ID exists in `autoMutedTabs`
2. If yes: unmute and remove from `autoMutedTabs`
3. If no: do nothing (user may have manually muted, respect their choice)

**Why This Matters:**
The `autoMutedTabs` Set prevents unmuting tabs that the user manually muted. Without this tracking, the extension would inappropriately unmute user-controlled tabs.

### YouTube SPA Navigation Handling

YouTube is a Single Page Application that changes URLs without full page reloads. The content script handles this by resetting all detection state:

```javascript
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    // Reset all state on navigation
    currentAdState = false;
    lowConfidenceStartTime = null;
    lastVideoTime = 0;
    videoTimeStalled = false;
    recentAudibleFlicker = false;
    checkForAds();
  }
}).observe(document, { subtree: true, childList: true });
```

### Message Passing Pattern

All async message handlers must `return true` to keep the message channel open:

```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'example') {
    doAsyncWork().then(() => {
      sendResponse({ success: true });
    });
    return true; // REQUIRED for async sendResponse
  }
});
```

## Common Development Scenarios

### Adding New Ad Detection Selectors

If YouTube updates their DOM and ads aren't detected:

1. Open YouTube with DevTools (F12)
2. Inspect ad elements to find new selectors
3. Add a new weight in the `WEIGHTS` object in `content-youtube.js`
4. Add the detection logic in `getAdConfidence()` function
5. Add the selector to the MutationObserver in `observeDOMChanges()` if needed
6. Test with both pre-roll and mid-roll ads
7. Tune the weight based on reliability (higher = more reliable signal)

**Confidence Tuning Tips:**
- High-reliability signals (player classes): 35-40 weight
- Medium-reliability signals (ad containers): 20-30 weight
- Low-reliability signals (may have false positives): 10-15 weight
- Adjust `CONFIG.MUTE_THRESHOLD` (default: 50) if too sensitive/insensitive
- Adjust `CONFIG.UNMUTE_THRESHOLD` (default: 20) and `CONFIG.UNMUTE_DELAY_MS` (default: 2000) for unmute behavior

### Extending to Other Platforms (e.g., Twitch, Spotify)

See `content-hulu.js` and `content-espn.js` for examples. Steps:

1. Create new content script file (e.g., `content-twitch.js`)
2. Copy the confidence-based detection structure from an existing script
3. Research platform-specific ad selectors using DevTools
4. Implement `getAdConfidence()` with platform-specific signals
5. Add to `manifest.json`:
   - `host_permissions`: Add the domain pattern
   - `content_scripts`: Add new entry with matches and js file
6. Update `background.js` `isSupportedSite` check for audible flicker detection
7. Send same `adStateChanged` message format to background script
8. Test with actual ads on the platform

### Adding Keyboard Shortcuts

1. Add `commands` permission to `manifest.json`
2. Define commands in manifest
3. Listen to `chrome.commands.onCommand` in background script
4. Execute mute/unmute actions

## Browser Compatibility Notes

**Firefox vs Chrome Differences:**
- Firefox uses `browser.*` API (Promise-based)
- Chrome uses `chrome.*` API (callback-based, now also supports Promises)
- This codebase uses `chrome.*` which works in both browsers
- Firefox requires `browser_specific_settings` in manifest

**Manifest V3 Requirements:**
- Chrome 88+
- Firefox 109+
- Service workers instead of background pages
- `host_permissions` separate from `permissions`

## Testing Checklist

When making changes, verify:

1. Audio detection: Open tabs with YouTube, Hulu, ESPN, etc. Badge updates correctly
2. Mute controls: Popup buttons mute/unmute tabs correctly
3. Tab switching: Clicking tab info switches to correct tab
4. **YouTube ad detection:**
   - Toggle auto-mute ON
   - Play video with ads
   - Verify auto-mute when ad starts (check console for confidence score)
   - Verify auto-unmute when content resumes (after 2 second delay)
   - Toggle OFF and verify no auto-mute
5. **Hulu ad detection:**
   - Play content with ad breaks
   - Verify muting during "Your video will resume" messages
   - Check for `[Hush Tab] Hulu Confidence:` logs in console
6. **ESPN ad detection:**
   - Play ESPN+ or watch.espn.com content
   - Verify muting during commercial breaks
   - Check for `[Hush Tab] ESPN Confidence:` logs in console
7. Manual vs auto-mute: Manually mute a tab, verify it doesn't auto-unmute
8. Multiple tabs: Play audio in several tabs, verify all tracked correctly
9. Navigation: Navigate between videos on each platform, verify state resets properly
10. Confidence scoring: Open DevTools console, look for `[Hush Tab] Confidence:` logs
    - Verify multiple signals are detected during ads
    - Verify confidence drops to near 0 when content plays
11. Hysteresis: Verify no rapid mute/unmute cycling during ad transitions
12. Unskippable ads: Verify detection works even without skip button (skip button has low weight)

## Storage Structure

```javascript
chrome.storage.sync = {
  autoMuteAds: boolean  // Default: true
}
```

## Important Constraints

1. **Never auto-unmute user-muted tabs**: Always check `autoMutedTabs` Set before unmuting
2. **Handle extension context invalidation**: Content scripts must catch errors when sending messages (extension may reload)
3. **Respect user privacy**: All detection happens locally, no external network requests
4. **Minimal permissions**: Only request what's necessary for functionality
5. **Cross-browser compatibility**: Test on both Firefox and Chrome before release
