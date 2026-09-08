/**
 * Mock/Dummy Data
 * 
 * Ye temporary data hai jab tak humara backend API ready nahi hota.
 * Jab backend ready ho, hum sirf 'services/' folder ke API calls
 * ko yahan se switch kar denge - components mein koi change nahi karna padega.
 */

// Dashboard summary stats
export const dashboardStats = {
  totalProjects: 12,
  activeDeployments: 4,
  successRate: 98.2,
  failedDeployments: 3,
}

// Deployment history for the last 7 days (used in area chart)
export const deploymentHistory = [
  { day: 'Mon', success: 12, failed: 1 },
  { day: 'Tue', success: 18, failed: 2 },
  { day: 'Wed', success: 15, failed: 0 },
  { day: 'Thu', success: 22, failed: 3 },
  { day: 'Fri', success: 28, failed: 1 },
  { day: 'Sat', success: 10, failed: 0 },
  { day: 'Sun', success: 14, failed: 1 },
]

// Recent deployments list (used in Dashboard + Deployments page)
export const recentDeployments = [
  {
    id: 'dep_001',
    project: 'auth-service',
    branch: 'main',
    status: 'success',
    commitMsg: 'Fix JWT token expiry bug',
    time: '2 mins ago',
  },
  {
    id: 'dep_002',
    project: 'payment-gateway',
    branch: 'develop',
    status: 'pending',
    commitMsg: 'Add Stripe webhook handler',
    time: '10 mins ago',
  },
  {
    id: 'dep_003',
    project: 'frontend-app',
    branch: 'main',
    status: 'success',
    commitMsg: 'Update dashboard UI components',
    time: '25 mins ago',
  },
  {
    id: 'dep_004',
    project: 'notification-service',
    branch: 'staging',
    status: 'failed',
    commitMsg: 'Refactor email queue logic',
    time: '1 hour ago',
  },
]
// Projects list (used in Projects page + Project Details page)
export const projects = [
  {
    id: 'proj_1',
    name: 'auth-service',
    description: 'Handles user authentication and JWT token management',
    status: 'active',
    lastDeployed: '2 mins ago',
    branch: 'main',
    techStack: ['Node.js', 'Express', 'PostgreSQL'],
    deploymentsCount: 142,
  },
  {
    id: 'proj_2',
    name: 'payment-gateway',
    description: 'Stripe & Razorpay integration microservice',
    status: 'building',
    lastDeployed: '10 mins ago',
    branch: 'develop',
    techStack: ['Node.js', 'Redis', 'Stripe API'],
    deploymentsCount: 98,
  },
  {
    id: 'proj_3',
    name: 'frontend-app',
    description: 'Main customer-facing React dashboard application',
    status: 'active',
    lastDeployed: '25 mins ago',
    branch: 'main',
    techStack: ['React', 'Vite', 'Tailwind'],
    deploymentsCount: 210,
  },
  {
    id: 'proj_4',
    name: 'notification-service',
    description: 'Email, SMS and push notification dispatcher',
    status: 'failed',
    lastDeployed: '1 hour ago',
    branch: 'staging',
    techStack: ['Python', 'Celery', 'RabbitMQ'],
    deploymentsCount: 76,
  },
  {
    id: 'proj_5',
    name: 'analytics-engine',
    description: 'Real-time event tracking and analytics processor',
    status: 'active',
    lastDeployed: '3 hours ago',
    branch: 'main',
    techStack: ['Go', 'Kafka', 'ClickHouse'],
    deploymentsCount: 54,
  },
  {
    id: 'proj_6',
    name: 'admin-panel',
    description: 'Internal admin dashboard for support team',
    status: 'active',
    lastDeployed: '1 day ago',
    branch: 'main',
    techStack: ['React', 'Ant Design'],
    deploymentsCount: 31,
  },
]
// Deployment history for a specific project (used in Project Details > Deployments tab)
export const projectDeployments = [
  { id: 'dep_101', commitMsg: 'Fix memory leak in worker process', status: 'success', branch: 'main', author: 'Rahul S.', time: '2 mins ago', duration: '48s' },
  { id: 'dep_102', commitMsg: 'Add rate limiting middleware', status: 'success', branch: 'main', author: 'Priya K.', time: '3 hours ago', duration: '52s' },
  { id: 'dep_103', commitMsg: 'Update dependencies to latest', status: 'failed', branch: 'develop', author: 'Amit V.', time: '1 day ago', duration: '31s' },
  { id: 'dep_104', commitMsg: 'Refactor database connection pool', status: 'success', branch: 'main', author: 'Rahul S.', time: '2 days ago', duration: '61s' },
]

