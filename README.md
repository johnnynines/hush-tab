# Hush Tab - Smart Audio Tab Manager

A cross-browser extension for Firefox and Chrome that detects and manages tabs playing audio. Features intelligent YouTube ad detection that automatically mutes commercials while keeping your content playing.

## Features

🔊 **Real-time Audio Detection** - Automatically detects when tabs start or stop playing audio  
🎯 **Visual Badge Counter** - Shows the number of tabs playing audio on the extension icon  
🤖 **Smart YouTube Ad Muting** - Automatically mutes YouTube ads and unmutes when content resumes  
🔇 **Quick Mute/Unmute** - Control audio for each tab individually  
👁️ **Instant Tab Switching** - Click to jump directly to any tab playing audio  
⚙️ **Configurable Settings** - Toggle auto-mute on/off with one click  
⚡ **Lightweight & Fast** - Minimal resource usage with efficient background monitoring  
🌐 **Cross-Browser Compatible** - Works on both Firefox and Chrome (Manifest V3)

## Installation

### Chrome / Edge / Brave

1. Open your browser and navigate to:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
   - Brave: `brave://extensions/`

2. Enable **Developer mode** (toggle in the top-right corner)

3. Click **Load unpacked**

4. Select the `mute_ads` folder containing this extension

5. The extension icon should appear in your toolbar

### Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`

2. Click **Load Temporary Add-on...**

3. Navigate to the `mute_ads` folder and select the `manifest.json` file

4. The extension will be loaded temporarily (until you restart Firefox)

**Note for Firefox:** For permanent installation, you'll need to sign the extension through [addons.mozilla.org](https://addons.mozilla.org/).

## How It Works

### Architecture

The extension consists of four main components:

1. **Background Service Worker** (`background.js`)
   - Monitors all tabs using the `chrome.tabs` API
   - Tracks audio state changes via the `audible` property
   - Maintains a map of currently playing tabs
   - Coordinates auto-mute actions based on ad detection
   - Updates the badge counter in real-time

2. **YouTube Content Script** (`content-youtube.js`) 🆕
   - Injects into YouTube pages to detect ads
   - Uses multiple detection methods (DOM monitoring, MutationObserver)
   - Identifies ad elements: `.ytp-ad-player-overlay`, skip buttons, ad indicators
   - Sends real-time ad state changes to background script
   - Works across YouTube's SPA navigation

3. **Popup Interface** (`popup.html` + `popup.js`)
   - Displays all tabs currently playing audio
   - Provides mute/unmute controls
   - Allows quick switching between tabs
   - Toggle for enabling/disabling auto-mute feature
   - Updates dynamically when tab states change

4. **Manifest Configuration** (`manifest.json`)
   - Declares required permissions (`tabs`, `storage`, `scripting`)
   - Configures content script injection for YouTube
   - Defines cross-browser compatibility
   - Sets up host permissions for YouTube access

### Key APIs Used

- **`chrome.tabs.onUpdated`** - Listens for changes in tab state (including audio)
- **`chrome.tabs.query()`** - Retrieves information about all tabs
- **`tab.audible`** - Boolean property indicating if a tab is playing audio
- **`chrome.tabs.update()`** - Controls tab state (mute/unmute, focus)
- **`chrome.action.setBadgeText()`** - Updates the extension icon badge
- **`chrome.storage.sync`** - Stores user preferences (auto-mute setting)
- **`MutationObserver`** - Monitors YouTube DOM for ad-related changes
- **`chrome.runtime.onMessage`** - Communication between content scripts and background

### YouTube Ad Detection

The extension uses multiple detection strategies for high accuracy:

1. **DOM Element Detection** - Looks for ad-specific elements:
   - `.ytp-ad-player-overlay` - Ad overlay container
   - `.ytp-ad-skip-button` - Skip ad button
   - `.ytp-ad-text` - Ad text indicator
   - `.ad-showing` - Player class during ads

2. **MutationObserver** - Real-time monitoring:
   - Watches for ad element insertion/removal
   - Detects class changes on video player
   - Immediate response to ad state changes

3. **Polling Fallback** - Checks every 500ms:
   - Ensures no ads are missed
   - Handles edge cases where observers don't fire

