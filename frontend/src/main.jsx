import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#000', color: '#fff', fontFamily: 'monospace', padding: 40, fontSize: 16 }}>
          <div style={{ color: '#f44', marginBottom: 12, fontSize: 20 }}>CableBox failed to start</div>
          <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>{String(this.state.error)}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
