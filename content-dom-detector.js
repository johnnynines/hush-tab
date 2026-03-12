// DOM-based ad detection for Hush Tab
// Detects <ad-badge-overlay> custom elements and div elements with ad-badge class patterns.
//
// Note on Shadow DOM: <ad-badge-overlay> uses declarative shadow DOM (shadowrootmode="open").
// The inner div elements live inside the shadow root and are not visible to a standard
// MutationObserver on the document. This script detects the host element itself as the
// primary signal, then inspects the open shadow root for the badge classes as confirmation.

(function () {
  'use strict';

  if (window.__hushTabDomDetectorLoaded) return;
  window.__hushTabDomDetectorLoaded = true;

  const LOG_PREFIX = '[Hush Tab DOM]';

  // Tier-1 weight: this is an unambiguous, platform-specific ad indicator
  const DOM_AD_SIGNAL_WEIGHT = 10;

  // Suppress duplicate signals within this window to avoid flooding recordAdSignal
  const SIGNAL_DEBOUNCE_MS = 2000;
  let lastSignalTime = 0;

  function sendAdSignal(reason) {
    const now = Date.now();
    if (now - lastSignalTime < SIGNAL_DEBOUNCE_MS) return;
    lastSignalTime = now;

    console.log(`${LOG_PREFIX} Ad element detected: ${reason}`);
    chrome.runtime.sendMessage({ action: 'domAdSignal', weight: DOM_AD_SIGNAL_WEIGHT })
      .catch(() => {
        // Extension context invalidated (e.g., extension reloaded) — ignore
      });
  }

  // Check an open shadow root for the inner ad-badge div class patterns
  function checkShadowRoot(element) {
    if (!element.shadowRoot) return false;
    const badge = element.shadowRoot.querySelector(
      'div[class*="ad-badge-overlay"], div[class*="ad-badge--badge"]'
    );
    return !!badge;
  }

  // Evaluate a single added DOM node (and its subtree) for ad elements
  function checkNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();

    // Direct match: the <ad-badge-overlay> custom element itself
    if (tag === 'ad-badge-overlay') {
      const hasBadgeInShadow = checkShadowRoot(node);
      sendAdSignal(
        hasBadgeInShadow
          ? '<ad-badge-overlay> with inner badge element added'
          : '<ad-badge-overlay> element added'
      );
      return;
    }

    // Direct match: a div with ad-badge class patterns in the main (non-shadow) DOM
    if (tag === 'div') {
      const cls = node.className || '';
      if (cls.includes('ad-badge-overlay') || cls.includes('ad-badge--badge')) {
        sendAdSignal(`div.${cls.trim().split(/\s+/)[0]} added`);
        return;
      }
    }

    // Subtree check: <ad-badge-overlay> anywhere inside the added node
    const adBadgeEl = node.querySelector?.('ad-badge-overlay');
    if (adBadgeEl) {
      const hasBadgeInShadow = checkShadowRoot(adBadgeEl);
      sendAdSignal(
        hasBadgeInShadow
          ? '<ad-badge-overlay> with inner badge found in subtree'
          : '<ad-badge-overlay> found in subtree'
      );
      return;
    }

    // Subtree check: div with ad-badge class patterns in the main DOM
    const adBadgeDiv = node.querySelector?.(
      'div[class*="ad-badge-overlay"], div[class*="ad-badge--badge"]'
    );
    if (adBadgeDiv) {
      sendAdSignal(`div with ad-badge class found in subtree: ${adBadgeDiv.className.substring(0, 60)}`);
    }
  }

  // Scan the existing DOM on load (handles cases where the script injects after the element exists)
  function initialScan() {
    const existing = document.querySelectorAll('ad-badge-overlay');
    if (existing.length > 0) {
      sendAdSignal(`Initial scan: ${existing.length} <ad-badge-overlay> element(s) present`);
      return;
    }

    const adBadgeDivs = document.querySelectorAll(
      'div[class*="ad-badge-overlay"], div[class*="ad-badge--badge"]'
    );
    if (adBadgeDivs.length > 0) {
      sendAdSignal('Initial scan: div with ad-badge class present');
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        checkNode(node);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialScan);
  } else {
    initialScan();
  }

  console.log(`${LOG_PREFIX} DOM ad detector initialized`);
})();
