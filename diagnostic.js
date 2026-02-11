// Diagnostic Panel JavaScript
// Controls recording and displays captured diagnostic data

document.addEventListener('DOMContentLoaded', async () => {
  await initializeDiagnosticPanel();
});

// State
let currentTabId = null;
let isRecording = false;
let diagnosticData = null;
let pollInterval = null;

// DOM Elements
const elements = {
  tabSelector: document.getElementById('tab-selector'),
  refreshTabsBtn: document.getElementById('refresh-tabs'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  markAdStartBtn: document.getElementById('mark-ad-start'),
  markAdEndBtn: document.getElementById('mark-ad-end'),
  statusIndicator: document.getElementById('status-indicator'),
  platformName: document.getElementById('platform-name'),
  exportJsonBtn: document.getElementById('export-json'),
  copySummaryBtn: document.getElementById('copy-summary'),
  // Stats
  statConsole: document.getElementById('stat-console'),
  statNetwork: document.getElementById('stat-network'),
  statDom: document.getElementById('stat-dom'),
  statVideo: document.getElementById('stat-video'),
  statPlayer: document.getElementById('stat-player'),
  // Log containers
  consoleLogContainer: document.getElementById('console-log-container'),
  networkLogContainer: document.getElementById('network-log-container'),
  domLogContainer: document.getElementById('dom-log-container'),
  videoLogContainer: document.getElementById('video-log-container'),
  playerLogContainer: document.getElementById('player-log-container'),
  summaryContent: document.getElementById('summary-content'),
};

// No site restriction - diagnostic can be used on any tab with a URL

async function initializeDiagnosticPanel() {
  await loadSupportedTabs();
  setupEventListeners();
  setupViewerTabs();
}

// Load all tabs with URLs (excluding internal browser pages)
async function loadSupportedTabs() {
  const tabs = await chrome.tabs.query({});
  const browsableTabs = tabs.filter(tab => {
    return tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'));
  });

  elements.tabSelector.innerHTML = '<option value="">-- Select a tab --</option>';

  browsableTabs.forEach(tab => {
    const option = document.createElement('option');
    option.value = tab.id;

    // Extract domain for display
    let domain = 'Unknown';
    try {
      domain = new URL(tab.url).hostname;
    } catch (e) {
      // ignore
    }

    option.textContent = `[${domain}] ${tab.title?.substring(0, 50) || 'Untitled'}`;
    elements.tabSelector.appendChild(option);
  });

  if (browsableTabs.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No browsable tabs found';
    option.disabled = true;
    elements.tabSelector.appendChild(option);
  }
}

function setupEventListeners() {
  elements.refreshTabsBtn.addEventListener('click', loadSupportedTabs);

  elements.tabSelector.addEventListener('change', async (e) => {
    currentTabId = e.target.value ? parseInt(e.target.value) : null;
    updateUIState();

    if (currentTabId) {
      // Check if diagnostic script is already recording
      try {
        const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getDiagnosticStatus' });
        if (response.success) {
          isRecording = response.isRecording;
          elements.platformName.textContent = response.platform || 'Unknown';
          updateUIState();
          if (isRecording) {
            startPolling();
          }
        }
      } catch (e) {
        console.log('Diagnostic script not loaded yet');
        elements.platformName.textContent = '--';
      }
    }
  });

  elements.startBtn.addEventListener('click', startRecording);
  elements.stopBtn.addEventListener('click', stopRecording);
  elements.markAdStartBtn.addEventListener('click', () => markAdEvent('start'));
  elements.markAdEndBtn.addEventListener('click', () => markAdEvent('end'));
  elements.exportJsonBtn.addEventListener('click', exportAsJson);
  elements.copySummaryBtn.addEventListener('click', copySummary);

  // Filter checkboxes
  document.getElementById('filter-log')?.addEventListener('change', refreshConsoleView);
  document.getElementById('filter-warn')?.addEventListener('change', refreshConsoleView);
  document.getElementById('filter-error')?.addEventListener('change', refreshConsoleView);
  document.getElementById('filter-ad-only')?.addEventListener('change', refreshNetworkView);
}

function setupViewerTabs() {
  const tabs = document.querySelectorAll('.viewer-tab');
  const panels = document.querySelectorAll('.viewer-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;

      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      document.getElementById(`${targetTab}-viewer`).classList.add('active');
    });
  });
}

