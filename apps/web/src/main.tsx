// The web app's entry point (phase 10): the workspace for one lab at a time.

import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import './app/fonts.ts';
import './app/styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
