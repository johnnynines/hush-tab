// Popup script for Audio Tab Detector
// Displays tabs playing audio and allows control

document.addEventListener('DOMContentLoaded', async () => {
  await loadAutoMuteSettings();
  await loadAudioTabs();
  setupEventListeners();
});

// Load auto-mute settings
async function loadAutoMuteSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getAutoMuteSettings' });
    const toggle = document.getElementById('auto-mute-toggle');
    toggle.checked = response.autoMuteAds !== false;
  } catch (error) {
    console.error('Error loading auto-mute settings:', error);
  }
}

// Setup event listeners
function setupEventListeners() {
  const toggle = document.getElementById('auto-mute-toggle');
  toggle.addEventListener('change', async (e) => {
    try {
      await chrome.runtime.sendMessage({ 
        action: 'setAutoMuteSettings', 
        enabled: e.target.checked 
      });
      
      // Visual feedback
      const settingsBar = document.querySelector('.settings-bar');
      settingsBar.style.opacity = '0.7';
      setTimeout(() => {
        settingsBar.style.opacity = '1';
      }, 150);
    } catch (error) {
      console.error('Error saving auto-mute settings:', error);
    }
  });
}

// Load and display tabs with audio
async function loadAudioTabs() {
  const loading = document.getElementById('loading');
  const noAudio = document.getElementById('no-audio');
  const tabsList = document.getElementById('tabs-list');
  
  try {
    // Request audio tabs from background script
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
  
  // Add different styling for muted vs unmuted tabs
  item.className = isMuted ? 'tab-item tab-muted' : 'tab-item tab-unmuted';
  
  // Tab info section
  const info = document.createElement('div');
  info.className = 'tab-info';
  
  // Status indicator
  const statusIndicator = document.createElement('div');
  statusIndicator.className = 'status-indicator';
  statusIndicator.innerHTML = isMuted ? '🔇' : '🔊';
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
  
  // Add muted label if tab is muted
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
  muteBtn.innerHTML = isMuted ? '�' : '�';
  muteBtn.title = isMuted ? 'Unmute this tab' : 'Mute this tab';
  muteBtn.onclick = () => toggleMute(tab.id, isMuted, muteBtn);
  
  // Focus button
  const focusBtn = document.createElement('button');
  focusBtn.className = 'control-btn';
  focusBtn.innerHTML = '👁️';
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
      button.innerHTML = currentlyMuted ? '🔊' : '🔇';
      button.title = currentlyMuted ? 'Mute' : 'Unmute';
      
      // Add a visual feedback
      button.classList.add('clicked');
      setTimeout(() => button.classList.remove('clicked'), 200);
    }
  } catch (error) {
    console.error('Error toggling mute:', error);
  }
}

// Focus a specific tab
async function focusTab(tabId) {
  try {
    // Get the tab to find its window
    const tab = await chrome.tabs.get(tabId);
    
    const response = await chrome.runtime.sendMessage({ 
      action: 'focusTab', 
      tabId: tabId,
      windowId: tab.windowId
    });
    
    if (response.success) {
      // Close the popup after switching
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
