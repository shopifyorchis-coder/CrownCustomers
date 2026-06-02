import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_BASE =
  import.meta.env.VITE_API_URL || 'https://crowncustomers-production.up.railway.app';
const SHOP =
  new URLSearchParams(window.location.search).get('shop') ||
  import.meta.env.VITE_SHOPIFY_SHOP_DOMAIN ||
  '';

const NAV_ITEMS = [
  { key: 'overview', label: 'Overview', section: 'MAIN', icon: 'grid' },
  { key: 'activity', label: 'Activity', section: 'MAIN', icon: 'pulse' },
  { key: 'settings', label: 'Settings', section: 'CONFIG', icon: 'gear' },
  { key: 'plan', label: 'Plan', section: 'CONFIG', icon: 'star' }
];

const SETTINGS_SECTIONS = [
  { key: 'status', label: 'Status' },
  { key: 'discount', label: 'Discount' },
  { key: 'email', label: 'Email' },
  { key: 'cooldown', label: 'Cooldown' }
];

async function getJson(path, options) {
  const requestOptions = {
    ...options,
    headers: {
      ...(SHOP ? { 'X-Shopify-Shop-Domain': SHOP } : {}),
      ...(options?.headers || {})
    }
  };
  const response = await fetch(`${API_BASE}${path}`, requestOptions);
  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function Pill({ children, tone = 'default' }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function formatCurrency(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  });
}

