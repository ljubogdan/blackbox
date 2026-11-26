// Apple devices use San Francisco itself; everywhere else Inter, with its optical sizes, stands in.
import '@fontsource-variable/inter/opsz.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme.css';

createRoot(document.getElementById('root')!).render(<App />);
