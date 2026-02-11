# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hush Tab Diagnostic is a cross-browser extension (Firefox/Chrome) in a **diagnostic-first phase**. The goal is to learn how video players and ad delivery systems work across streaming platforms before building auto-mute functionality.

**Current Phase: Diagnostics & Data Collection**

The extension provides two capabilities:
1. **Tab Audio Detection** - Identifies which browser tabs are playing audio, with manual mute/unmute controls
2. **Diagnostic Tool** - Captures console logs, network requests, DOM mutations, video events, and player state from any website to analyze ad delivery patterns

**Future Phase: Auto-Mute (not yet implemented)**

Once enough diagnostic data has been gathered across platforms, the auto-mute features will be designed based on real observed signals rather than guesswork.

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
- Chrome: `chrome://extensions/` -> Find extension -> Click "service worker"
- Firefox: `about:debugging#/runtime/this-firefox` -> Click "Inspect"

**Content Scripts (Diagnostic):**
- The diagnostic content script is injected on-demand via `chrome.scripting.executeScript`
- Open any page -> F12 -> Console -> Look for `[Hush Tab Diagnostic]` logs

**Popup:**
- Right-click extension icon -> "Inspect popup"

## Architecture

### Component Interaction Flow

```
Any Web Page
    |  (user selects tab in diagnostic panel)
    v
Diagnostic Panel (diagnostic.js / diagnostic.html)
    |  chrome.scripting.executeScript(content-diagnostic.js)
    v
Content Diagnostic Script (content-diagnostic.js)
    |  Captures: console, network, DOM, video, player state
    |  chrome.runtime.onMessage (start/stop/getData)
    v
Diagnostic Panel displays and exports captured data

Background Script (background.js)
    |  chrome.tabs.onUpdated (audible/muted changes)
    v
Popup UI (popup.js / popup.html)
    |  Shows tabs with audio, manual mute/unmute
    v
User controls
```

### 1. Background Service Worker (`background.js`)

**Core Responsibilities:**
- Maintains `audioTabs` Map tracking all tabs with audio (both audible and muted)
- Listens to `chrome.tabs.onUpdated` for `audible` and `mutedInfo` changes
- Updates badge counter showing number of tabs with audio
- Handles messages from popup for tab queries and mute control

**Key State Management:**
- A tab is considered to "have audio" if `tab.audible === true` OR `tab.mutedInfo.muted === true`
- This distinction is important: muted tabs still have active audio, just silenced

**Message Handlers:**
- `getAudioTabs`: Returns array of tabs with audio
- `muteTab`/`unmuteTab`: Manual mute control from popup
- `focusTab`: Switch to tab and bring window to front

### 2. Diagnostic Content Script (`content-diagnostic.js`)

**Core Responsibilities:**
- Injected on-demand into any web page via `chrome.scripting.executeScript`
- Captures data across five categories when recording is active
- Detects platform automatically (YouTube, Hulu, ESPN, NBC, or unknown)
- Includes platform-specific player state capture for known platforms

**Data Categories Captured:**

| Category | What It Captures |
|----------|-----------------|
| Console Logs | All console.log/warn/error/info/debug calls from the page |
| Network Requests | Resource loads via PerformanceObserver (fetch, XHR, media, scripts) |
| DOM Mutations | Class changes, attribute changes, node additions/removals on ad-related elements |
| Video Events | play, pause, seeking, ended, volumechange, etc. on `<video>` elements |
| Player State | Periodic snapshots of video state + platform-specific player properties |

**Platform-Specific State Capture:**
- **YouTube**: `.ad-showing`, `.ad-interrupting`, `.ytp-ad-module`, skip button, ad preview text
- **Hulu**: `.controls__ad-break`, ad countdown, controls disabled state
- **ESPN**: `espn.video.player.adPlaying`, IMA container, ad overlay
- **NBC**: Video.js ad state, video duration, ad overlay, IMA container, seek disabled

**Message Handlers:**
- `startDiagnostic`: Clears data, starts recording
- `stopDiagnostic`: Stops recording
- `getDiagnosticData`: Returns all captured data
- `getDiagnosticStatus`: Returns recording state and entry counts
- `markAdStart`/`markAdEnd`: User-annotated ad transition markers

### 3. Diagnostic Panel (`diagnostic.html`, `diagnostic.js`, `diagnostic.css`)