function AppShell({ page, setPage, enabled, children }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">C</div>
          <div>
            <div className="brand-name">CrownCustomers</div>
            <Pill tone="gold">RFM POWERED</Pill>
          </div>
        </div>

        <nav className="sidebar-nav">
          {['MAIN', 'CONFIG'].map((section) => (
            <div className="nav-group" key={section}>
              <div className="nav-label">{section}</div>
              {NAV_ITEMS.filter((item) => item.section === section).map((item) => (
                <button
                  key={item.key}
                  className={`nav-item ${page === item.key ? 'active' : ''}`}
                  onClick={() => setPage(item.key)}
                >
                  <span className="nav-copy">
                    <span className={`nav-icon nav-icon-${item.icon}`} aria-hidden="true" />
                    <span>{item.label}</span>
                  </span>
                  {page === item.key && <span className="nav-dot" />}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="profile-card">
          <div className="profile-avatar">CC</div>
          <div>
            <div className="profile-name">crowncustomers</div>
            <div className="profile-plan">Free plan</div>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <h1>{NAV_ITEMS.find((item) => item.key === page)?.label || 'CrownCustomers'}</h1>
          <Pill tone={enabled ? 'success' : 'default'}>
            {enabled ? 'Enabled' : 'Disabled'}
          </Pill>
        </header>
        <div className="content-area">{children}</div>
      </main>
    </div>
  );
}

function OverviewPage({
  summary,
  ranking,
  syncError,
  syncMessage,
  onSync,
  syncing,
  manualForm,
  onManualChange,
  onManualSubmit,
  addingManual,
  onQuickDiscountSave,
  quickDiscount,
  setQuickDiscount
}) {
  const stats = summary || {};
  const customers = ranking || [];

  return (
    <div className="page-stack">
      <section className="hero-block">
        <h2>
          Reward your <span>crown customers</span>
          <br />
          automatically
        </h2>
        <p>
          CrownCustomers uses RFM scoring to identify your most valuable customers and
          sends them personalized discount offers automatically.
        </p>
      </section>

      {syncError && (
        <section className="panel error-panel">
          <strong>Sync failed</strong>
          <p>{syncError}</p>
        </section>
      )}

      {!syncError && syncMessage && (
        <section className="panel info-panel">
          <strong>Sync update</strong>
          <p>{syncMessage}</p>
        </section>
      )}

      <section className="panel panel-lg">
        <div className="panel-head">
          <div>
            <h3>How RFM works</h3>
            <p>Three signals that identify your best customers</p>
          </div>
          <Pill>Calculated weekly</Pill>
        </div>
        <div className="rfm-grid">
          <div className="rfm-card">
            <div className="rfm-letter gold">R</div>
            <strong>Recency</strong>
            <span>How recently did they buy?</span>
          </div>
          <div className="rfm-card">
            <div className="rfm-letter blue">F</div>
            <strong>Frequency</strong>
            <span>How often do they buy?</span>
          </div>
          <div className="rfm-card">
            <div className="rfm-letter green">M</div>
            <strong>Monetary</strong>
            <span>How much do they spend?</span>
          </div>
        </div>
      </section>

      <section className="stats-grid">
        <div className="panel stat-card">
          <span>Total customers</span>
          <strong>{stats.totalCustomers || 0}</strong>
        </div>
        <div className="panel stat-card">
          <span>Crown customers</span>
          <strong>{stats.crownCustomers || 0}</strong>
        </div>
        <div className="panel stat-card">
          <span>Last sync</span>
          <strong>{stats.lastSyncAt ? new Date(stats.lastSyncAt).toLocaleDateString() : 'Never'}</strong>
        </div>
      </section>

      <section className="split-grid">
        <div className="panel action-panel">
          <Pill tone="gold">STEP 01</Pill>
          <h3>Sync your store</h3>
          <p>
            Import real Shopify orders and calculate customer scores.
          </p>
          <button className="primary-button" onClick={onSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Start sync'}
          </button>
        </div>

        <div className="panel action-panel">
          <Pill tone="gold">STEP 02</Pill>
          <h3>Configure discount</h3>
          <p>
            Choose the coupon value sent to newly identified crown customers. You can
            refine the full messaging later in Settings.
          </p>
          <div className="field-grid">
            <label>
              <span>Discount value</span>
              <input
                type="number"
                value={quickDiscount.discountValue}
                onChange={(event) =>
                  setQuickDiscount((current) => ({
                    ...current,
                    discountValue: Number(event.target.value || 0)
                  }))
                }
              />
            </label>
            <label>
              <span>Type</span>
              <select
                value={quickDiscount.discountType}
                onChange={(event) =>
                  setQuickDiscount((current) => ({
                    ...current,
                    discountType: event.target.value
                  }))
                }
              >
                <option value="percentage">Percentage (%)</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </label>
          </div>
          <button className="secondary-button" onClick={onQuickDiscountSave}>
            Save discount
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Add a customer manually</h3>
            <p>Create local test customers and see the ranking table update right away.</p>
          </div>
          <Pill tone="gold">UI TESTING</Pill>
        </div>
        <div className="field-grid field-grid-manual">
          <label>
            <span>Name</span>
            <input
              value={manualForm.name}
              onChange={(event) => onManualChange('name', event.target.value)}
              placeholder="Sarah Chen"
            />
          </label>
          <label>
            <span>Email</span>
            <input
              type="email"
              value={manualForm.email}
              onChange={(event) => onManualChange('email', event.target.value)}
              placeholder="sarah@example.com"
            />
          </label>
          <label>
            <span>Total spent</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={manualForm.totalSpent}
              onChange={(event) => onManualChange('totalSpent', event.target.value)}
              placeholder="750"
            />
          </label>
          <label>
            <span>Orders count</span>
            <input
              type="number"
              min="0"
              step="1"
              value={manualForm.ordersCount}
              onChange={(event) => onManualChange('ordersCount', event.target.value)}
              placeholder="5"
            />
          </label>
          <label className="field-span-2">
            <span>Last purchase date</span>
            <input
              type="date"
              value={manualForm.lastOrderDate}
              onChange={(event) => onManualChange('lastOrderDate', event.target.value)}
            />
          </label>
        </div>
        <button className="primary-button" onClick={onManualSubmit} disabled={addingManual}>
          {addingManual ? 'Adding customer...' : 'Add customer'}
        </button>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Customer ranking</h3>
            <p>Top customers based on current RFM scoring</p>
          </div>
        </div>
        {customers.length ? (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Spent</th>
                  <th>Orders</th>
                  <th>Last order</th>
                  <th>Score</th>
                  <th>Segment</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>{customer.name}</td>
                    <td>{customer.email}</td>
                    <td>{formatCurrency(customer.totalSpent)}</td>
                    <td>{customer.ordersCount}</td>
                    <td>{new Date(customer.lastOrderDate).toLocaleDateString()}</td>
                    <td>{customer.rfmScore}</td>
                    <td>
                      <Pill tone={customer.isTop ? 'gold' : 'default'}>
                        {customer.segment}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">C</div>
            <h3>No customers found yet</h3>
            <p>No customers found yet. Add customers manually or connect Shopify sync later.</p>
          </div>
        )}
      </section>

      <section className="panel note-panel">
        <strong>About CrownCustomers:</strong> CrownCustomers helps merchants identify loyal
        repeat buyers using recency, frequency, and monetary behavior, then reward them
        automatically.
      </section>
    </div>
  );
}

function ActivityPage({ logs }) {
  return (
    <div className="page-stack activity-page">
      <div className="page-row">
        <h2 className="section-title">Email Activity</h2>
        <select className="filter-select" defaultValue="all">
          <option value="all">All statuses</option>
          <option value="synced">Synced</option>
          <option value="settings_saved">Settings saved</option>
        </select>
      </div>

      <section className="panel panel-xl">
        {logs.length ? (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Customer</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td>{new Date(log.createdAt).toLocaleString()}</td>
                    <td>{log.status}</td>
                    <td>{log.customer}</td>
                    <td>{log.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-icon empty-icon-mail" />
            <h3>No activity yet</h3>
            <p>
              When a customer enters your crown segment for the first time, an automatic
              reward email will appear here.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsPage({ settings, setSettings, onSave }) {
  const [section, setSection] = useState('status');

  return (
    <div className="settings-layout">
      <div className="settings-tabs">
        {SETTINGS_SECTIONS.map((item) => (
          <button
            key={item.key}
            className={`settings-tab ${section === item.key ? 'active' : ''}`}
            onClick={() => setSection(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="page-stack">
        {section === 'status' && (
          <section className="panel">
            <h3>App status</h3>
            <p>
              When enabled, CrownCustomers sends a unique reward to each customer who enters
              your crown segment for the first time. When disabled, it still calculates RFM
              but does not send emails.
            </p>
            <button
              className={`toggle-card ${settings.enabled ? 'on' : ''}`}
              onClick={() => setSettings((current) => ({ ...current, enabled: !current.enabled }))}
            >
              <span className="toggle-switch">
                <span className="toggle-knob" />
              </span>
              <strong>{settings.enabled ? 'CrownCustomers enabled' : 'CrownCustomers disabled'}</strong>
            </button>
          </section>
        )}

        {section === 'discount' && (
          <section className="panel">
            <h3>Discount settings</h3>
            <div className="field-grid">
              <label>
                <span>Discount value</span>
                <input
                  type="number"
                  value={settings.discountValue}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      discountValue: Number(event.target.value || 0)
                    }))
                  }
                />
              </label>
              <label>
                <span>Type</span>
                <select
                  value={settings.discountType}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      discountType: event.target.value
                    }))
                  }
                >
                  <option value="percentage">Percentage (%)</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </label>
            </div>
            <label>
              <span>Coupon duration (days)</span>
              <input
                type="number"
                value={settings.couponDays}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    couponDays: Number(event.target.value || 0)
                  }))
                }
              />
            </label>
          </section>
        )}

        {section === 'email' && (
          <section className="panel">
            <h3>Email content</h3>
            <label>
              <span>Email subject</span>
              <input
                value={settings.emailSubject}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    emailSubject: event.target.value
                  }))
                }
              />
            </label>
            <label>
              <span>Intro text</span>
              <textarea
                rows="5"
                value={settings.introText}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    introText: event.target.value
                  }))
                }
              />
            </label>
          </section>
        )}

        {section === 'cooldown' && (
          <section className="panel">
            <h3>Cooldown</h3>
            <p>Control how often the same customer can receive a reward.</p>
            <label>
              <span>Cooldown days</span>
              <input
                type="number"
                value={settings.cooldownDays}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    cooldownDays: Number(event.target.value || 0)
                  }))
                }
              />
            </label>
          </section>
        )}

        <button className="primary-button save-button" onClick={onSave}>
          Save changes
        </button>
      </div>
    </div>
  );
}

