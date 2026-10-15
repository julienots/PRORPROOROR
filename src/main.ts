import './ui/styles.css';
import { Game } from './game';
import { UI } from './ui/ui';
import { GAME_NAME } from './brand';
import type { QualityPreset } from './render/engine';

/** Point d'entrée : détection WebGL 2, création du jeu et de l'interface. */
function boot(): void {
  const app = document.getElementById('app')!;
  const viewport = document.getElementById('viewport')!;
  const test = document.createElement('canvas');
  if (!test.getContext('webgl2')) {
    app.innerHTML = `<div class="fatal"><h1>${GAME_NAME}</h1><p>WebGL 2 est requis. Activez l\'accélération matérielle de votre navigateur ou essayez Chrome, Edge ou Firefox récents.</p></div>`;
    return;
  }
  const params = new URLSearchParams(location.search);
  const q = (params.get('quality') as QualityPreset | null) ?? (/Mobi|Android/i.test(navigator.userAgent) ? 'performance' : 'equilibre');
  const game = new Game(viewport, ['performance', 'equilibre', 'qualite'].includes(q) ? q : 'equilibre');
  const ui = new UI(game, app);
  if (params.has('autostart')) {
    game.started = true;
  } else if (params.has('nosplash')) {
    ui.showMenu();
  } else {
    ui.showStudioSplash();
  }
  // API de diagnostic et de test (utilisée par les tests en navigateur)
  (window as unknown as Record<string, unknown>).__SUPERESSENCE__ = { game, ui };
  window.addEventListener('error', (e) => console.error(`[${GAME_NAME}]`, e.message));
}

boot();
