// Popup script for Hush Tab
// Displays tabs playing audio and allows manual mute control

// Debounce timer reference for coalescing rapid update events
let refreshTimer = null;
const DEBOUNCE_MS = 250;

// Default favicon fallback as a data URI (simple globe icon)
const DEFAULT_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">' +
  '<circle cx="8" cy="8" r="7" stroke="#999" stroke-width="1.5" fill="none"/>' +
  '<ellipse cx="8" cy="8" rx="3" ry="7" stroke="#999" stroke-width="1.2" fill="none"/>' +
  '<line x1="1" y1="8" x2="15" y2="8" stroke="#999" stroke-width="1.2"/>' +
  '</svg>'
);

document.addEventListener('DOMContentLoaded', async () => {
  await loadAutoMuteState();
  await loadAudioTabs();
  setupEventListeners();
  setupTabListeners();
});

// Load and initialize the auto-mute toggle state from the background
async function loadAutoMuteState() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getAutoMuteEnabled' });
    const checkbox = document.getElementById('auto-mute-checkbox');
    if (checkbox && response) {
      checkbox.checked = response.enabled;
    }
  } catch (error) {
    console.error('Error loading auto-mute state:', error);
  }
}

// Setup static event listeners (diagnostic link, auto-mute toggle, etc.)
function setupEventListeners() {
  const diagnosticLink = document.getElementById('open-diagnostic');
  if (diagnosticLink) {
    diagnosticLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('diagnostic.html') });
    });
  }

  const autoMuteCheckbox = document.getElementById('auto-mute-checkbox');
  if (autoMuteCheckbox) {
    autoMuteCheckbox.addEventListener('change', async (e) => {
      try {
        await chrome.runtime.sendMessage({
          action: 'setAutoMuteEnabled',
          enabled: e.target.checked
        });
        // Refresh the tab list to reflect any auto-mute state changes
        await loadAudioTabs();
      } catch (error) {
        console.error('Error setting auto-mute state:', error);
        // Revert the checkbox on failure
        e.target.checked = !e.target.checked;
      }
    });
  }
}

// Setup tab change listeners with debounced refresh
function setupTabListeners() {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Listen for both audible AND mutedInfo changes
    if (changeInfo.audible !== undefined || changeInfo.mutedInfo !== undefined) {
      debouncedRefresh();
    }
  });

  chrome.tabs.onRemoved.addListener(() => {
    debouncedRefresh();
  });
}

// Debounced refresh to coalesce rapid-fire update events
function debouncedRefresh() {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadAudioTabs();
  }, DEBOUNCE_MS);
}

// Update the tab count badge in the header
function updateTabCount(count) {
  const tabCountEl = document.getElementById('tab-count');
  if (!tabCountEl) return;

  if (count > 0) {
    tabCountEl.textContent = count + (count === 1 ? ' tab' : ' tabs');
    tabCountEl.classList.add('visible');
  } else {
    tabCountEl.textContent = '';
    tabCountEl.classList.remove('visible');
  }
}

// Load and display tabs with audio
async function loadAudioTabs() {
  const loading = document.getElementById('loading');
  const noAudio = document.getElementById('no-audio');
  const tabsList = document.getElementById('tabs-list');

  try {
    const response = await chrome.runtime.sendMessage({ action: 'getAudioTabs' });

    loading.style.display = 'none';

    if (!response || !response.tabs || response.tabs.length === 0) {
      noAudio.style.display = 'flex';
      tabsList.style.display = 'none';
      tabsList.innerHTML = '';
      updateTabCount(0);
    } else {
      noAudio.style.display = 'none';
      tabsList.style.display = 'block';
      renderTabs(response.tabs);
      updateTabCount(response.tabs.length);
    }
  } catch (error) {
    console.error('Error loading audio tabs:', error);
    loading.style.display = 'none';
    // Show error in the no-audio area as a graceful fallback
    noAudio.style.display = 'flex';
    noAudio.innerHTML = '<p class="error">Error loading tabs. Try reopening the popup.</p>';
    updateTabCount(0);
  }
}

