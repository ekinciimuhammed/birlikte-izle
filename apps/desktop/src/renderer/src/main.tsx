import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/onboarding.css';
import './styles/home.css';
import './styles/watch.css';
import './styles/settings.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bridge, platform } from './platform/bridge';
import { getSetting, loadSettings, setSetting } from './settings/store';
import { useExtension } from './media/browser';
import { useWatch, watch } from './watch/controller';

document.documentElement.dataset.platform = platform;

// Otomatik testler (BIRLIKTE_TEST=1) dosya açma penceresi olmadan dosya açabilsin diye.
if (bridge.testMode) {
  Object.assign(window, {
    __birlikte: { watch, state: () => useWatch.getState(), extension: () => useExtension.getState(), getSetting, setSetting },
  });
}

loadSettings().then(() => {
  watch.applyVolume(getSetting('ui.volume'), false);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
