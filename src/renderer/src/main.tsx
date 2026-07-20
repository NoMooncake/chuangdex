import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

const savedTheme = localStorage.getItem('chuangdex-theme')
const initialTheme = savedTheme === 'light' ? 'light' : 'dark'
if (initialTheme === 'light') {
  document.documentElement.classList.add('light')
} else {
  document.documentElement.classList.remove('light')
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