// Render tabs with DOM diffing to prevent flicker
// Reuses existing DOM nodes when possible, only updating changed attributes/content
function renderTabs(tabs) {
  const tabsList = document.getElementById('tabs-list');
  const existingItems = tabsList.querySelectorAll('.tab-item[data-tab-id]');
  const existingMap = new Map();

  for (const item of existingItems) {
    existingMap.set(item.dataset.tabId, item);
  }

  const incomingIds = new Set(tabs.map((t) => String(t.id)));

  // Remove items that are no longer present
  for (const [tabId, element] of existingMap) {
    if (!incomingIds.has(tabId)) {
      element.remove();
    }
  }

  // Update or insert items in order
  let previousSibling = null;
  for (const tab of tabs) {
    const tabIdStr = String(tab.id);
    const existing = existingMap.get(tabIdStr);

    if (existing) {
      // Update the existing element in place
      updateTabItem(existing, tab);
      // Ensure correct order -- move after previousSibling if needed
      const expectedNext = previousSibling
        ? previousSibling.nextElementSibling
        : tabsList.firstElementChild;
      if (existing !== expectedNext) {
        if (previousSibling) {
          previousSibling.after(existing);
        } else {
          tabsList.prepend(existing);
        }
      }
      previousSibling = existing;
    } else {
      // Create a new element
      const newItem = createTabItem(tab);
      if (previousSibling) {
        previousSibling.after(newItem);
      } else {
        tabsList.prepend(newItem);
      }
      previousSibling = newItem;
    }
  }
}

// Build the CSS-only status indicator for playing state (animated wave bars)
function buildPlayingIndicator() {
  const wrapper = document.createElement('div');
  wrapper.className = 'status-indicator';
  wrapper.title = 'Playing audio';

  const inner = document.createElement('div');
  inner.className = 'status-playing';

  for (let i = 0; i < 3; i++) {
    const bar = document.createElement('div');
    bar.className = 'wave-bar';
    inner.appendChild(bar);
  }

  wrapper.appendChild(inner);
  return wrapper;
}

// Build the CSS-only status indicator for muted state (speaker with slash)
function buildMutedIndicator() {
  const wrapper = document.createElement('div');
  wrapper.className = 'status-indicator';
  wrapper.title = 'Muted (has audio)';

  const inner = document.createElement('div');
  inner.className = 'status-muted';

  const speaker = document.createElement('div');
  speaker.className = 'mute-speaker';
  const cone = document.createElement('div');
  cone.className = 'mute-cone';
  const slash = document.createElement('div');
  slash.className = 'mute-slash';

  inner.appendChild(speaker);
  inner.appendChild(cone);
  inner.appendChild(slash);

  wrapper.appendChild(inner);
  return wrapper;
}

// Build the CSS-only mute/unmute button icon elements
function buildMuteButtonIcons() {
  const fragment = document.createDocumentFragment();

  const speakerBody = document.createElement('span');
  speakerBody.className = 'btn-icon-speaker';

  const cone = document.createElement('span');
  cone.className = 'btn-icon-cone';

  const wave = document.createElement('span');
  wave.className = 'btn-icon-wave';

  const slash = document.createElement('span');
  slash.className = 'btn-icon-slash';

  fragment.appendChild(speakerBody);
  fragment.appendChild(cone);
  fragment.appendChild(wave);
  fragment.appendChild(slash);

  return fragment;
}

// Build the CSS-only focus/go button icon elements
function buildFocusButtonIcons() {
  const fragment = document.createDocumentFragment();

  const shaft = document.createElement('span');
  shaft.className = 'btn-icon-arrow-shaft';

  const head = document.createElement('span');
  head.className = 'btn-icon-arrow-head';

  fragment.appendChild(shaft);
  fragment.appendChild(head);

  return fragment;
}

/**
 * Compute the expected CSS class string for a tab item.
 * @param {object} tab - Tab data from background
 * @returns {string} The class string
 */
function computeTabItemClass(tab) {
  const isMuted = tab.mutedInfo && tab.mutedInfo.muted;
  const adDetected = !!tab.adDetected;
  const autoMuted = !!tab.autoMuted;

  let cls = isMuted ? 'tab-item tab-muted' : 'tab-item tab-unmuted';
  if (adDetected) {
    cls += ' ad-detected';
  }
  if (autoMuted) {
    cls += ' auto-muted';
  }
  return cls;
}

