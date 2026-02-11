// Popup script for Hush Tab Diagnostic
// Displays tabs playing audio and allows manual mute control

document.addEventListener('DOMContentLoaded', async () => {
  await loadAudioTabs();
  setupEventListeners();
});

// Setup event listeners
function setupEventListeners() {
  // Diagnostic tool link - open in new tab
  const diagnosticLink = document.getElementById('open-diagnostic');
  if (diagnosticLink) {
    diagnosticLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('diagnostic.html') });
    });
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

    if (!response.tabs || response.tabs.length === 0) {
      noAudio.style.display = 'flex';
      tabsList.style.display = 'none';
    } else {
      noAudio.style.display = 'none';
      tabsList.style.display = 'block';
      displayTabs(response.tabs);
    }
  } catch (error) {
    console.error('Error loading audio tabs:', error);
    loading.innerHTML = '<p class="error">Error loading tabs</p>';
  }
}

// Display tabs in the list
function displayTabs(tabs) {
  const tabsList = document.getElementById('tabs-list');
  tabsList.innerHTML = '';

  tabs.forEach(tab => {
    const tabItem = createTabItem(tab);
    tabsList.appendChild(tabItem);
  });
}

// Create a tab item element
function createTabItem(tab) {
  const item = document.createElement('div');
  const isMuted = tab.mutedInfo && tab.mutedInfo.muted;

  item.className = isMuted ? 'tab-item tab-muted' : 'tab-item tab-unmuted';

  // Tab info section
  const info = document.createElement('div');
  info.className = 'tab-info';

  // Status indicator
  const statusIndicator = document.createElement('div');
  statusIndicator.className = 'status-indicator';
  statusIndicator.textContent = isMuted ? 'MUTED' : 'PLAYING';
  statusIndicator.title = isMuted ? 'Muted (has audio)' : 'Playing audio';

  const textContainer = document.createElement('div');
  textContainer.className = 'tab-text';

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = tab.title || 'Untitled';
  title.title = tab.title || 'Untitled';

  const url = document.createElement('div');
  url.className = 'tab-url';
  try {
    const urlObj = new URL(tab.url);
    url.textContent = urlObj.hostname;
  } catch (e) {
    url.textContent = tab.url;
  }

  if (isMuted) {
    const mutedLabel = document.createElement('span');
    mutedLabel.className = 'muted-label';
    mutedLabel.textContent = ' (muted)';
    url.appendChild(mutedLabel);
  }

  textContainer.appendChild(title);
  textContainer.appendChild(url);
  info.appendChild(statusIndicator);
  info.appendChild(textContainer);

  // Controls section
  const controls = document.createElement('div');
  controls.className = 'tab-controls';

  // Mute/Unmute button
  const muteBtn = document.createElement('button');
  muteBtn.className = 'control-btn';
  muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
  muteBtn.title = isMuted ? 'Unmute this tab' : 'Mute this tab';
  muteBtn.onclick = () => toggleMute(tab.id, isMuted, muteBtn);

  // Focus button
  const focusBtn = document.createElement('button');
  focusBtn.className = 'control-btn';
  focusBtn.textContent = 'Go';
  focusBtn.title = 'Switch to this tab';
  focusBtn.onclick = () => focusTab(tab.id);

  controls.appendChild(muteBtn);
  controls.appendChild(focusBtn);

  // Make the entire item clickable to focus tab
  info.onclick = () => focusTab(tab.id);
  info.style.cursor = 'pointer';

  item.appendChild(info);
  item.appendChild(controls);

  return item;
}

// Toggle mute state of a tab
async function toggleMute(tabId, currentlyMuted, button) {
  try {
    const action = currentlyMuted ? 'unmuteTab' : 'muteTab';
    const response = await chrome.runtime.sendMessage({
      action: action,
      tabId: tabId
    });

    if (response.success) {
      // Refresh the full list to update styling
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
      tabId: tabId,
      windowId: tab.windowId
    });

    if (response.success) {
      window.close();
    }
  } catch (error) {
    console.error('Error focusing tab:', error);
  }
}

// Listen for tab updates to refresh the list
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.audible !== undefined) {
    loadAudioTabs();
  }
});

// Listen for tab removal to refresh the list
chrome.tabs.onRemoved.addListener(() => {
  loadAudioTabs();
});
