// ===== Install support for every platform =====
// Chrome / Edge / Samsung Internet / Opera (Android, Windows, macOS, Linux, ChromeOS):
//   native prompt via `beforeinstallprompt`.
// iPhone / iPad: no prompt API, so we show Share → Add to Home Screen steps.
// Safari on Mac, Firefox: show the right manual steps.
import { toast } from './format.js';

const ua = navigator.userAgent;
export const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(ua);
const isFirefox = /firefox|fxios/i.test(ua);
const isMacSafari = !isIOS && /macintosh/i.test(ua) && /safari/i.test(ua) && !/chrome|chromium|edg|opr/i.test(ua);

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: window-controls-overlay)').matches ||
  navigator.standalone === true;

export function initInstall() {
  const btn = document.getElementById('installBtn');
  let deferred = null;

  if (isStandalone()) return;                      // already installed and running as app

  // Platforms without a native prompt get the button straight away (shows instructions)
  if (isIOS || isMacSafari || isFirefox) btn.hidden = false;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === 'accepted') btn.hidden = true;
      return;
    }
    if (isIOS) return document.getElementById('iosDlg').showModal();

    let text;
    if (isMacSafari) text = 'In Safari, open the File menu and choose “Add to Dock”.';
    else if (isFirefox && isAndroid) text = 'Open the Firefox menu (⋮) and choose “Install” or “Add to Home screen”.';
    else if (isFirefox) text = 'Firefox on desktop can’t install web apps. Open this page in Chrome or Edge and use the install button there, or keep using it in the browser.';
    else text = 'Open your browser menu and choose “Install app” or “Add to Home screen”.';
    document.getElementById('helpText').textContent = text;
    document.getElementById('helpDlg').showModal();
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    toast('Installed — you can open it from your home screen or apps list');
  });
}

// Close buttons for dialogs
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) c.closest('dialog').close();
});
