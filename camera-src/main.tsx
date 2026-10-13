import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SendClient } from "./app/send-client";
import { ScannerClient } from "./app/scan/scanner-client";
import "./app/globals.css";

type Mode = "send" | "scan";

function modeFromHash(): Mode {
  return window.location.hash.toLowerCase() === "#scan" ? "scan" : "send";
}

function Header({ active }: { active: Mode }) {
  return (
    <header className="site-header">
      <a className="wordmark" href="../" aria-label="Chirp sound mode">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>Chirp</span>
      </a>
      <nav className="mode-switch" aria-label="Transfer mode">
        <a href="../">Sound</a>
        <a className={active === "send" ? "active" : ""} href="#send">
          Send
        </a>
        <a className={active === "scan" ? "active" : ""} href="#scan">
          Scan
        </a>
      </nav>
      <span className="local-badge">
        <span aria-hidden="true" />
        Files through the camera
      </span>
    </header>
  );
}

function App() {
  const [mode, setMode] = useState<Mode>(modeFromHash);

  useEffect(() => {
    const onHashChange = () => setMode(modeFromHash());
    window.addEventListener("hashchange", onHashChange);
    document.title = mode === "scan" ? "Scan · Chirp" : "Send · Chirp";
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [mode]);

  return (
    <>
      <Header active={mode} />
      {mode === "scan" ? <ScannerClient /> : <SendClient />}
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Chirp camera root is missing.");
// Makes the sender's "Copy receiver link" point at this page's #scan view.
document.documentElement.dataset.qrferryStandalone = "true";
createRoot(root).render(<App />);