// Environment variables (used in Project Details > Environment tab)
// NOTE: values are masked - real values will come from a secure backend later
export const envVariables = [
  { key: 'DATABASE_URL', value: 'postgres://••••••••••••', updated: '5 days ago' },
  { key: 'JWT_SECRET', value: '••••••••••••••••', updated: '5 days ago' },
  { key: 'REDIS_HOST', value: 'redis://••••••••', updated: '2 weeks ago' },
  { key: 'NODE_ENV', value: 'production', updated: '2 weeks ago' },
]
// All deployments across all projects (used in Deployments page)
export const allDeployments = [
  { id: 'dep_201', project: 'auth-service', projectId: 'proj_1', commitMsg: 'Fix JWT token expiry bug', status: 'success', branch: 'main', author: 'Rahul S.', time: '2 mins ago', duration: '48s' },
  { id: 'dep_202', project: 'payment-gateway', projectId: 'proj_2', commitMsg: 'Add Stripe webhook handler', status: 'pending', branch: 'develop', author: 'Priya K.', time: '10 mins ago', duration: '—' },
  { id: 'dep_203', project: 'frontend-app', projectId: 'proj_3', commitMsg: 'Update dashboard UI components', status: 'success', branch: 'main', author: 'Amit V.', time: '25 mins ago', duration: '55s' },
  { id: 'dep_204', project: 'notification-service', projectId: 'proj_4', commitMsg: 'Refactor email queue logic', status: 'failed', branch: 'staging', author: 'Rahul S.', time: '1 hour ago', duration: '22s' },
  { id: 'dep_205', project: 'analytics-engine', projectId: 'proj_5', commitMsg: 'Optimize Kafka consumer batching', status: 'success', branch: 'main', author: 'Priya K.', time: '3 hours ago', duration: '61s' },
  { id: 'dep_206', project: 'admin-panel', projectId: 'proj_6', commitMsg: 'Add user role management UI', status: 'success', branch: 'main', author: 'Amit V.', time: '5 hours ago', duration: '39s' },
  { id: 'dep_207', project: 'auth-service', projectId: 'proj_1', commitMsg: 'Update password hashing algorithm', status: 'failed', branch: 'develop', author: 'Rahul S.', time: '1 day ago', duration: '18s' },
  { id: 'dep_208', project: 'payment-gateway', projectId: 'proj_2', commitMsg: 'Fix currency conversion rounding', status: 'success', branch: 'main', author: 'Priya K.', time: '2 days ago', duration: '47s' },
]
// Detailed info for a single deployment (used in Deployment Details page)
// Key = deployment id, so we can look up any deployment by its ID
export const deploymentDetailsMap = {
  dep_201: {
    id: 'dep_201',
    project: 'auth-service',
    projectId: 'proj_1',
    commitMsg: 'Fix JWT token expiry bug',
    commitHash: 'a3f8e21',
    status: 'success',
    branch: 'main',
    author: 'Rahul S.',
    environment: 'Production',
    time: '2 mins ago',
    duration: '48s',
    startedAt: '10:42:03 AM',
  },
  dep_202: {
    id: 'dep_202',
    project: 'payment-gateway',
    projectId: 'proj_2',
    commitMsg: 'Add Stripe webhook handler',
    commitHash: 'f91c4d2',
    status: 'pending',
    branch: 'develop',
    author: 'Priya K.',
    environment: 'Staging',
    time: '10 mins ago',
    duration: '—',
    startedAt: '10:34:11 AM',
  },
  dep_204: {
    id: 'dep_204',
    project: 'notification-service',
    projectId: 'proj_4',
    commitMsg: 'Refactor email queue logic',
    commitHash: 'b72a9e4',
    status: 'failed',
    branch: 'staging',
    author: 'Rahul S.',
    environment: 'Staging',
    time: '1 hour ago',
    duration: '22s',
    startedAt: '9:44:52 AM',
  },
}

// Deployment pipeline stages (used for the Timeline component)
// Each deployment status maps to how far the timeline progressed
export const timelineStages = ['Queued', 'Building', 'Deploying', 'Live']

