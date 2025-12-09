# YouTube Auto-Mute Quick Start Guide

## What This Feature Does

The YouTube auto-mute feature automatically detects and mutes advertisements on YouTube, then unmutes your tab when the actual content resumes. No more jarring ad interruptions!

## How to Use

### 1. Enable/Disable Auto-Mute

1. Click the Hush Tab extension icon in your browser toolbar
2. Look for the toggle switch at the top that says "Auto-mute YouTube ads"
3. **Toggle ON** (purple) = Auto-mute enabled
4. **Toggle OFF** (white) = Auto-mute disabled

### 2. Watch YouTube Videos

1. Open any YouTube video
2. When an ad plays, the tab will automatically mute
3. When the ad ends and content resumes, the tab will automatically unmute
4. You'll see `[Hush Tab]` messages in the browser console (F12) if you want to see what's happening

### 3. Manual Control

- You can still manually mute/unmute tabs using the extension popup
- Manual muting is respected - the extension won't auto-unmute a tab you manually muted
- The extension only auto-unmutes tabs that IT muted during ads

## How It Works

The extension monitors YouTube's page for ad-related elements:
- Ad overlay containers
- "Skip Ad" buttons
- Ad text indicators
- Player state changes

When any of these are detected, it instantly mutes the tab. When they disappear (content resumes), it unmutes.

## Troubleshooting

### Ads aren't being muted

1. **Check the toggle** - Make sure auto-mute is ON in the popup
2. **Refresh the page** - Reload the YouTube video
3. **Check the console** - Press F12 on YouTube and look for `[Hush Tab]` messages
4. **Reinstall** - Sometimes YouTube updates break detection; reload the extension

### Tab won't unmute after ad

1. **Wait a moment** - Detection runs every 500ms, there may be a brief delay
2. **Check if you manually muted** - The extension won't unmute tabs you manually muted
3. **Reload the extension** - Go to `chrome://extensions/` and click the reload button

### False positives (muting content that's not an ad)

This is rare but can happen if YouTube's page structure changes. Report the issue with:
- The specific video URL
- Browser console logs (F12 → Console → look for `[Hush Tab]` messages)

## Tips & Tricks

- **Leave it on** - The auto-mute feature is designed to run passively without any interaction
- **Works across tabs** - You can have multiple YouTube tabs open; each is monitored independently
- **Battery friendly** - The detection is lightweight and won't significantly impact performance
- **Privacy first** - All detection happens locally in your browser; nothing is sent to external servers

## Technical Details

- Detection methods: DOM element checking + MutationObserver + polling fallback
- Check interval: 500ms
- Delay: Usually < 100ms from ad start to mute
- Supported: All YouTube video types (regular videos, live streams, premieres)

---

**Need help?** Check the main README.md or open an issue on GitHub!
