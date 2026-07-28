import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

localStorage.setItem('chuangdex-theme', 'light')
document.documentElement.classList.add('light')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
