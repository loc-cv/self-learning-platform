// The web app's entry point: the home screen and the workspace for one item at a time.

import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import './app/fonts.ts';
import './app/tokens.css';
import './app/styles.css';
import './app/learning.css';

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