// Update an existing tab item DOM node with new tab data
function updateTabItem(element, tab) {
  const isMuted = tab.mutedInfo && tab.mutedInfo.muted;
  const adDetected = !!tab.adDetected;
  const autoMuted = !!tab.autoMuted;
  const expectedClass = computeTabItemClass(tab);

  if (element.className !== expectedClass) {
    element.className = expectedClass;
  }

  // Update ad detection badge
  const existingAdBadge = element.querySelector('.ad-badge');
  if (adDetected && !existingAdBadge) {
    const adBadge = document.createElement('span');
    adBadge.className = 'ad-badge';
    adBadge.textContent = 'AD';
    // Insert after the status indicator
    const statusEl = element.querySelector('.status-indicator');
    if (statusEl && statusEl.nextSibling) {
      statusEl.parentNode.insertBefore(adBadge, statusEl.nextSibling);
    } else if (statusEl) {
      statusEl.parentNode.appendChild(adBadge);
    }
  } else if (!adDetected && existingAdBadge) {
    existingAdBadge.remove();
  }

  // Update auto-muted indicator
  const existingAutoMuteLabel = element.querySelector('.auto-muted-label');
  if (autoMuted && !existingAutoMuteLabel) {
    const autoMuteLabel = document.createElement('span');
    autoMuteLabel.className = 'auto-muted-label';
    autoMuteLabel.textContent = 'auto-muted';
    // Insert after the ad badge or status indicator
    const adBadge = element.querySelector('.ad-badge');
    const statusEl = element.querySelector('.status-indicator');
    const insertAfter = adBadge || statusEl;
    if (insertAfter && insertAfter.nextSibling) {
      insertAfter.parentNode.insertBefore(autoMuteLabel, insertAfter.nextSibling);
    } else if (insertAfter) {
      insertAfter.parentNode.appendChild(autoMuteLabel);
    }
  } else if (!autoMuted && existingAutoMuteLabel) {
    existingAutoMuteLabel.remove();
  }

  // Update favicon
  const favicon = element.querySelector('.tab-favicon');
  if (favicon) {
    const newSrc = tab.favIconUrl || DEFAULT_FAVICON;
    if (favicon.src !== newSrc) {
      favicon.src = newSrc;
    }
  }

  // Update status indicator (replace entirely if state changed)
  const status = element.querySelector('.status-indicator');
  if (status) {
    const isCurrentlyMuted = status.querySelector('.status-muted') !== null;
    if (isCurrentlyMuted !== isMuted) {
      const newIndicator = isMuted ? buildMutedIndicator() : buildPlayingIndicator();
      status.replaceWith(newIndicator);
    }
  }

  // Update title
  const title = element.querySelector('.tab-title');
  if (title) {
    const newTitle = tab.title || 'Untitled';
    if (title.textContent !== newTitle) {
      title.textContent = newTitle;
      title.title = newTitle;
    }
  }

  // Update URL and muted label
  const urlEl = element.querySelector('.tab-url');
  if (urlEl) {
    let hostname = tab.url;
    try {
      hostname = new URL(tab.url).hostname;
    } catch (_) {
      // keep raw url
    }

    // Update the hostname text node
    const currentHostname = urlEl.childNodes[0]
      ? urlEl.childNodes[0].textContent
      : '';
    if (currentHostname !== hostname) {
      urlEl.childNodes[0].textContent = hostname;
    }

    const existingLabel = urlEl.querySelector('.muted-label');
    if (isMuted && !existingLabel) {
      const mutedLabel = document.createElement('span');
      mutedLabel.className = 'muted-label';
      mutedLabel.textContent = autoMuted ? ' (auto-muted)' : ' (muted)';
      urlEl.appendChild(mutedLabel);
    } else if (!isMuted && existingLabel) {
      existingLabel.remove();
    } else if (isMuted && existingLabel) {
      // Update the label text if auto-muted status changed
      const expectedText = autoMuted ? ' (auto-muted)' : ' (muted)';
      if (existingLabel.textContent !== expectedText) {
        existingLabel.textContent = expectedText;
      }
    }
  }

  // Update mute button
  const muteBtn = element.querySelector('.control-btn-mute');
  if (muteBtn) {
    muteBtn.title = isMuted ? 'Unmute this tab' : 'Mute this tab';
    // Toggle the is-muted class which controls which icon parts are visible
    if (isMuted) {
      muteBtn.classList.add('is-muted');
    } else {
      muteBtn.classList.remove('is-muted');
    }
    // Rebind click handler to capture current state
    muteBtn.onclick = () => toggleMute(tab.id, isMuted);
  }

  // Rebind focus handlers with current tab id
  const info = element.querySelector('.tab-info');
  if (info) {
    info.onclick = () => focusTab(tab.id);
  }

  const focusBtn = element.querySelector('.control-btn-focus');
  if (focusBtn) {
    focusBtn.onclick = () => focusTab(tab.id);
  }
}

