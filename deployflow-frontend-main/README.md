# 🚀 DeployFlow — Production-Ready Automated Deployment System

A modern, full-featured DevOps SaaS dashboard for managing deployments, monitoring infrastructure, and streaming live logs — inspired by Vercel, Railway, GitHub, and Grafana.

> Final Year Project | Frontend built with React 19 + Vite + Tailwind CSS

---

## ✨ Features

- 🔐 **Authentication** — Protected routes with session persistence
- 📊 **Dashboard** — Real-time stats, deployment history charts, recent activity
- 📁 **Projects Management** — Searchable/filterable project grid with detailed views
- 🚀 **Deployment Tracking** — Full deployment history with status filters
- 📟 **Live Log Streaming** — Terminal-style log viewer with real-time simulation
- 📈 **Infrastructure Monitoring** — CPU/Memory usage charts, Kubernetes-style pod status
- ⚙️ **Settings** — Profile management, notification preferences, API key management
- 🎨 **Modern UI/UX** — Dark theme, glassmorphism, smooth animations, fully responsive

---

## 🛠️ Tech Stack

| Technology | Purpose |
|---|---|
| **React 19** | UI library |
| **Vite** | Build tool & dev server |
| **Tailwind CSS v4** | Utility-first styling |
| **React Router DOM** | Client-side routing |
| **Framer Motion** | Animations & transitions |
| **Recharts** | Data visualization (charts) |
| **Lucide React** | Icon library |
| **Axios** | HTTP client (for future backend integration) |

---

## 📂 Folder Structure



---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18 or higher recommended)
- npm

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd FRONTEND

# Install dependencies
npm install

# Start development server
npm run dev
```

The app will be available at `http://localhost:5173`

### Build for Production

```bash
npm run build
```

---

## 🔑 Demo Login

This frontend currently uses a **mock authentication system** (no real backend yet). Any email and password combination will work:    Email: demo@deployflow.app
                          Password: any password


---

## 📄 Pages Overview

| Page | Route | Description |
|---|---|---|
| Login | `/login` | Authentication entry point |
| Dashboard | `/` | Overview stats, charts, recent deployments |
| Projects | `/projects` | Grid of all projects with search/filter |
| Project Details | `/projects/:id` | Project overview, deployments, env vars, settings |
| Deployments | `/deployments` | All deployments across projects |
| Deployment Details | `/deployments/:id` | Timeline + build logs for a deployment |
| Logs | `/logs` | Live-streaming logs across all services |
| Monitoring | `/monitoring` | CPU/Memory charts + pod status |
| Settings | `/settings` | Profile, notifications, API keys |

---

## 🔮 Future Enhancements

- [ ] Connect to real backend API (Node.js/Express + PostgreSQL)
- [ ] Real-time logs via WebSocket instead of simulated intervals
- [ ] JWT-based authentication with refresh tokens
- [ ] Role-based access control (RBAC)
- [ ] CI/CD pipeline integration (GitHub Actions / Jenkins webhooks)
- [ ] Dark/Light theme toggle

---

## 👨‍💻 Author

Built as a Final Year DevOps Project — **DeployFlow**

---

## 📝 License

This project is for academic/educational purposes.