// Terminal-style build logs (used in the Log Viewer)
// In a real app these would stream live from a WebSocket/SSE connection
export const sampleLogs = [
  { type: 'info', text: '$ Cloning repository...' },
  { type: 'success', text: '✓ Repository cloned successfully' },
  { type: 'info', text: '$ Installing dependencies (npm ci)...' },
  { type: 'info', text: 'added 342 packages in 12.4s' },
  { type: 'success', text: '✓ Dependencies installed' },
  { type: 'info', text: '$ Running build script...' },
  { type: 'info', text: 'vite v5.4.0 building for production...' },
  { type: 'info', text: '✓ 128 modules transformed.' },
  { type: 'success', text: '✓ Build completed in 8.2s' },
  { type: 'info', text: '$ Uploading build artifacts...' },
  { type: 'success', text: '✓ Artifacts uploaded to CDN' },
  { type: 'info', text: '$ Starting health checks...' },
  { type: 'success', text: '✓ Health check passed (200 OK)' },
  { type: 'success', text: '✓ Deployment live at https://auth-service.deployflow.app' },
]
// Simulated live log stream entries - used in Logs page.
// In production this would come from a WebSocket/SSE connection to your backend.
export const liveLogPool = [
  { type: 'info', text: '[auth-service] Incoming request GET /api/users/42' },
  { type: 'success', text: '[auth-service] Request completed in 84ms (200 OK)' },
  { type: 'info', text: '[payment-gateway] Processing webhook event: charge.succeeded' },
  { type: 'success', text: '[payment-gateway] Webhook processed successfully' },
  { type: 'info', text: '[frontend-app] Static asset cache invalidated' },
  { type: 'error', text: '[notification-service] Failed to connect to SMTP server' },
  { type: 'info', text: '[analytics-engine] Kafka consumer lag: 12ms' },
  { type: 'success', text: '[admin-panel] User session refreshed' },
  { type: 'info', text: '[auth-service] JWT token issued for user_id=1042' },
  { type: 'error', text: '[payment-gateway] Rate limit exceeded for client 192.168.1.4' },
  { type: 'success', text: '[frontend-app] Health check passed (200 OK)' },
  { type: 'info', text: '[analytics-engine] Flushed 1,204 events to ClickHouse' },
]

// Project name list for the Logs page filter dropdown
export const logProjectOptions = [
  'auth-service',
  'payment-gateway',
  'frontend-app',
  'notification-service',
  'analytics-engine',
  'admin-panel',
]
// Initial CPU/Memory usage data points (time-series, used in Monitoring charts)
// Each point represents one time interval - new points get appended live
export const initialMetrics = [
  { time: '10:00', cpu: 32, memory: 45 },
  { time: '10:05', cpu: 38, memory: 48 },
  { time: '10:10', cpu: 45, memory: 52 },
  { time: '10:15', cpu: 41, memory: 50 },
  { time: '10:20', cpu: 55, memory: 58 },
  { time: '10:25', cpu: 48, memory: 55 },
  { time: '10:30', cpu: 62, memory: 63 },
]

// Kubernetes-style pod status list (used in Monitoring > Pod Status grid)
export const pods = [
  { id: 'pod_1', name: 'auth-service-7d9f8', status: 'running', cpu: '120m', memory: '256Mi', restarts: 0, node: 'node-01' },
  { id: 'pod_2', name: 'auth-service-7d9f9', status: 'running', cpu: '98m', memory: '240Mi', restarts: 0, node: 'node-01' },
  { id: 'pod_3', name: 'payment-gateway-4a2c1', status: 'running', cpu: '210m', memory: '412Mi', restarts: 1, node: 'node-02' },
  { id: 'pod_4', name: 'frontend-app-9x7k2', status: 'running', cpu: '65m', memory: '180Mi', restarts: 0, node: 'node-01' },
  { id: 'pod_5', name: 'notification-service-2p1q3', status: 'crashloop', cpu: '15m', memory: '95Mi', restarts: 7, node: 'node-03' },
  { id: 'pod_6', name: 'analytics-engine-6r4t8', status: 'pending', cpu: '—', memory: '—', restarts: 0, node: 'node-02' },
]
// Default notification preferences (used in Settings > Notifications tab)
export const defaultNotificationSettings = [
  { key: 'deploySuccess', label: 'Deployment Success', description: 'Get notified when a deployment succeeds', enabled: true },
  { key: 'deployFailed', label: 'Deployment Failure', description: 'Get notified when a deployment fails', enabled: true },
  { key: 'podCrash', label: 'Pod Crash Alerts', description: 'Alert when a pod enters crash-loop state', enabled: true },
  { key: 'weeklyReport', label: 'Weekly Summary', description: 'Receive a weekly usage/performance report', enabled: false },
]

// API keys (used in Settings > API Keys tab)
export const apiKeys = [
  { id: 'key_1', name: 'Production CI/CD', maskedKey: 'df_live_••••••••wX2q', created: '3 months ago', lastUsed: '2 mins ago' },
  { id: 'key_2', name: 'Staging Pipeline', maskedKey: 'df_test_••••••••pL9r', created: '1 month ago', lastUsed: '1 hour ago' },
]