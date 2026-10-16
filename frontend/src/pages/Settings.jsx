import { useState } from 'react'
import { User, Bell, Key, AlertTriangle, Copy, Trash2, Plus } from 'lucide-react'
import Card from '../components/Card'
import Button from '../components/Button'
import Tabs from '../components/Tabs'
import ToggleSwitch from '../components/ToggleSwitch'
import { defaultNotificationSettings, apiKeys } from '../utils/mockData'

function Settings() {
  const tabs = [
    { key: 'profile', label: 'Profile' },
    { key: 'notifications', label: 'Notifications' },
    { key: 'apikeys', label: 'API Keys' },
    { key: 'danger', label: 'Danger Zone' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-text-secondary text-sm mt-1">
          Manage your account, notifications, and API access
        </p>
      </div>

      <Tabs tabs={tabs} defaultTab="profile">
        {(activeTab) => (
          <>
            {activeTab === 'profile' && <ProfileTab />}
            {activeTab === 'notifications' && <NotificationsTab />}
            {activeTab === 'apikeys' && <ApiKeysTab />}
            {activeTab === 'danger' && <DangerZoneTab />}
          </>
        )}
      </Tabs>
    </div>
  )
}

/* ============================================
   PROFILE TAB
   ============================================ */
function ProfileTab() {
  const [name, setName] = useState('Dev User')
  const [email, setEmail] = useState('dev@deployflow.app')

  return (
    <Card className="max-w-xl">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-16 h-16 rounded-full bg-gradient-to-br from-brand-primary to-brand-secondary flex items-center justify-center">
          <User size={28} className="text-white" />
        </div>
        <div>
          <Button variant="secondary" size="sm">Change Avatar</Button>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-sm text-text-secondary mb-1.5 block">Full Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 text-sm outline-none focus:border-brand-primary transition-colors"
          />
        </div>
        <div>
          <label className="text-sm text-text-secondary mb-1.5 block">Email Address</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-bg-hover border border-border-subtle rounded-lg px-3 py-2.5 text-sm outline-none focus:border-brand-primary transition-colors"
          />
        </div>
        <Button variant="primary">Save Changes</Button>
      </div>
    </Card>
  )
}

/* ============================================
   NOTIFICATIONS TAB
   ============================================ */
function NotificationsTab() {
  // Local state holds the list of settings, so toggling updates the UI
  const [settings, setSettings] = useState(defaultNotificationSettings)

  const toggleSetting = (key) => {
    setSettings((prev) =>
      prev.map((item) =>
        item.key === key ? { ...item, enabled: !item.enabled } : item
      )
    )
  }

  return (
    <Card className="max-w-xl">
      <h3 className="font-semibold mb-4">Notification Preferences</h3>
      <div className="space-y-1">
        {settings.map((item) => (
          <div
            key={item.key}
            className="flex items-center justify-between py-3 border-b border-border-subtle last:border-0"
          >
            <div>
              <p className="text-sm font-medium">{item.label}</p>
              <p className="text-text-tertiary text-xs mt-0.5">{item.description}</p>
            </div>
            <ToggleSwitch
              checked={item.enabled}
              onChange={() => toggleSetting(item.key)}
            />
          </div>
        ))}
      </div>
    </Card>
  )
}

/* ============================================
   API KEYS TAB
   ============================================ */
function ApiKeysTab() {
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">API Keys</h3>
        <Button variant="primary" size="sm" icon={Plus}>Generate New Key</Button>
      </div>

      <div className="space-y-2">
        {apiKeys.map((key) => (
          <div
            key={key.id}
            className="flex items-center justify-between bg-bg-hover border border-border-subtle rounded-lg px-4 py-3"
          >
            <div>
              <p className="text-sm font-medium">{key.name}</p>
              <p className="text-xs font-mono text-text-tertiary mt-0.5">{key.maskedKey}</p>
              <p className="text-xs text-text-tertiary mt-1">
                Created {key.created} • Last used {key.lastUsed}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button className="p-2 rounded-md hover:bg-bg-card text-text-tertiary hover:text-text-primary transition-colors">
                <Copy size={14} />
              </button>
              <button className="p-2 rounded-md hover:bg-status-failed/10 text-text-tertiary hover:text-status-failed transition-colors">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/* ============================================
   DANGER ZONE TAB
   ============================================ */
function DangerZoneTab() {
  return (
    <Card className="max-w-xl border-status-failed/30">
      <div className="flex items-center gap-2 mb-4">
        <AlertTriangle size={18} className="text-status-failed" />
        <h3 className="font-semibold text-status-failed">Danger Zone</h3>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between py-3 border-b border-border-subtle">
          <div>
            <p className="text-sm font-medium">Export Account Data</p>
            <p className="text-text-tertiary text-xs mt-0.5">
              Download all your projects and deployment history
            </p>
          </div>
          <Button variant="secondary" size="sm">Export</Button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Delete Account</p>
            <p className="text-text-tertiary text-xs mt-0.5">
              Permanently delete your account and all associated data
            </p>
          </div>
          <Button variant="danger" size="sm">Delete Account</Button>
        </div>
      </div>
    </Card>
  )
}

export default Settings