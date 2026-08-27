import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { DatabaseProvider } from "./app/db/DatabaseProvider";
import { SettingsProvider } from "./app/settings/SettingsProvider";
import { AuthProvider } from "./features/auth/AuthProvider";
import { ThemeProvider } from "./app/theme/ThemeProvider";
import { browserFontAdapters, loadAndRegisterAllCustomFonts } from "./app/typography/customFonts";
import "./styles/global.css";

// Imported reading fonts register themselves before anything waits on them: the
// app renders with the fallback stack and reflows once, the same trade the
// pre-paint script documents for faces it does not know.
void loadAndRegisterAllCustomFonts(browserFontAdapters(), document.documentElement);

const container = document.getElementById("root");
if (!container) {
  throw new Error('Missing #root element — index.html and main.tsx disagree.');
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <SettingsProvider>
        {/* The replica sits outside auth on purpose: an author's work is theirs
            whether or not they are signed in, and signing out must not take the
            local copy with it. */}
        <DatabaseProvider>
          <AuthProvider>
            <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </DatabaseProvider>
      </SettingsProvider>
    </ThemeProvider>
  </StrictMode>,
);
