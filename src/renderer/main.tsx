import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import 'katex/dist/katex.min.css';
import './styles/app.css';
import './styles/preview.css';
import './styles/hljs-theme.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