**Core Responsibilities:**
- Full-page UI for controlling diagnostic recording sessions
- Tab selector showing all browsable tabs (http/https)
- Start/stop recording controls
- Manual "Ad Started" / "Ad Ended" marker buttons for correlating signals with actual ad events
- Real-time stats display (entry counts per category)
- Tabbed data viewer: Console, Network, DOM, Video, Player, Summary
- Export to JSON and copy summary to clipboard
- Analysis summary that identifies ad-related patterns in captured data

### 4. Popup Interface (`popup.html`, `popup.js`, `popup.css`)

**Core Responsibilities:**
- Displays all tabs currently playing audio (both muted and unmuted)
- Per-tab mute/unmute controls
- Quick tab switching (click to focus)
- Link to open the Diagnostic Tool

### 5. Manifest Configuration (`manifest.json`)

**Permissions:**
- `tabs`: Required to access audio state, title, URL
- `storage`: For future settings persistence
- `scripting`: Enables diagnostic content script injection
- `activeTab`: Temporary access to the active tab
- `host_permissions: <all_urls>`: Allows diagnostic injection into any website

**Browser-Specific Settings:**
- `browser_specific_settings.gecko`: Firefox compatibility (min version 109.0)
- `service_worker`: Manifest V3 background script

## File Structure

```
mute_ads/
  background.js          - Service worker: tab audio detection, popup messaging
  manifest.json          - Extension manifest (Manifest V3)
  popup.html             - Popup UI markup
  popup.js               - Popup logic: tab list, mute controls
  popup.css              - Popup styles
  content-diagnostic.js  - Diagnostic content script (injected on-demand)
  diagnostic.html        - Diagnostic panel markup
  diagnostic.js          - Diagnostic panel logic: recording, display, export
  diagnostic.css         - Diagnostic panel styles
  icons/                 - Extension icons (16, 32, 48, 128px)
  diagnostic/            - Saved diagnostic data exports
```

## How to Use the Diagnostic Tool

1. Load the extension in your browser
2. Click the extension icon -> "Diagnostic Tool" link (opens in a new tab)
3. Select any tab from the dropdown (shows all http/https tabs)
4. Click "Start Recording" to begin capturing data
5. On the target tab, trigger an ad (e.g., play a video with ads)
6. Click "Ad Started" when you see an ad begin, "Ad Ended" when it finishes
7. Stop recording and review the captured data:
   - **Console tab**: Look for ad-related log messages
   - **Network tab**: Filter for ad-related requests (doubleclick, IMA, etc.)
   - **DOM tab**: Watch for class changes on player elements during ads
   - **Video tab**: See video events and user markers correlated by timestamp
   - **Player tab**: Platform-specific player state snapshots
   - **Summary tab**: Auto-analyzed patterns and signals
8. Export as JSON for offline analysis

## Message Passing Pattern

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

1. **Audio detection**: Open tabs with any audio-playing site. Badge updates correctly
2. **Mute controls**: Popup buttons mute/unmute tabs correctly
3. **Tab switching**: Clicking tab info in popup switches to correct tab
4. **Diagnostic tab selector**: All http/https tabs appear in dropdown
5. **Diagnostic recording**: Start/stop recording works, stats update in real-time
6. **Diagnostic data capture**: Console, network, DOM, video, and player data all populate
7. **Ad markers**: "Ad Started" / "Ad Ended" buttons create entries in video events
8. **Export**: JSON export downloads valid file with all captured data
9. **Summary**: Analysis summary identifies ad-related patterns after recording
10. **Multiple tabs**: Play audio in several tabs, verify all tracked correctly

## Important Constraints

1. **Handle extension context invalidation**: Content scripts must catch errors when sending messages (extension may reload)
2. **Respect user privacy**: All detection happens locally, no external network requests
3. **Minimal permissions**: Only request what's necessary for functionality
4. **Cross-browser compatibility**: Test on both Firefox and Chrome before release
5. **Diagnostic data stays local**: All captured data is only stored in-memory and exported manually by the user

## Roadmap

### Phase 1: Diagnostics (current)
- Capture and analyze ad delivery patterns across streaming platforms
- Identify reliable, platform-agnostic signals for ad detection
- Collect data from: YouTube, Hulu, ESPN, NBC, and any new platforms

### Phase 2: Auto-Mute (future)
- Design confidence-based ad detection using signals discovered in Phase 1
- Implement per-platform content scripts with weighted signal scoring
- Add auto-mute toggle to popup UI
- Implement hysteresis logic to prevent rapid mute/unmute cycling
- Track auto-muted tabs separately from user-muted tabs