async function startRecording() {
  if (!currentTabId) {
    alert('Please select a tab first');
    return;
  }

  try {
    // First, inject the diagnostic script if not already there
    await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      files: ['content-diagnostic.js'],
    });

    // Small delay to let script initialize
    await new Promise(resolve => setTimeout(resolve, 100));

    // Start recording
    const response = await chrome.tabs.sendMessage(currentTabId, { action: 'startDiagnostic' });

    if (response.success) {
      isRecording = true;
      elements.platformName.textContent = response.platform || 'Unknown';
      updateUIState();
      startPolling();
      clearLogContainers();
    }
  } catch (error) {
    console.error('Failed to start recording:', error);
    alert('Failed to start recording. Make sure the tab is a supported streaming site.');
  }
}

async function stopRecording() {
  if (!currentTabId) return;

  try {
    await chrome.tabs.sendMessage(currentTabId, { action: 'stopDiagnostic' });
    isRecording = false;
    updateUIState();
    stopPolling();

    // Fetch final data
    await fetchDiagnosticData();
    generateSummary();
  } catch (error) {
    console.error('Failed to stop recording:', error);
  }
}

async function markAdEvent(type) {
  if (!currentTabId || !isRecording) return;

  try {
    const action = type === 'start' ? 'markAdStart' : 'markAdEnd';
    await chrome.tabs.sendMessage(currentTabId, { action });

    // Visual feedback
    const btn = type === 'start' ? elements.markAdStartBtn : elements.markAdEndBtn;
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 200);
  } catch (error) {
    console.error('Failed to mark ad event:', error);
  }
}