**Auto-Mute Behavior:**
- When ad detected → Tab muted automatically
- When content resumes → Tab unmuted (only if we muted it)
- Respects manual user muting (won't auto-unmute)
- Can be toggled on/off in popup

## Development

### Project Structure

```
mute_ads/
├── manifest.json          # Extension configuration
├── background.js          # Background service worker
├── content-youtube.js     # YouTube ad detection script 🆕
├── popup.html            # Popup UI structure
├── popup.js              # Popup logic
├── popup.css             # Popup styling
├── icons/                # Extension icons (16, 32, 48, 128px)
│   └── icon-placeholder.txt
├── LICENSE               # GNU GPLv3
└── README.md             # This file
```

### Adding Icons

The extension currently references icon files that need to be created. You should add PNG icons in the following sizes:

- `icons/icon16.png` - 16x16 pixels
- `icons/icon32.png` - 32x32 pixels
- `icons/icon48.png` - 48x48 pixels
- `icons/icon128.png` - 128x128 pixels

You can create these using any image editor or icon generator. Recommended tools:
- [Figma](https://www.figma.com/)
- [GIMP](https://www.gimp.org/)
- [Icon Kitchen](https://icon.kitchen/)

### Testing

1. **Test Audio Detection:**
   - Open tabs with YouTube, Spotify, or any site with audio
   - Play audio and verify the extension badge updates
   - Check that the tab appears in the popup

2. **Test YouTube Ad Auto-Mute:** 🆕
   - Open a YouTube video with ads
   - Ensure auto-mute toggle is ON in popup
   - Play the video and wait for an ad
   - Verify tab mutes automatically when ad starts
   - Verify tab unmutes when content resumes
   - Test with toggle OFF - should not auto-mute

3. **Test Mute Controls:**
   - Click the mute button in the popup
   - Verify audio stops and the icon changes
   - Test unmuting

4. **Test Tab Switching:**
   - Click the focus button or tab info
   - Verify you're switched to the correct tab

5. **Test Multiple Tabs:**
   - Play audio in several tabs simultaneously
   - Verify all appear in the list
   - Test controlling each independently

### Debugging

**Chrome DevTools:**
- Background script: Go to `chrome://extensions/` → Find your extension → Click "service worker"
- Popup: Right-click the extension icon → Inspect popup
- Content script: Open YouTube → F12 → Console → Look for `[Hush Tab]` logs

**Firefox DevTools:**
- Go to `about:debugging#/runtime/this-firefox`
- Click "Inspect" on your extension
- Use the console to view background script logs
- Content script logs appear in page console

### Common Issues

**Badge not updating:**
- Check browser console for errors
- Verify the `tabs` permission is granted
- Try reloading the extension

**Tabs not detected:**
- Some tabs may not report audio correctly (browser limitation)
- Ensure the tab actually has audio elements playing
- Check if the site is using Web Audio API vs HTML5 audio

**Firefox compatibility:**
- Manifest V3 requires Firefox 109+
- Some APIs may have slight differences from Chrome

**YouTube ad detection not working:**
- Check console for `[Hush Tab]` messages
- Verify content script is injecting (check Sources tab in DevTools)
- YouTube may update their DOM - ad selectors may need updating
- Try disabling/re-enabling the extension

## Future Enhancement Ideas

Here are some ways you could extend this extension:

1. ✅ **Auto-mute YouTube ads** - IMPLEMENTED!
2. **More platforms** - Add ad detection for Hulu, Twitch, Spotify
3. **Audio analysis** - Use Web Audio API for non-YouTube ad detection
4. **Whitelist/blacklist** - Allow audio from specific domains only
5. **Keyboard shortcuts** - Add hotkeys for muting/unmuting
6. **Audio visualization** - Show volume levels or waveforms
7. **History tracking** - Keep a log of which tabs played audio
8. **Smart notifications** - Alert when audio starts in background tabs
9. **Bulk controls** - Mute/unmute all tabs at once
10. **Machine learning** - Train models to detect ads by audio patterns

## Browser Compatibility

| Feature | Chrome | Firefox | Edge | Brave |
|---------|--------|---------|------|-------|
| Audio detection | ✅ | ✅ | ✅ | ✅ |
| Badge counter | ✅ | ✅ | ✅ | ✅ |
| Mute/unmute | ✅ | ✅ | ✅ | ✅ |
| Tab switching | ✅ | ✅ | ✅ | ✅ |
| YouTube ad muting | ✅ | ✅ | ✅ | ✅ |

**Minimum versions:**
- Chrome 88+
- Firefox 109+
- Edge 88+
- Brave (any recent version)

## Permissions Explained

- **`tabs`** - Required to access tab information including audio state, title, and URL
- **`storage`** - Stores user preferences (auto-mute setting)
- **`scripting`** - Required for content script injection
- **`host_permissions`** - Access to YouTube.com for ad detection

## Contributing

Feel free to enhance this extension! Some areas for improvement:

- Add proper icon files
- Implement keyboard shortcuts
- Add settings/options page
- Improve error handling
- Add internationalization (i18n)
- Create automated tests

## License

This is a development project. Add your preferred license here.

## Resources

- [Chrome Extensions Documentation](https://developer.chrome.com/docs/extensions/)
- [Firefox Extensions Documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)
- [WebExtensions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/mv3/intro/)

---

**Happy coding!** 🚀