// Create a new tab item element
function createTabItem(tab) {
  const item = document.createElement('div');
  const isMuted = tab.mutedInfo && tab.mutedInfo.muted;
  const adDetected = !!tab.adDetected;
  const autoMuted = !!tab.autoMuted;

  item.className = computeTabItemClass(tab);
  item.dataset.tabId = String(tab.id);

  // Tab info section (clickable to focus)
  const info = document.createElement('div');
  info.className = 'tab-info';
  info.onclick = () => focusTab(tab.id);

  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'tab-favicon';
  favicon.width = 16;
  favicon.height = 16;
  favicon.src = tab.favIconUrl || DEFAULT_FAVICON;
  favicon.alt = '';
  // Fallback if the favicon fails to load
  favicon.onerror = () => {
    favicon.src = DEFAULT_FAVICON;
    favicon.onerror = null; // prevent infinite loop
  };

  // Status indicator (CSS-only)
  const statusIndicator = isMuted ? buildMutedIndicator() : buildPlayingIndicator();

  // Text container
  const textContainer = document.createElement('div');
  textContainer.className = 'tab-text';

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = tab.title || 'Untitled';
  title.title = tab.title || 'Untitled';

  const url = document.createElement('div');
  url.className = 'tab-url';

  // Hostname text node (allows targeted updates later)
  let hostname = tab.url;
  try {
    hostname = new URL(tab.url).hostname;
  } catch (_) {
    // keep raw url
  }
  url.appendChild(document.createTextNode(hostname));

  if (isMuted) {
    const mutedLabel = document.createElement('span');
    mutedLabel.className = 'muted-label';
    mutedLabel.textContent = autoMuted ? ' (auto-muted)' : ' (muted)';
    url.appendChild(mutedLabel);
  }

  textContainer.appendChild(title);
  textContainer.appendChild(url);

  info.appendChild(favicon);
  info.appendChild(statusIndicator);

  // Ad detection badge (shown only when ad is detected)
  if (adDetected) {
    const adBadge = document.createElement('span');
    adBadge.className = 'ad-badge';
    adBadge.textContent = 'AD';
    info.appendChild(adBadge);
  }

  // Auto-muted indicator label
  if (autoMuted) {
    const autoMuteLabel = document.createElement('span');
    autoMuteLabel.className = 'auto-muted-label';
    autoMuteLabel.textContent = 'auto-muted';
    info.appendChild(autoMuteLabel);
  }

  info.appendChild(textContainer);

  // Controls section
  const controls = document.createElement('div');
  controls.className = 'tab-controls';

  // Mute/Unmute button (icon-only)
  const muteBtn = document.createElement('button');
  muteBtn.className = 'control-btn control-btn-mute';
  if (isMuted) {
    muteBtn.classList.add('is-muted');
  }
  muteBtn.title = isMuted ? 'Unmute this tab' : 'Mute this tab';
  muteBtn.appendChild(buildMuteButtonIcons());
  muteBtn.onclick = () => toggleMute(tab.id, isMuted);

  // Focus button (icon-only)
  const focusBtn = document.createElement('button');
  focusBtn.className = 'control-btn control-btn-focus';
  focusBtn.title = 'Switch to this tab';
  focusBtn.appendChild(buildFocusButtonIcons());
  focusBtn.onclick = () => focusTab(tab.id);

  controls.appendChild(muteBtn);
  controls.appendChild(focusBtn);

  item.appendChild(info);
  item.appendChild(controls);

  return item;
}

// Toggle mute state of a tab
async function toggleMute(tabId, currentlyMuted) {
  try {
    const action = currentlyMuted ? 'unmuteTab' : 'muteTab';
    const response = await chrome.runtime.sendMessage({ action, tabId });

    if (response && response.success) {
      await loadAudioTabs();
    }
  } catch (error) {
    console.error('Error toggling mute:', error);
  }
}

// Focus a specific tab
async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const response = await chrome.runtime.sendMessage({
      action: 'focusTab',
      tabId,
      windowId: tab.windowId
    });

    if (response && response.success) {
      window.close();
    }
  } catch (error) {
    console.error('Error focusing tab:', error);
  }
}
