import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.jsx';

// After a new deploy, a page left open asks for page bundles that no longer exist: reload once to get the new ones.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('uu_reloaded') === location.pathname) return;
    sessionStorage.setItem('uu_reloaded', location.pathname);
  } catch { /* storage blocked: reload anyway */ }
  e.preventDefault();
  location.reload();
});
try { setTimeout(() => sessionStorage.removeItem('uu_reloaded'), 10_000); } catch { /* storage blocked */ }

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
