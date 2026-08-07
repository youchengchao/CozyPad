import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';
// Loaded second on purpose: the chat presentation layer is the final word on
// how a conversation looks, whichever agent and whichever view renders it.
import './styles/chat.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
