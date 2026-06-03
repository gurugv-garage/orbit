import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import { App } from './App';
import { StationClient } from './lib/station';
import { StationContext } from './lib/useStation';

const client = new StationClient();
client.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StationContext.Provider value={client}>
      <App />
    </StationContext.Provider>
  </StrictMode>,
);
