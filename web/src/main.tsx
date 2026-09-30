import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github.css';
import '@xterm/xterm/css/xterm.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/computer.css';
import './styles/views.css';
import { App } from './App';
import { boot } from './store';
import { connectSocket } from './socket';

void boot();
connectSocket();
createRoot(document.getElementById('root')!).render(<App />);
