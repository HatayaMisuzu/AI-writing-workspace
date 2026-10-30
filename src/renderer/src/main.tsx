import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { DiagProfiler } from './services/diag-keystroke'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><DiagProfiler id="App"><App /></DiagProfiler></React.StrictMode>
)
