import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message + "\n" + error.stack };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: "#dc2626", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
          <h2>React Error</h2>
          <pre>{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

try {
  const root = document.getElementById("root");
  if (!root) throw new Error("root element not found");
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
} catch (e) {
  document.body.innerHTML = `<pre style="padding:40px;color:red">${e}</pre>`;
}
