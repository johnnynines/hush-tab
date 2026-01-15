# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hush Tab is a cross-browser extension (Firefox/Chrome) that detects and manages tabs playing audio with intelligent YouTube ad detection and auto-muting capabilities. The extension uses Manifest V3 for modern browser compatibility.

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

**Content Script (YouTube):**
- Open YouTube page → F12 → Console → Look for `[Hush Tab]` logs

**Popup:**
- Right-click extension icon → "Inspect popup"

## Architecture

### Component Interaction Flow

```
YouTube Page (content-youtube.js)
    ↓ chrome.runtime.sendMessage()
Background Script (background.js)
    ↓ chrome.tabs.update()
Tab Mute/Unmute
    ↓ chrome.tabs.onUpdated
Popup UI (popup.js/popup.html)
```

### 1. Background Service Worker (`background.js`)

**Core Responsibilities:**
- Maintains `audioTabs` Map tracking all tabs with audio (both audible and muted)
- Maintains `autoMutedTabs` Set to track which tabs were auto-muted (critical for knowing when to auto-unmute)
- Listens to `chrome.tabs.onUpdated` for `audible` and `mutedInfo` changes
- Updates badge counter showing number of tabs with audio
- Handles messages from content scripts and popup
- Executes auto-mute/unmute logic based on ad state from content scripts

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
- Detects ad state using multiple detection methods
- Sends real-time ad state changes to background script
- Handles YouTube's SPA navigation (URL changes without page reload)

**Ad Detection Strategy (Multi-layered):**
1. DOM element detection: `.ytp-ad-player-overlay`, `.ytp-ad-skip-button`, `.ytp-ad-text`
2. Player class monitoring: `.ad-showing`, `.ad-interrupting`
3. Video ads module: `.video-ads.ytp-ad-module`
4. MutationObserver for immediate detection of DOM changes
5. Polling fallback every 500ms for edge cases

**Why Multiple Methods:**
YouTube's DOM structure can vary and change over time. Using multiple detection methods ensures high accuracy and resilience to YouTube updates.

### 3. Popup Interface (`popup.html`, `popup.js`, `popup.css`)

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

### 4. Manifest Configuration (`manifest.json`)

**Critical Permissions:**
- `tabs`: Required to access audio state, title, URL
- `storage`: Persists auto-mute preference via `chrome.storage.sync`
- `scripting`: Enables content script injection
- `host_permissions`: `*://*.youtube.com/*` for ad detection

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

YouTube is a Single Page Application that changes URLs without full page reloads. The content script handles this by:

```javascript
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    isAdPlaying = false; // Reset state
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
3. Add to `isYouTubeAdPlaying()` in `content-youtube.js`
4. Test with both pre-roll and mid-roll ads
5. Verify MutationObserver catches the new elements

### Extending to Other Platforms (e.g., Twitch, Spotify)

1. Create new content script file (e.g., `content-twitch.js`)
2. Add to `manifest.json` content_scripts with appropriate URL matches
3. Implement platform-specific ad detection
4. Send same `adStateChanged` message format to background script
5. Background script logic works universally (no changes needed)

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

1. Audio detection: Open tabs with YouTube, Spotify, etc. Badge updates correctly
2. Mute controls: Popup buttons mute/unmute tabs correctly
3. Tab switching: Clicking tab info switches to correct tab
4. YouTube ad detection:
   - Toggle auto-mute ON
   - Play video with ads
   - Verify auto-mute when ad starts
   - Verify auto-unmute when content resumes
   - Toggle OFF and verify no auto-mute
5. Manual vs auto-mute: Manually mute a tab, verify it doesn't auto-unmute
6. Multiple tabs: Play audio in several tabs, verify all tracked correctly
7. YouTube navigation: Navigate between videos, verify state resets properly

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
