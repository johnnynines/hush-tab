# Audio Tab Detector Browser Extension

A cross-browser extension for Firefox and Chrome that detects and manages tabs playing audio. This extension provides real-time monitoring of audio playback across all your tabs with an intuitive interface to control them.

## Features

🔊 **Real-time Audio Detection** - Automatically detects when tabs start or stop playing audio  
🎯 **Visual Badge Counter** - Shows the number of tabs playing audio on the extension icon  
🔇 **Quick Mute/Unmute** - Control audio for each tab individually  
👁️ **Instant Tab Switching** - Click to jump directly to any tab playing audio  
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

The extension consists of three main components:

1. **Background Service Worker** (`background.js`)
   - Monitors all tabs using the `chrome.tabs` API
   - Tracks audio state changes via the `audible` property
   - Maintains a map of currently playing tabs
   - Updates the badge counter in real-time

2. **Popup Interface** (`popup.html` + `popup.js`)
   - Displays all tabs currently playing audio
   - Provides mute/unmute controls
   - Allows quick switching between tabs
   - Updates dynamically when tab states change

3. **Manifest Configuration** (`manifest.json`)
   - Declares required permissions (`tabs`, `storage`)
   - Configures cross-browser compatibility
   - Defines the extension metadata

### Key APIs Used

- **`chrome.tabs.onUpdated`** - Listens for changes in tab state (including audio)
- **`chrome.tabs.query()`** - Retrieves information about all tabs
- **`tab.audible`** - Boolean property indicating if a tab is playing audio
- **`chrome.tabs.update()`** - Controls tab state (mute/unmute, focus)
- **`chrome.action.setBadgeText()`** - Updates the extension icon badge

## Development

### Project Structure

```
mute_ads/
├── manifest.json          # Extension configuration
├── background.js          # Background service worker
├── popup.html            # Popup UI structure
├── popup.js              # Popup logic
├── popup.css             # Popup styling
├── icons/                # Extension icons (16, 32, 48, 128px)
│   └── icon-placeholder.txt
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

2. **Test Mute Controls:**
   - Click the mute button in the popup
   - Verify audio stops and the icon changes
   - Test unmuting

3. **Test Tab Switching:**
   - Click the focus button or tab info
   - Verify you're switched to the correct tab

4. **Test Multiple Tabs:**
   - Play audio in several tabs simultaneously
   - Verify all appear in the list
   - Test controlling each independently

### Debugging

**Chrome DevTools:**
- Background script: Go to `chrome://extensions/` → Find your extension → Click "service worker"
- Popup: Right-click the extension icon → Inspect popup

**Firefox DevTools:**
- Go to `about:debugging#/runtime/this-firefox`
- Click "Inspect" on your extension
- Use the console to view background script logs

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

## Customization Ideas

Here are some ways you could extend this extension:

1. **Auto-mute on detection** - Automatically mute tabs when they start playing audio
2. **Whitelist/blacklist** - Allow audio from specific domains only
3. **Keyboard shortcuts** - Add hotkeys for muting/unmuting
4. **Audio visualization** - Show volume levels or waveforms
5. **History tracking** - Keep a log of which tabs played audio
6. **Smart notifications** - Alert when audio starts in background tabs
7. **Bulk controls** - Mute/unmute all tabs at once

## Browser Compatibility

| Feature | Chrome | Firefox | Edge | Brave |
|---------|--------|---------|------|-------|
| Audio detection | ✅ | ✅ | ✅ | ✅ |
| Badge counter | ✅ | ✅ | ✅ | ✅ |
| Mute/unmute | ✅ | ✅ | ✅ | ✅ |
| Tab switching | ✅ | ✅ | ✅ | ✅ |

**Minimum versions:**
- Chrome 88+
- Firefox 109+
- Edge 88+
- Brave (any recent version)

## Permissions Explained

- **`tabs`** - Required to access tab information including audio state, title, and URL
- **`storage`** - Reserved for future features (not currently used, but good to have)

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