function PlanPage() {
  return (
    <div className="page-stack plan-page">
      <section className="hero-block compact">
        <h2>Choose your plan</h2>
        <p>Scale with your store. Upgrade or cancel anytime.</p>
      </section>

      <section className="pricing-grid">
        <div className="panel pricing-card">
          <h3>Free</h3>
          <div className="price-row">
            <strong>$0</strong>
            <span>/ month</span>
          </div>
          <ul>
            <li>Up to 250 customers</li>
            <li>Automatic crown customer detection</li>
            <li>Up to 50 reward emails per month</li>
          </ul>
          <button className="ghost-button" disabled>
            Your current plan
          </button>
        </div>

        <div className="panel pricing-card featured">
          <Pill tone="gold">7-DAY FREE TRIAL</Pill>
          <h3>Pro</h3>
          <div className="price-row">
            <strong>$15</strong>
            <span>/ month</span>
          </div>
          <ul>
            <li>Up to 5,000 customers</li>
            <li>Unlimited emails</li>
            <li>Email subject and intro customization</li>
            <li>Priority email support</li>
            <li>Early access to upcoming features</li>
          </ul>
          <p className="subtle-copy">No charge during trial. Cancel anytime.</p>
          <button className="primary-button">Start 7-day trial</button>
        </div>
      </section>

      <section className="panel note-panel">
        <strong>About the Free plan limit:</strong> If your store exceeds 250 customers,
        CrownCustomers pauses new reward sends automatically, while still keeping RFM
        scoring active. When you upgrade, sends resume without losing data.
      </section>
    </div>
  );
}

