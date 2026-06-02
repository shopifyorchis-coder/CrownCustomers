import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import '@shopify/polaris/build/esm/styles.css';
import {
  AppProvider,
  Frame,
  Navigation,
  Page,
  Card,
  Text,
  Button,
  TextField,
  Select,
  BlockStack,
  InlineStack,
  Badge,
  DataTable,
  Banner,
  EmptyState,
  Divider
} from '@shopify/polaris';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    const res = await fetch(`${API}/api/dashboard`);
    setData(await res.json());
  }

  async function syncDemo() {
    setLoading(true);
    await fetch(`${API}/api/sync-demo`, {method: 'POST'});
    await load();
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const rows = (data?.customers || []).map(c => [c.name, c.email, `$${c.totalSpent}`, c.ordersCount, c.rfmScore, c.isTop ? 'Top customer' : 'Regular']);

  return (
    <Page title="Welcome to CrownCustomers">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text variant="headingMd">What does CrownCustomers do?</Text>
            <Text as="p">CrownCustomers identifies your best customers using RFM-style scoring and helps you reward them with a personal coupon email.</Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Step 1 · Sync store</Text>
            <Text as="p">Import customers and orders. This demo button creates sample customers so you can test the app quickly.</Text>
            <Button variant="primary" loading={loading} onClick={syncDemo}>Start demo sync</Button>
          </BlockStack>
        </Card>

        <InlineStack gap="400" wrap={false}>
          <Card><Text variant="headingMd">Customers</Text><Text variant="heading2xl">{data?.stats?.totalCustomers || 0}</Text></Card>
          <Card><Text variant="headingMd">Crown customers</Text><Text variant="heading2xl">{data?.stats?.topCustomers || 0}</Text></Card>
          <Card><Text variant="headingMd">Activity logs</Text><Text variant="heading2xl">{data?.stats?.emailsSent || 0}</Text></Card>
        </InlineStack>

        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Customer ranking</Text>
            {rows.length ? <DataTable columnContentTypes={['text','text','text','numeric','numeric','text']} headings={['Name','Email','Spent','Orders','Score','Status']} rows={rows} /> : <EmptyState heading="No customers yet" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"><p>Click Start demo sync first.</p></EmptyState>}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

function Activity() {
  const [logs, setLogs] = useState([]);
  useEffect(() => { fetch(`${API}/api/activity`).then(r => r.json()).then(setLogs); }, []);
  const rows = logs.map(l => [new Date(l.createdAt).toLocaleString(), l.status, l.customer, l.message]);
  return <Page title="Activity"><Card>{rows.length ? <DataTable columnContentTypes={['text','text','text','text']} headings={['Date','Status','Customer','Message']} rows={rows} /> : <Banner tone="info">No activity yet. Sync demo customers first.</Banner>}</Card></Page>;
}

function Settings() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { fetch(`${API}/api/settings`).then(r => r.json()).then(setS); }, []);
  if (!s) return <Page title="Settings"><Card>Loading...</Card></Page>;
  async function save() {
    const res = await fetch(`${API}/api/settings`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(s) });
    setS(await res.json());
    setSaved(true);
  }
  return (
    <Page title="Settings">
      <BlockStack gap="400">
        {saved && <Banner tone="success">Settings saved.</Banner>}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Status</Text>
            <Button pressed={s.enabled} onClick={() => setS({...s, enabled: !s.enabled})}>{s.enabled ? 'CrownCustomers enabled' : 'CrownCustomers disabled'}</Button>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Discount</Text>
            <TextField label="Discount value" type="number" value={String(s.discountValue)} onChange={v => setS({...s, discountValue: Number(v)})} />
            <Select label="Type" options={[{label:'Percentage (%)', value:'percentage'}, {label:'Fixed amount', value:'fixed'}]} value={s.discountType} onChange={v => setS({...s, discountType:v})} />
            <TextField label="Coupon duration (days)" type="number" value={String(s.couponDays)} onChange={v => setS({...s, couponDays: Number(v)})} />
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd">Email</Text>
            <TextField label="Email subject" value={s.emailSubject} onChange={v => setS({...s, emailSubject:v})} />
            <TextField label="Intro text" value={s.introText} multiline={3} onChange={v => setS({...s, introText:v})} />
            <TextField label="Cooldown days" type="number" value={String(s.cooldownDays)} onChange={v => setS({...s, cooldownDays: Number(v)})} />
            <Button variant="primary" onClick={save}>Save changes</Button>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

function Plan() {
  return (
    <Page title="Plan">
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between"><Text variant="headingMd">Free</Text><Badge>Your current plan</Badge></InlineStack>
            <Text>$0/month</Text><Divider />
            <Text>· Up to 250 customers</Text><Text>· Automatic crown customer detection</Text><Text>· Up to 50 reward emails per month</Text>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="200">
            <Text variant="headingMd">Pro</Text><Text>$15/month</Text><Divider />
            <Text>· Up to 5,000 customers</Text><Text>· Unlimited emails</Text><Text>· Email subject and intro customization</Text><Text>· Priority email support</Text>
            <Text fontWeight="bold">7 free trial days · no charge during trial · cancel anytime.</Text>
            <Button variant="primary">Start 7-day trial</Button>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

function App() {
  const [page, setPage] = useState('dashboard');
  const nav = <Navigation location="/"><Navigation.Section items={[
    {label:'Dashboard', selected:page==='dashboard', onClick:()=>setPage('dashboard')},
    {label:'Activity', selected:page==='activity', onClick:()=>setPage('activity')},
    {label:'Settings', selected:page==='settings', onClick:()=>setPage('settings')},
    {label:'Plan', selected:page==='plan', onClick:()=>setPage('plan')}
  ]}/></Navigation>;
  return <AppProvider i18n={{}}><Frame navigation={nav}>{page === 'dashboard' && <Dashboard />}{page === 'activity' && <Activity />}{page === 'settings' && <Settings />}{page === 'plan' && <Plan />}</Frame></AppProvider>;
}

createRoot(document.getElementById('root')).render(<App />);
