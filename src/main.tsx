import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { DatabaseProvider } from "./app/db/DatabaseProvider";
import { SettingsProvider } from "./app/settings/SettingsProvider";
import { ThemeProvider } from "./app/theme/ThemeProvider";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error('Missing #root element — index.html and main.tsx disagree.');
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <SettingsProvider>
        <DatabaseProvider>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <App />
          </BrowserRouter>
        </DatabaseProvider>
      </SettingsProvider>
    </ThemeProvider>
  </StrictMode>,
);