function App() {
  const [page, setPage] = useState('overview');
  const [summary, setSummary] = useState(null);
  const [ranking, setRanking] = useState([]);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addingManual, setAddingManual] = useState(false);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [manualForm, setManualForm] = useState({
    name: '',
    email: '',
    totalSpent: '750',
    ordersCount: '4',
    lastOrderDate: new Date().toISOString().slice(0, 10)
  });

  async function loadSummary() {
    const data = await getJson('/api/dashboard/summary');
    setSummary(data);
  }

  async function loadRanking() {
    const data = await getJson('/api/customers/ranking');
    setRanking(data);
  }

  async function loadLogs() {
    const data = await getJson('/api/activity');
    setLogs(data);
  }

  async function loadSettings() {
    const data = await getJson('/api/settings');
    setSettings(data);
  }

  async function refreshAll() {
    await getJson('/api/health');
    await Promise.all([loadSummary(), loadRanking(), loadLogs(), loadSettings()]);
    setError('');
  }

  useEffect(() => {
    refreshAll().catch((err) => {
      console.error('CrownCustomers startup failed:', err);
      setError(err.message || 'Unable to load CrownCustomers right now.');
    });
  }, []);

  async function handleSync() {
    setSyncing(true);
    setSyncError('');
    setSyncMessage('');
    try {
      const result = await getJson('/api/sync/shopify-orders', { method: 'POST' });
      await refreshAll();
      setSyncMessage(
        result.message ||
          `Loaded ${result.customersImported || 0} customers into CrownCustomers.`
      );
    } catch (err) {
      setSyncError(err.message || 'Shopify sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  async function handleManualSubmit() {
    setAddingManual(true);
    setSyncError('');
    setSyncMessage('');
    try {
      const payload = {
        ...manualForm,
        totalSpent: Number(manualForm.totalSpent || 0),
        ordersCount: Number(manualForm.ordersCount || 0)
      };
      await getJson('/api/customers/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      await refreshAll();
      setSyncMessage(`Added ${payload.name || 'customer'} to the ranking table.`);
      setManualForm((current) => ({
        ...current,
        name: '',
        email: ''
      }));
    } catch (err) {
      setSyncError(err.message || 'Unable to add customer right now.');
    } finally {
      setAddingManual(false);
    }
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await getJson('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      setSettings(updated);
      await refreshAll();
    } finally {
      setSaving(false);
    }
  }

  const quickDiscount = useMemo(
    () => ({
      discountValue: settings?.discountValue ?? 15,
      discountType: settings?.discountType ?? 'percentage'
    }),
    [settings]
  );

  if (!settings) {
    return (
      <div className="loading-screen">
        <div className="loading-card">
          <div>Loading CrownCustomers...</div>
          {error && (
            <>
              <p className="loading-error">{error}</p>
              <button className="primary-button" onClick={() => {
                setError('');
                refreshAll().catch((err) => {
                  console.error('CrownCustomers retry failed:', err);
                  setError(err.message || 'Unable to load CrownCustomers right now.');
                });
              }}>
                Retry
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <AppShell page={page} setPage={setPage} enabled={settings.enabled}>
      {page === 'overview' && (
        <OverviewPage
          summary={summary}
          ranking={ranking}
          syncError={syncError}
          syncMessage={syncMessage}
          syncing={syncing}
          onSync={handleSync}
          manualForm={manualForm}
          onManualChange={(field, value) =>
            setManualForm((current) => ({
              ...current,
              [field]: value
            }))
          }
          onManualSubmit={handleManualSubmit}
          addingManual={addingManual}
          quickDiscount={quickDiscount}
          setQuickDiscount={(updater) =>
            setSettings((current) => {
              const nextDiscount =
                typeof updater === 'function' ? updater(quickDiscount) : updater;
              return {
                ...current,
                discountValue: nextDiscount.discountValue,
                discountType: nextDiscount.discountType
              };
            })
          }
          onQuickDiscountSave={handleSave}
        />
      )}
      {page === 'activity' && <ActivityPage logs={logs} />}
      {page === 'settings' && (
        <SettingsPage
          settings={settings}
          setSettings={setSettings}
          onSave={handleSave}
        />
      )}
      {page === 'plan' && <PlanPage />}
      {saving && <div className="save-toast">Saving changes...</div>}
    </AppShell>
  );
}

createRoot(document.getElementById('root')).render(<App />);
