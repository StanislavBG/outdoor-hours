import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { OutdoorHoursPage } from './OutdoorHoursPage.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* basename mirrors vite.config.ts `base`. Lets react-router useSearchParams work
        when served at /projects/outdoor-hours/. */}
    <BrowserRouter basename="/projects/outdoor-hours">
      <OutdoorHoursPage />
    </BrowserRouter>
  </React.StrictMode>,
);