function startPolling() {
  stopPolling();
  pollInterval = setInterval(fetchDiagnosticData, 1000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function fetchDiagnosticData() {
  if (!currentTabId) return;

  try {
    const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getDiagnosticData' });

    if (response.success) {
      diagnosticData = response.data;
      updateStats();
      updateLogViews();
    }
  } catch (error) {
    // Tab might have been closed or navigated away
    console.log('Could not fetch diagnostic data:', error.message);
  }
}

function updateUIState() {
  const hasTab = !!currentTabId;

  elements.startBtn.disabled = !hasTab || isRecording;
  elements.stopBtn.disabled = !hasTab || !isRecording;
  elements.markAdStartBtn.disabled = !hasTab || !isRecording;
  elements.markAdEndBtn.disabled = !hasTab || !isRecording;

  const statusIndicator = elements.statusIndicator;
  const statusDot = statusIndicator.querySelector('.status-dot');
  const statusText = statusIndicator.querySelector('.status-text');

  if (isRecording) {
    statusIndicator.classList.add('recording');
    statusDot.style.backgroundColor = '#e74c3c';
    statusText.textContent = 'Recording...';
  } else {
    statusIndicator.classList.remove('recording');
    statusDot.style.backgroundColor = '#999';
    statusText.textContent = hasTab ? 'Ready' : 'Select a tab';
  }
}

function updateStats() {
  if (!diagnosticData) return;

  elements.statConsole.textContent = diagnosticData.consoleLogs?.length || 0;
  elements.statNetwork.textContent = diagnosticData.networkRequests?.length || 0;
  elements.statDom.textContent = diagnosticData.domMutations?.length || 0;
  elements.statVideo.textContent = diagnosticData.videoEvents?.length || 0;
  elements.statPlayer.textContent = diagnosticData.playerState?.length || 0;
}

function updateLogViews() {
  if (!diagnosticData) return;

  refreshConsoleView();
  refreshNetworkView();
  refreshDomView();
  refreshVideoView();
  refreshPlayerView();
}

function clearLogContainers() {
  elements.consoleLogContainer.innerHTML = '';
  elements.networkLogContainer.innerHTML = '';
  elements.domLogContainer.innerHTML = '';
  elements.videoLogContainer.innerHTML = '';
  elements.playerLogContainer.innerHTML = '';
  elements.summaryContent.innerHTML = '<p class="placeholder">Recording in progress...</p>';
}

function refreshConsoleView() {
  if (!diagnosticData?.consoleLogs) return;

  const showLog = document.getElementById('filter-log')?.checked ?? true;
  const showWarn = document.getElementById('filter-warn')?.checked ?? true;
  const showError = document.getElementById('filter-error')?.checked ?? true;

  const filtered = diagnosticData.consoleLogs.filter(log => {
    if (log.level === 'log' && !showLog) return false;
    if (log.level === 'warn' && !showWarn) return false;
    if (log.level === 'error' && !showError) return false;
    return true;
  });

  elements.consoleLogContainer.innerHTML = filtered.slice(-100).map(log => `
    <div class="log-entry log-${log.level}">
      <span class="log-time">${formatTime(log.timestamp)}</span>
      <span class="log-level">[${log.level.toUpperCase()}]</span>
      <span class="log-message">${escapeHtml(log.message)}</span>
    </div>
  `).join('');

  elements.consoleLogContainer.scrollTop = elements.consoleLogContainer.scrollHeight;
}

function refreshNetworkView() {
  if (!diagnosticData?.networkRequests) return;

  const adOnly = document.getElementById('filter-ad-only')?.checked ?? false;

  let filtered = diagnosticData.networkRequests;
  if (adOnly) {
    filtered = filtered.filter(req => req.isAdRelated);
  }

  elements.networkLogContainer.innerHTML = filtered.slice(-100).map(req => `
    <div class="log-entry ${req.isAdRelated ? 'log-ad-related' : ''}">
      <span class="log-time">${formatTime(req.timestamp)}</span>
      <span class="log-method">[${req.type}]</span>
      <span class="log-url ${req.isAdRelated ? 'url-ad' : ''}">${escapeHtml(req.url)}</span>
      ${req.duration ? `<span class="log-duration">${req.duration}ms</span>` : ''}
      ${req.transferSize ? `<span class="log-size">${formatSize(req.transferSize)}</span>` : ''}
    </div>
  `).join('');

  elements.networkLogContainer.scrollTop = elements.networkLogContainer.scrollHeight;
}

function refreshDomView() {
  if (!diagnosticData?.domMutations) return;

  elements.domLogContainer.innerHTML = diagnosticData.domMutations.slice(-50).map(mutation => {
    let html = `<div class="log-entry log-dom">
      <span class="log-time">${formatTime(mutation.timestamp)}</span>`;

    if (mutation.interestingElements?.length > 0) {
      html += `<div class="dom-elements">`;
      mutation.interestingElements.forEach(el => {
        html += `<div class="dom-element ${el.action}">
          <span class="action">${el.action}</span>
          &lt;${el.tag}${el.id ? ` id="${el.id}"` : ''}${el.classes ? ` class="${escapeHtml(el.classes.substring(0, 100))}"` : ''}&gt;
          ${el.textContent ? `<span class="text-preview">"${escapeHtml(el.textContent)}"</span>` : ''}
        </div>`;
      });
      html += `</div>`;
    }

    if (mutation.classChanges?.length > 0) {
      html += `<div class="class-changes">`;
      mutation.classChanges.forEach(change => {
        html += `<div class="class-change">
          <span class="label">Class change:</span>
          <span class="old">${escapeHtml(change.oldClasses)}</span>
          <span class="arrow">&rarr;</span>
          <span class="new">${escapeHtml(change.newClasses)}</span>
        </div>`;
      });
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }).join('');

  elements.domLogContainer.scrollTop = elements.domLogContainer.scrollHeight;
}

function refreshVideoView() {
  if (!diagnosticData?.videoEvents) return;

  elements.videoLogContainer.innerHTML = diagnosticData.videoEvents.slice(-100).map(event => {
    const isUserMarker = event.event?.startsWith('USER_MARKED');
    return `
      <div class="log-entry ${isUserMarker ? 'log-user-marker' : 'log-video'}">
        <span class="log-time">${formatTime(event.timestamp)}</span>
        <span class="log-event">${event.event}</span>
        ${event.currentTime !== undefined ? `<span class="log-detail">time: ${event.currentTime.toFixed(2)}s</span>` : ''}
        ${event.note ? `<span class="log-note">${escapeHtml(event.note)}</span>` : ''}
      </div>
    `;
  }).join('');

  elements.videoLogContainer.scrollTop = elements.videoLogContainer.scrollHeight;
}

function refreshPlayerView() {
  if (!diagnosticData?.playerState) return;

  // Show only every 5th entry to reduce noise, unless there are few entries
  const states = diagnosticData.playerState;
  const filtered = states.length > 20 ? states.filter((_, i) => i % 5 === 0 || i === states.length - 1) : states;

  elements.playerLogContainer.innerHTML = filtered.slice(-30).map(state => {
    let platformInfo = '';

    if (state.ytPlayer) {
      platformInfo = `
        <div class="platform-state youtube">
          <strong>YouTube:</strong>
          adShowing: ${state.ytPlayer.adShowing},
          adInterrupting: ${state.ytPlayer.adInterrupting},
          adModule: ${state.ytPlayer.adModule},
          skipButton: ${state.ytPlayer.skipButton}
          ${state.ytPlayer.adPreviewText ? `, preview: "${escapeHtml(state.ytPlayer.adPreviewText)}"` : ''}
        </div>`;
    } else if (state.huluPlayer) {
      platformInfo = `
        <div class="platform-state hulu">
          <strong>Hulu:</strong>
          adBreak: ${state.huluPlayer.adBreakMarker},
          controlsDisabled: ${state.huluPlayer.controlsDisabled}
          ${state.huluPlayer.adCountdown ? `, countdown: "${escapeHtml(state.huluPlayer.adCountdown)}"` : ''}
        </div>`;
    } else if (state.espnPlayer) {
      platformInfo = `
        <div class="platform-state espn">
          <strong>ESPN:</strong>
          apiAdPlaying: ${state.espnPlayer.espnApiAdPlaying},
          imaContainer: ${state.espnPlayer.imaContainer}
          ${state.espnPlayer.adCountdown ? `, countdown: "${escapeHtml(state.espnPlayer.adCountdown)}"` : ''}
        </div>`;
    } else if (state.nbcPlayer) {
      platformInfo = `
        <div class="platform-state nbc">
          <strong>NBC:</strong>
          vjsAdPlaying: ${state.nbcPlayer.vjsAdPlaying},
          shortVideo: ${state.nbcPlayer.isShortVideo}${state.nbcPlayer.videoDuration ? ` (${Math.round(state.nbcPlayer.videoDuration)}s)` : ''},
          adOverlay: ${state.nbcPlayer.adOverlay},
          imaContainer: ${state.nbcPlayer.imaContainer}
          ${state.nbcPlayer.adTextFound ? `, adText: "${escapeHtml(state.nbcPlayer.adTextFound)}"` : ''}
        </div>`;
    }

    return `
      <div class="log-entry log-player">
        <span class="log-time">${formatTime(state.timestamp)}</span>
        <div class="player-info">
          <span>time: ${state.currentTime?.toFixed(2) || '--'}s</span>
          <span>paused: ${state.paused}</span>
          <span>muted: ${state.muted}</span>
        </div>
        ${platformInfo}
      </div>
    `;
  }).join('');

  elements.playerLogContainer.scrollTop = elements.playerLogContainer.scrollHeight;
}

function generateSummary() {
  if (!diagnosticData) {
    elements.summaryContent.innerHTML = '<p class="placeholder">No data to analyze</p>';
    return;
  }

  const summary = analyzeDiagnosticData(diagnosticData);

  elements.summaryContent.innerHTML = `
    <div class="summary-section">
      <h4>Recording Info</h4>
      <p>Platform: ${diagnosticData.platform}</p>
      <p>URL: ${diagnosticData.url}</p>
      <p>Duration: ${formatTime(diagnosticData.recordingDuration || 0)}</p>
    </div>

    <div class="summary-section">
      <h4>Ad-Related Network Requests</h4>
      ${summary.adNetworkRequests.length > 0 ? `
        <ul>
          ${summary.adNetworkRequests.slice(0, 20).map(req => `
            <li><code>${escapeHtml(extractDomain(req.url))}</code> (${req.count}x)</li>
          `).join('')}
        </ul>
      ` : '<p>No ad-related requests detected</p>'}
    </div>

    <div class="summary-section">
      <h4>Detected Ad Signals</h4>
      ${summary.adSignals.length > 0 ? `
        <ul>
          ${summary.adSignals.map(signal => `
            <li><strong>${signal.type}:</strong> ${escapeHtml(signal.description)}</li>
          `).join('')}
        </ul>
      ` : '<p>No clear ad signals detected</p>'}
    </div>

    <div class="summary-section">
      <h4>User-Marked Ad Events</h4>
      ${summary.userMarkers.length > 0 ? `
        <ul>
          ${summary.userMarkers.map(marker => `
            <li>${formatTime(marker.timestamp)}: ${marker.event}</li>
          `).join('')}
        </ul>
      ` : '<p>No ad events marked</p>'}
    </div>

    <div class="summary-section">
      <h4>Interesting DOM Classes</h4>
      ${summary.interestingClasses.length > 0 ? `
        <ul>
          ${summary.interestingClasses.slice(0, 15).map(cls => `
            <li><code>${escapeHtml(cls)}</code></li>
          `).join('')}
        </ul>
      ` : '<p>No ad-related classes detected</p>'}
    </div>

    <div class="summary-section">
      <h4>Console Patterns</h4>
      ${summary.consolePatterns.length > 0 ? `
        <ul>
          ${summary.consolePatterns.slice(0, 10).map(pattern => `
            <li>${escapeHtml(pattern)}</li>
          `).join('')}
        </ul>
      ` : '<p>No interesting console patterns</p>'}
    </div>

    <div class="summary-section">
      <h4>Global Objects Detected</h4>
      <ul>
        ${Object.entries(diagnosticData.globalObjects || {}).map(([key, val]) => `
          <li><code>${key}</code>: ${JSON.stringify(val)}</li>
        `).join('') || '<li>None detected</li>'}
      </ul>
    </div>
  `;
}

function analyzeDiagnosticData(data) {
  const summary = {
    adNetworkRequests: [],
    adSignals: [],
    userMarkers: [],
    interestingClasses: [],
    consolePatterns: [],
  };

  // Analyze network requests
  const adRequestCounts = {};
  data.networkRequests?.forEach(req => {
    if (req.isAdRelated) {
      const domain = extractDomain(req.url);
      adRequestCounts[domain] = (adRequestCounts[domain] || 0) + 1;
    }
  });
  summary.adNetworkRequests = Object.entries(adRequestCounts)
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count);

  // Find user markers
  summary.userMarkers = data.videoEvents?.filter(e => e.event?.startsWith('USER_MARKED')) || [];

  // Analyze player states for ad signals
  const adSignalsSet = new Set();
  data.playerState?.forEach(state => {
    if (state.ytPlayer?.adShowing) adSignalsSet.add('YouTube: .ad-showing class detected');
    if (state.ytPlayer?.adInterrupting) adSignalsSet.add('YouTube: .ad-interrupting class detected');
    if (state.ytPlayer?.adModule) adSignalsSet.add('YouTube: .ytp-ad-module present');
    if (state.ytPlayer?.skipButton) adSignalsSet.add('YouTube: Skip button detected');
    if (state.ytPlayer?.adPreviewText) adSignalsSet.add(`YouTube: Ad preview text: "${state.ytPlayer.adPreviewText}"`);

    if (state.huluPlayer?.adBreakMarker) adSignalsSet.add('Hulu: Ad break marker detected');
    if (state.huluPlayer?.controlsDisabled) adSignalsSet.add('Hulu: Controls disabled during ad');
    if (state.huluPlayer?.adCountdown) adSignalsSet.add(`Hulu: Countdown: "${state.huluPlayer.adCountdown}"`);

    if (state.espnPlayer?.espnApiAdPlaying) adSignalsSet.add('ESPN: API reports ad playing');
    if (state.espnPlayer?.imaContainer) adSignalsSet.add('ESPN: Google IMA container present');

    if (state.nbcPlayer?.vjsAdPlaying) adSignalsSet.add('NBC: Video.js ad-playing state detected');
    if (state.nbcPlayer?.isShortVideo) adSignalsSet.add(`NBC: Short video duration (${Math.round(state.nbcPlayer.videoDuration)}s) - likely ad`);
    if (state.nbcPlayer?.adOverlay) adSignalsSet.add('NBC: Ad overlay/container visible');
    if (state.nbcPlayer?.imaContainer) adSignalsSet.add('NBC: Google IMA container present');
    if (state.nbcPlayer?.adTextFound) adSignalsSet.add(`NBC: Ad text detected: "${state.nbcPlayer.adTextFound}"`);
    if (state.nbcPlayer?.seekDisabled) adSignalsSet.add('NBC: Seek bar disabled');
  });
  summary.adSignals = Array.from(adSignalsSet).map(desc => ({ type: 'Player State', description: desc }));

  // Collect interesting classes from DOM mutations
  const classesSet = new Set();
  data.domMutations?.forEach(mutation => {
    mutation.classChanges?.forEach(change => {
      const classes = (change.newClasses || '').split(/\s+/);
      classes.forEach(cls => {
        if (cls && (cls.toLowerCase().includes('ad') || cls.toLowerCase().includes('commercial'))) {
          classesSet.add(cls);
        }
      });
    });
    mutation.interestingElements?.forEach(el => {
      const classes = (el.classes || '').split(/\s+/);
      classes.forEach(cls => {
        if (cls && cls.length > 2) {
          classesSet.add(cls);
        }
      });
    });
  });
  summary.interestingClasses = Array.from(classesSet).sort();

  // Find interesting console patterns
  const consolePatterns = new Set();
  data.consoleLogs?.forEach(log => {
    const msg = log.message.toLowerCase();
    if (msg.includes('ad') || msg.includes('commercial') || msg.includes('sponsor') ||
        msg.includes('ima') || msg.includes('vast') || msg.includes('vpaid')) {
      consolePatterns.add(log.message.substring(0, 150));
    }
  });
  summary.consolePatterns = Array.from(consolePatterns);

  return summary;
}

function exportAsJson() {
  if (!diagnosticData) {
    alert('No data to export');
    return;
  }

  const exportData = {
    ...diagnosticData,
    exportedAt: new Date().toISOString(),
    analysis: analyzeDiagnosticData(diagnosticData),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hush-tab-diagnostic-${diagnosticData.platform}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function copySummary() {
  if (!diagnosticData) {
    alert('No data to copy');
    return;
  }

  const summary = analyzeDiagnosticData(diagnosticData);
  let text = `Hush Tab Diagnostic Summary\n`;
  text += `===========================\n\n`;
  text += `Platform: ${diagnosticData.platform}\n`;
  text += `URL: ${diagnosticData.url}\n\n`;

  text += `Ad-Related Network Requests:\n`;
  summary.adNetworkRequests.slice(0, 10).forEach(req => {
    text += `  - ${req.url} (${req.count}x)\n`;
  });

  text += `\nDetected Ad Signals:\n`;
  summary.adSignals.forEach(signal => {
    text += `  - ${signal.description}\n`;
  });

  text += `\nInteresting DOM Classes:\n`;
  summary.interestingClasses.slice(0, 10).forEach(cls => {
    text += `  - ${cls}\n`;
  });

  navigator.clipboard.writeText(text).then(() => {
    elements.copySummaryBtn.textContent = 'Copied!';
    setTimeout(() => {
      elements.copySummaryBtn.textContent = 'Copy Summary';
    }, 2000);
  });
}

// Utility functions
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTime(ms) {
  if (ms === undefined || ms === null) return '--';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const millis = ms % 1000;
  if (minutes > 0) {
    return `${minutes}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
  }
  return `${secs}.${millis.toString().padStart(3, '0')}s`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url.substring(0, 50);
  }
}
